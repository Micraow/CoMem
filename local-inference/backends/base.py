"""嵌入与重排的共享类型。

`server.py` 与 `backends/openvino.py` 都 import 这里的定义，两处各写一份会让
「截断后必须重新归一化」这类不变量分裂成两份实现。

**没有 Protocol / ABC。** 后端只有一个（OpenVINO），为单个实现建一层接口是投机
抽象（AGENTS.md §6）。等真的出现第二个后端时再抽。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Sequence

#: 设备名。三个取值是真实差异：OpenVINO 的 `CPU` / `GPU` / `NPU` 插件各是一份
#: 独立的编译产物，能力与错误信息都不同。
Device = Literal["cpu", "gpu", "npu"]

DEVICES: tuple[Device, ...] = ("cpu", "gpu", "npu")


class BackendUnavailableError(RuntimeError):
    """启动期错误：这个设备在本机跑不了。

    继承 `RuntimeError` 而不是自定义基类：调用方只有「退出码 2 + 一句原因」这一种
    处置方式，不需要按类型分支。
    """


class InferenceError(RuntimeError):
    """单次推理失败（请求级，返回 500）。"""


@dataclass(frozen=True)
class EmbeddingBatch:
    """一次批量嵌入的结果。

    `vectors` 与输入 `texts` 按下标一一对应。`prompt_tokens` 是**截断后**实际送进
    模型的 token 数（OpenAI 的 `usage.prompt_tokens` 语义）。`truncated` 是被截断
    的输入下标，`server.py` 用它记一条 warn。
    """

    vectors: list[list[float]]
    prompt_tokens: int
    truncated: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class RerankBatch:
    """一次重排打分的结果。

    `scores` 与输入 `documents` 按下标一一对应，**未排序、未截断**——排序与
    `top_n` 是 HTTP 响应形状的一部分，放在 `server.py`。空文档的分数是 `None`
    （模型侧没有可打分的语义，与 `domain/rerank.ts` 的 `applyRerank` 对齐）。
    """

    scores: list[float | None]
    prompt_tokens: int
    truncated: list[int] = field(default_factory=list)


def l2_normalize(vector: Sequence[float]) -> list[float]:
    """归一化到单位长度。

    全零向量原样返回：它没有方向，除以模长会得到 `NaN`，而 `NaN` 会让余弦距离
    的排序整体失去意义。

    归一化放在**响应写出之前**（`server.py`），不放在后端里：Matryoshka 截断会
    破坏单位长度，两处各归一化一次必然有一处忘了在截断后重算。
    """
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0 or not math.isfinite(norm):
        return list(vector)
    return [value / norm for value in vector]


def truncate_matryoshka(vector: Sequence[float], dimensions: int) -> list[float]:
    """Matryoshka 截断。

    Qwen3-Embedding 的表示按维度重要性排序，取前 N 维是训练时就有的用法（模型卡
    的 `dimensions` 参数），不需要额外的投影矩阵。**截断会破坏单位长度**，调用方
    必须接着做一次 `l2_normalize`。

    不做「自动挑最大可用维度」：请求 768 但模型只有 1024 维时静默返回 1024 维会让
    调用方的向量表长度与配置不一致，而这种不一致在余弦检索里表现为「查不出东西」。
    """
    if dimensions <= 0:
        raise ValueError(f"dimensions 必须是正整数，收到 {dimensions}")
    if dimensions > len(vector):
        raise ValueError(f"dimensions={dimensions} 超过模型原生维度 {len(vector)}")
    return list(vector[:dimensions])
