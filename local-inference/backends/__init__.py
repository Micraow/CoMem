"""本地推理后端。

`base.py` 放共享类型与纯函数（`server.py` 与 `llama_cpp.py` 都用），
`llama_cpp.py` 是唯一的具体实现。
"""

from .base import (
    DEVICES,
    BackendUnavailableError,
    Device,
    EmbeddingBatch,
    InferenceError,
    RerankBatch,
    l2_normalize,
    truncate_matryoshka,
)

__all__ = [
    "DEVICES",
    "BackendUnavailableError",
    "Device",
    "EmbeddingBatch",
    "InferenceError",
    "RerankBatch",
    "l2_normalize",
    "truncate_matryoshka",
]
