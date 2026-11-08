"""llama.cpp 后端（GGUF）。

单栈的原因是**分数语义**：Qwen3-Embedding 与 Qwen3-Reranker 共享同一份 tokenizer
与训练配方，同一个运行时算出来的分数才可比。混两个运行时（一个走 Vulkan、一个走
OpenVINO）会让「同一份数据在不同机器上排序不同」，而检索系统里这是不可复现的 bug。

设备矩阵：

| `--device` | 后端 | 说明 |
|---|---|---|
| `cpu` | ggml CPU + AVX-512 | 手写 SIMD 内核，最稳的一条 |
| `gpu` | ggml Vulkan | Intel Arc 核显；需要带 `-DGGML_VULKAN=ON` 的构建 |
| `npu` | — | **不支持**。llama.cpp 上游没有 Intel NPU 的 ggml backend，启动期直接报错 |

**Rerank 不是 CrossEncoder。** `Qwen3-Reranker-0.6B` 的架构是 `Qwen3ForCausalLM`，
llama.cpp 的转换器把 `lm_head` 里 `yes` / `no` 两行抽成分类头
（`cls.output.weight`），并写 `pooling_type=RANK` 与 `classifier.output_labels`。
所以它不是「问模型 yes 还是 no」，而是**池化层的两个 logit**。

**社区 GGUF 大多是坏的。** 用老转换器转出来的只有 310 个张量、缺 `cls.output.weight`，
`pooling_type` 也不是 RANK——这时 `llama_get_embeddings_seq` 仍然返回两个数，但它们
来自随机初始化或干脆是隐状态的头部，**分数看起来在合理范围、排序却是垃圾**。
`_validate_reranker` 在启动时校验元数据，不过就拒绝启动。
"""

from __future__ import annotations

import ctypes
import logging
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .base import (
    BackendUnavailableError,
    Device,
    EmbeddingBatch,
    InferenceError,
    RerankBatch,
)

LOGGER = logging.getLogger(__name__)

#: GGUF 文件头魔数。
GGUF_MAGIC = b"GGUF"

#: 正确的 reranker GGUF 张量数。来源：`ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`
#: 实测 311；坏转换器产出 310（少 `cls.output.weight`）。
RERANK_TENSOR_COUNT = 311

#: `LLAMA_POOLING_TYPE_LAST` / `RANK`。用字面量而不是 `llama_cpp` 的常量：常量在
#: 模块 import 时就要加载 libllama，而校验 GGUF 元数据不需要加载模型。
POOLING_LAST = 3
POOLING_RANK = 4

#: 元数据里出现的 `pooling_type` 键。转换器按模型 arch 加前缀（`qwen3.pooling_type`），
#: 这里按后缀匹配，避免换 arch 名时静默漏检。
POOLING_KEY_SUFFIX = ".pooling_type"

#: `llama_model_meta_val_str` 的缓冲区。Qwen3 的 chat template 约 4KB，8192 有量级余量。
_METADATA_BUFFER = 8192
_METADATA_KEY_BUFFER = 1024


@dataclass(frozen=True)
class GgufHeader:
    """GGUF 头。只解析前 24 字节——元数据用 llama.cpp 的 API 读。"""

    version: int
    tensor_count: int
    metadata_kv_count: int


def _read_gguf_header(path: Path) -> GgufHeader:
    """读 GGUF 文件头。

    自己解析而不是用 `gguf` 包：只需要 24 字节，而多一个依赖意味着多一个版本冲突
    点。字段布局是 GGUF 规范规定的（magic / version / n_tensors / n_kv），不会变。
    """
    try:
        with path.open("rb") as handle:
            magic = handle.read(4)
            if magic != GGUF_MAGIC:
                raise BackendUnavailableError(
                    f"{path} 不是 GGUF 文件（魔数 {magic!r}）。"
                )
            version, tensor_count, kv_count = struct.unpack("<IQQ", handle.read(20))
    except OSError as error:
        raise BackendUnavailableError(f"读不了 {path}：{error}") from error
    return GgufHeader(
        version=version, tensor_count=tensor_count, metadata_kv_count=kv_count
    )


def _read_metadata(llm: "object") -> dict[str, str]:
    """把模型的全部元数据读成 `dict[str, str]`。

    llama.cpp 把值统一渲染成字符串（数组是 `[a, b]` 这种形式），所以这里不需要
    区分标量 / 数组。
    """
    import llama_cpp

    model = llm.model  # type: ignore[attr-defined]
    count = llama_cpp.llama_model_meta_count(model)
    metadata: dict[str, str] = {}
    for index in range(count):
        key_buffer = ctypes.create_string_buffer(_METADATA_KEY_BUFFER)
        # 这两个 API 返回**写入的字节数**，不是 0 / -1。用 `!= 0` 判断会把每一条
        # 都当成失败跳过，得到一个空 dict——而空 dict 会让 rerank 校验报「缺元数据」，
        # 看起来像模型坏了。
        if (
            llama_cpp.llama_model_meta_key_by_index(
                model, index, key_buffer, _METADATA_KEY_BUFFER
            )
            < 0
        ):
            continue
        key = key_buffer.value.decode("utf-8", errors="replace")
        value_buffer = ctypes.create_string_buffer(_METADATA_BUFFER)
        if (
            llama_cpp.llama_model_meta_val_str(
                model, key.encode("utf-8"), value_buffer, _METADATA_BUFFER
            )
            < 0
        ):
            continue
        metadata[key] = value_buffer.value.decode("utf-8", errors="replace")
    return metadata


def _rerank_template(metadata: dict[str, str]) -> str | None:
    """取 GGUF 里的 rerank chat 模板。

    **用模型自己的模板，不硬编码。** 官方模板末尾有一个空的 `<think>\n\n</think>`
    ——少了它，模型会把它当成「思考模式」的开头，分数分布整体偏移。模板跟着 GGUF
    走，换模型（或换成带思考的版本）时不需要改代码。
    """
    for key, value in metadata.items():
        if key.endswith("chat_template.rerank"):
            return value
    return None


def _require_gguf(path: str, what: str) -> Path:
    resolved = Path(path)
    if not resolved.is_file():
        raise BackendUnavailableError(
            f"{what}模型文件不存在：{resolved}\n"
            "先按 README「安装」一节下载 GGUF（用 ModelScope 或 hf-mirror）。"
        )
    return resolved


def _require_device(device: Device) -> None:
    """设备矩阵的启动期校验。

    `npu` 明确拒绝：让它在 NPU 上「能启动但实际跑 CPU」会让用户以为 NPU 生效了，
    而 `/health` 报的 `device` 也是假的。
    """
    if device == "npu":
        raise BackendUnavailableError(
            "llama.cpp 没有 Intel NPU 后端：上游没有对应的 ggml backend，"
            "只有 OpenVINO 的 NPU 插件能驱动 Intel AI Boost。"
            "本服务只实现 llama.cpp，请改用 --device cpu 或 --device gpu。"
        )


def _validate_reranker(
    path: Path, header: GgufHeader, metadata: dict[str, str]
) -> None:
    """校验 GGUF 是真的 reranker 而不是坏转换器的产物。

    四条判据缺一不可，**任何一条不过都拒绝启动**：坏 GGUF 的症状是「服务正常、分数
    在 0 附近随机」，没有任何日志会提示它错了，而 CoMem 会把这份排序当成检索结果。
    """
    problems: list[str] = []

    if header.tensor_count != RERANK_TENSOR_COUNT:
        problems.append(
            f"tensor_count = {header.tensor_count}（期望 {RERANK_TENSOR_COUNT}）"
            "——缺 cls.output.weight，是坏转换器的产物"
        )

    pooling_key = next(
        (key for key in metadata if key.endswith(POOLING_KEY_SUFFIX)), None
    )
    if pooling_key is None:
        problems.append(f"缺少 *{POOLING_KEY_SUFFIX} 元数据（期望 RANK={POOLING_RANK}）")
    elif metadata[pooling_key].strip() != str(POOLING_RANK):
        problems.append(
            f"{pooling_key} = {metadata[pooling_key]!r}（期望 {POOLING_RANK} = RANK）"
        )

    # `classifier.output_labels` 是可选编码：官方 Q8_0 里没有这个键，分类头靠
    # `llama_model_n_cls_out()` 报告（构造时另外校验）。有的话顺带核对一下。
    labels_key = next(
        (key for key in metadata if key.endswith("classifier.output_labels")), None
    )
    if labels_key is not None:
        label_text = metadata[labels_key]
        if "yes" not in label_text or "no" not in label_text:
            problems.append(f"{labels_key} = {label_text!r}（期望包含 yes 与 no）")

    template = _rerank_template(metadata)
    if template is None:
        problems.append(
            "缺少 tokenizer.chat_template.rerank（llama.cpp 的 rerank 模板）"
        )
    elif "{query}" not in template or "{document}" not in template:
        problems.append("tokenizer.chat_template.rerank 里没有 {query} / {document} 占位符")

    if problems:
        raise BackendUnavailableError(
            f"{path.name} 不是可用的 Qwen3-Reranker GGUF：\n  - "
            + "\n  - ".join(problems)
            + "\n请改用 ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF "
            "（mradermacher 等社区仓的 Q8_0 是坏的）。"
        )


class _Tokenizer:
    """tokenize / detokenize / 按 token 截断的薄封装。

    两个模型共用：截断必须按 token 做（按字符切会把一个汉字劈成两半，模型侧得到
    U+FFFD）。`truncated` 由调用方用来记 warn。
    """

    def __init__(self, llm: "object", max_seq_len: int) -> None:
        self._llm = llm
        self._max_seq_len = max_seq_len

    def encode(self, text: str) -> list[int]:
        # Qwen 系列不用 BOS（`add_bos_token` 为 false），显式传 false 避免多加一个
        # 无效 token 改变 last-token 的位置。
        return self._llm.tokenize(  # type: ignore[attr-defined]
            text.encode("utf-8"), add_bos=False, special=True
        )

    def truncate(self, ids: list[int]) -> tuple[list[int], bool]:
        if len(ids) <= self._max_seq_len:
            return ids, False
        return ids[: self._max_seq_len], True

    def decode(self, ids: Sequence[int]) -> str:
        return self._llm.detokenize(list(ids)).decode(  # type: ignore[attr-defined]
            "utf-8", errors="ignore"
        )


class LlamaCppEmbedding:
    """GGUF 嵌入后端。"""

    backend: str = "llama-cpp"

    def __init__(
        self,
        *,
        model_path: str,
        model_id: str,
        device: Device,
        threads: int,
        max_seq_len: int,
        n_batch: int,
    ) -> None:
        _require_device(device)
        path = _require_gguf(model_path, "嵌入")

        import llama_cpp
        from llama_cpp import Llama

        if device == "gpu" and not llama_cpp.llama_supports_gpu_offload():
            raise BackendUnavailableError(
                "这个 llama-cpp-python 构建没有 GPU 后端。需要带 "
                "`CMAKE_ARGS='-DGGML_VULKAN=ON'` 重新编译（README「安装」有完整命令）。"
            )

        self.device: Device = device
        self.model = model_id
        self.threads = threads

        try:
            self._llm = Llama(
                model_path=str(path),
                # embedding=True 让 llama.cpp 只算池化向量，不跑 lm_head。
                embedding=True,
                n_ctx=max_seq_len,
                n_batch=min(n_batch, max_seq_len),
                n_threads=threads,
                # -1 = 全部层交给后端设备。Vulkan 下这是「整模型上核显」，0 是纯 CPU。
                n_gpu_layers=-1 if device == "gpu" else 0,
                # Qwen3-Embedding 用 **last-token** 池化。显式指定而不是依赖 GGUF
                # 元数据：换模型时静默退化成 mean pooling 会产出「看起来正常但语义
                # 错位」的向量，而这类错误没有任何断言能自动发现。
                pooling_type=llama_cpp.LLAMA_POOLING_TYPE_LAST,
                verbose=False,
                seed=0,
            )
        except Exception as error:  # noqa: BLE001 - 加载失败一律是启动期错误
            raise BackendUnavailableError(f"llama.cpp 加载嵌入模型失败：{error}") from error

        self._tokenizer = _Tokenizer(self._llm, max_seq_len)
        self.dimension = self._llm.n_embd()

        header = _read_gguf_header(path)
        metadata = _read_metadata(self._llm)
        pooling_key = next(
            (key for key in metadata if key.endswith(POOLING_KEY_SUFFIX)), None
        )
        if pooling_key is None or metadata[pooling_key].strip() != str(POOLING_LAST):
            # 只 warn 不拒绝：`pooling_type=` 已经显式指定，元数据不对不影响本次
            # 运行；但它是「这个 GGUF 不是官方产物」的线索。
            LOGGER.warning(
                "%s 的 %s 不是 LAST(%d)，当前 %s。已按 last-token 池化运行，"
                "但这说明 GGUF 可能不是官方转换产物。",
                path.name,
                pooling_key or "pooling_type",
                POOLING_LAST,
                metadata.get(pooling_key, "缺失") if pooling_key else "缺失",
            )
        LOGGER.info(
            "嵌入模型：%s（%d 张量，%d 维，%s）",
            path.name,
            header.tensor_count,
            self.dimension,
            device,
        )

    # ------------------------------------------------------------------ 推理

    def embed(self, texts: Sequence[str]) -> EmbeddingBatch:
        prepared: list[str] = []
        tokens = 0
        truncated: list[int] = []
        for index, text in enumerate(texts):
            ids, was_truncated = self._tokenizer.truncate(self._tokenizer.encode(text))
            if was_truncated:
                truncated.append(index)
            tokens += len(ids)
            # 截断后再 detokenize：直接按字符截会切坏多字节字符。
            prepared.append(self._tokenizer.decode(ids))

        try:
            result = self._llm.create_embedding(prepared)
        except Exception as error:  # noqa: BLE001 - 统一收敛成 InferenceError
            raise InferenceError(f"llama.cpp 嵌入失败：{error}") from error

        vectors = [list(item["embedding"]) for item in result["data"]]
        return EmbeddingBatch(vectors=vectors, prompt_tokens=tokens, truncated=truncated)

    def close(self) -> None:
        llm = getattr(self, "_llm", None)
        if llm is not None:
            llm.close()
            self._llm = None  # type: ignore[assignment]


class LlamaCppRerank:
    """GGUF 重排后端（RANK 池化的分类头）。

    **分数是 `P(yes)`，在 [0, 1]。** llama.cpp 的 RANK 池化在 `n_cls_out == 2` 时
    已经对分类头做了 softmax，`llama_get_embeddings_seq` 返回的就是两个概率
    （实测 `[0.987, 0.013]`，和为 1）。`/health` 的 `score_semantics` 报
    `probability`。

    **不要用 `Llama.embed()` 取这个值**：它按 `n_embd()`（hidden size，1024）切片，
    而这里只有 2 个 float，切出来是越界读到的垃圾。
    """

    backend: str = "llama-cpp"
    #: 分类头 softmax 后 `P(yes)`
    score_semantics: str = "probability"

    def __init__(
        self,
        *,
        model_path: str,
        model_id: str,
        device: Device,
        threads: int,
        max_seq_len: int,
        n_batch: int,
    ) -> None:
        _require_device(device)
        path = _require_gguf(model_path, "重排")

        import llama_cpp
        from llama_cpp import Llama

        if device == "gpu" and not llama_cpp.llama_supports_gpu_offload():
            raise BackendUnavailableError(
                "这个 llama-cpp-python 构建没有 GPU 后端，无法把重排模型放上核显。"
            )

        self.device: Device = device
        self.model = model_id
        self.threads = threads
        self._max_seq_len = max_seq_len

        try:
            self._llm = Llama(
                model_path=str(path),
                # 分类头只在前向里产生，不需要 lm_head；embedding=True 才让
                # llama.cpp 分配池化输出。
                embedding=True,
                n_ctx=max_seq_len,
                n_batch=min(n_batch, max_seq_len),
                n_threads=threads,
                n_gpu_layers=-1 if device == "gpu" else 0,
                pooling_type=llama_cpp.LLAMA_POOLING_TYPE_RANK,
                verbose=False,
                seed=0,
            )
        except Exception as error:  # noqa: BLE001 - 启动期错误
            raise BackendUnavailableError(f"llama.cpp 加载重排模型失败：{error}") from error

        header = _read_gguf_header(path)
        metadata = _read_metadata(self._llm)
        _validate_reranker(path, header, metadata)

        self._tokenizer = _Tokenizer(self._llm, max_seq_len)
        template = _rerank_template(metadata)
        if template is None:  # pragma: no cover - _validate_reranker 已经挡过
            raise BackendUnavailableError("rerank 模板缺失")
        self._template = template
        # 分类头输出个数（yes / no 两个 logit）。用它而不是 `n_embd()`：后者是
        # hidden size（1024），按它切片会读到数组边界之外。
        self._n_cls = llama_cpp.llama_model_n_cls_out(self._llm.model)
        if self._n_cls != 2:
            raise BackendUnavailableError(
                f"重排模型的分类头有 {self._n_cls} 个输出，期望 2（yes / no）。"
            )
        LOGGER.info(
            "重排模型：%s（%d 张量，RANK 池化，%s）",
            path.name,
            header.tensor_count,
            device,
        )

    # ------------------------------------------------------------------ 推理

    def score(self, query: str, documents: Sequence[str]) -> RerankBatch:
        scores: list[float | None] = []
        tokens = 0
        truncated: list[int] = []

        for index, document in enumerate(documents):
            if document.strip() == "":
                # 空串在模型侧没有可打分的语义：发过去只会换来一个来自 prompt
                # 尾巴的分数。`None` 让调用方用兜底分。
                scores.append(None)
                continue
            ids, was_truncated = self._tokenizer.truncate(
                self._tokenizer.encode(self._format(query, document))
            )
            if was_truncated:
                truncated.append(index)
            tokens += len(ids)
            scores.append(self._yes_probability(ids))

        return RerankBatch(scores=scores, prompt_tokens=tokens, truncated=truncated)

    def close(self) -> None:
        llm = getattr(self, "_llm", None)
        if llm is not None:
            llm.close()
            self._llm = None  # type: ignore[assignment]

    # ------------------------------------------------------------------ 内部

    def _format(self, query: str, document: str) -> str:
        """按 GGUF 里的 rerank 模板拼 prompt。

        用 `str.replace` 而不是 `str.format`：模板里的 `{query}` 是字面占位符，
        而 `format` 会把任何其它花括号当格式说明符（Jinja 模板里很常见），遇到就
        抛 `KeyError`。
        """
        return self._template.replace("{query}", query).replace("{document}", document)

    def _yes_probability(self, ids: list[int]) -> float:
        """跑一次 decode，取池化层的 `P(yes)`。

        两个输出是 `[P(yes), P(no)]`（softmax 过，和为 1）。取第一个而不是差值：
        差值是 `2P-1`，把「明确不相关」（0.00005）压成 -0.9999，与「完全不相关」的
        区分度反而变小。
        """
        import llama_cpp
        from llama_cpp._internals import LlamaBatch

        batch = LlamaBatch(n_tokens=len(ids), embd=0, n_seq_max=1)
        try:
            # 每个 token 都标记为输出：llama.cpp 在 embedding 模式下会检查
            # 「有没有 token 没被标记」，不标记会打一条 warning 并覆盖。
            batch.add_sequence(ids, 0, True)
            self._llm._ctx.kv_cache_clear()  # noqa: SLF001 - 公开 API 没有清理入口
            self._llm._ctx.decode(batch)  # noqa: SLF001
            pointer = llama_cpp.llama_get_embeddings_seq(self._llm._ctx.ctx, 0)  # noqa: SLF001
            if pointer is None:
                raise InferenceError("llama_get_embeddings_seq 返回空指针")
            score = float(pointer[0])
        finally:
            self._llm._ctx.kv_cache_clear()  # noqa: SLF001

        if not math.isfinite(score):
            raise InferenceError(f"重排输出不是有限数：{score}")
        return score
