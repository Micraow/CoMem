#!/usr/bin/env python3
"""CoMem 本地推理服务：OpenAI 兼容的 embedding + Cohere 兼容的 rerank。

CoMem 的 `AiSdkEmbeddingProvider`（`@ai-sdk/openai-compatible`）与
`HttpRerankProvider` 把请求打到这个进程，形状必须与远程供应商逐字段一致——本地
服务存在的理由是「不打爆远程配额」，不是「另一个协议」。

**只有 llama.cpp 一个后端**（`--device` 在 cpu / gpu 之间切）。理由见 README：
两个模型共享同一份 tokenizer 与训练配方，单栈才能保证分数可比；NPU 在启动期明确
拒绝，因为 llama.cpp 上游没有 Intel NPU 的 ggml backend。

资源：`--threads` 默认 `min(6, cpu_count // 2)`，推理在线程池里串行执行。启动脚本
应当再套一层 `nice -n 10 taskset -c 0-5`（README 有完整命令），否则模型会把所有
核吃满、把同机的其它服务挤到卡顿。

用法：
    nice -n 10 taskset -c 0-5 uv run server.py --device cpu --threads 6
    uv run server.py --list-devices      # 只探测设备，不起服务
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Literal, Sequence

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backends.base import (
    DEVICES,
    BackendUnavailableError,
    Device,
    InferenceError,
    l2_normalize,
    truncate_matryoshka,
)
from backends.llama_cpp import LlamaCppEmbedding, LlamaCppRerank

LOGGER = logging.getLogger("comem.local-inference")

#: 后端名。只有一个实现，但它出现在 `/health` 与 README 的表格里，写常量而不是
#: 散落的字面量。
BACKEND_NAME = "llama-cpp"

#: 模型目录。默认放在本目录的 `models/`，`--embedding-model` / `--rerank-model` 覆盖。
MODELS_DIR = Path(__file__).resolve().parent / "models"

#: 默认模型标识。响应里的 `model` 字段就是它，所以 CoMem 的
#: `providers.embedding.model` / `providers.rerank.model` 要写成同一个值。
DEFAULT_EMBEDDING_MODEL = "Qwen3-Embedding-0.6B"
DEFAULT_RERANK_MODEL = "Qwen3-Reranker-0.6B"

#: 模型文件名。`ggml-org` 的 reranker 仓库用全小写，Qwen 的 embedding 仓库用原名。
EMBEDDING_MODEL_FILE = "Qwen3-Embedding-0.6B-Q8_0.gguf"
RERANK_MODEL_FILE = "qwen3-reranker-0.6b-q8_0.gguf"

#: 单批默认条数。32 是实测的吞吐拐点：再大在 CPU 上收益低于 15%，而中断一次回填
#: 损失的进度更多。来源见 README 的 bench 表格。
DEFAULT_MAX_BATCH_SIZE = 32

#: Qwen3 系列的原生上下文上限。超过就截断并记 warn——**不要静默截断**：回填一万个
#: 节点时如果每个都悄悄少一半，检索质量下降没有任何人会发现。
DEFAULT_MAX_SEQ_LEN = 8192

#: llama.cpp 的 `-ub`（micro batch）。它与 `n_ctx` 一起决定单次 decode 的 token
#: 上限，小于它时长输入会退化成串行多批，吞吐掉一半。
DEFAULT_N_BATCH = 8192

#: 线程数上限。16 核机器上取 6：留出核给 CoMem 自己的 Node 进程与同机的其它服务。
MAX_THREADS = 6

#: HTTP 层的并发度。模型实例不是线程安全的，所以每个模型一个单线程池（请求排队），
#: 而不是让两个线程同时进 `infer()` 把状态搅乱。
POOL_SIZE = 1

#: Qwen3-Embedding 的 query 侧 instruction（模型卡 `format_instruction`）。document
#: 侧不加前缀——这是官方评估的写法，两边都加会稀释相似度。
DEFAULT_QUERY_INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query"
)


# --------------------------------------------------------------------------- 配置


@dataclass(frozen=True)
class ServerConfig:
    """命令行解析后的运行配置。"""

    device: Device
    threads: int
    max_batch_size: int
    max_seq_len: int
    n_batch: int
    embedding_model_path: str
    embedding_model_id: str
    rerank_enabled: bool
    rerank_device: Device
    rerank_model_path: str
    rerank_model_id: str
    query_instruction: str
    host: str
    port: int
    warmup: bool


def default_threads() -> int:
    """`min(6, cpu_count // 2)`。

    除以 2 是因为超线程（以及 P / E 核混排）下「逻辑核数」不是可用的并行度；上限 6
    来自「16 核机器上不许吃满」（AGENTS.md 的资源约束，上次跑 benchmark 把 16 核
    全占满，用户当场卡顿）。
    """
    return max(1, min(MAX_THREADS, (os.cpu_count() or 2) // 2))


# --------------------------------------------------------------------- 请求 / 响应


class EmbeddingRequest(BaseModel):
    """`POST /v1/embeddings` 的请求体。

    多余字段忽略（OpenAI 客户端会带 `user` / `encoding_format` 之类），但
    `encoding_format` 只支持 `float`——base64 需要客户端自己解码，而 CoMem 的适配器
    发的是 float。

    `input_type` 是本地扩展：`query` 会在前面加 Qwen3-Embedding 的 instruction 前缀，
    `document`（默认）不加。CoMem 目前没有区分 query / document，所以默认走 document；
    将来要做「问题侧」嵌入时用它，而不是让调用方自己拼前缀——前缀是模型契约的一部分。
    """

    model: str = ""
    input: str | list[str]
    dimensions: int | None = None
    encoding_format: Literal["float"] | None = None
    input_type: Literal["query", "document"] = "document"


class RerankRequest(BaseModel):
    """`POST /v1/rerank` 的请求体（Cohere / Jina 形状）。"""

    model: str = ""
    query: str
    documents: list[str]
    top_n: int | None = None


class Usage(BaseModel):
    """OpenAI 的 `usage`。嵌入只有输入，`prompt_tokens == total_tokens`。"""

    prompt_tokens: int
    total_tokens: int


class EmbeddingItem(BaseModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: list[float]


class EmbeddingResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[EmbeddingItem]
    model: str
    usage: Usage


class RerankResultItem(BaseModel):
    """单条重排结果。

    `relevance_score` 的尺度由 `/health` 的 `rerank.score_semantics` 说明：RANK
    池化的分类头输出，取 `logit(yes) - logit(no)`，**未归一化、可正可负**。CoMem 的
    `applyRerank` 按原值降序、不做 clamp——把 -0.15 clamp 成 0 会把「明确不相关」
    和「中性」挤在一起。
    """

    index: int
    relevance_score: float


class RerankResponse(BaseModel):
    model: str
    results: list[RerankResultItem]
    usage: Usage


class RerankHealth(BaseModel):
    """重排的实际状态。

    `enabled: false` 且 `error` 非空表示「加载失败」——这时 `/v1/rerank` 返回 503
    而不是 404，调用方据此区分「没配」与「配了但起不来」。
    """

    enabled: bool
    backend: str
    device: str
    model: str
    #: 分数语义。`logit` 未归一化（可正可负）、`probability` 在 [0, 1]。换模型或换
    #: 量化档位会改变尺度，做了阈值过滤的部署必须重新校准。
    score_semantics: Literal["logit", "probability"] | None = None
    error: str | None = None


class HealthResponse(BaseModel):
    """`GET /health`。

    字段是 CoMem 的运维脚本与 README 的表格直接读的，改名会破坏它们。`rerank` 是
    附加信息：重排可以跑在与嵌入不同的设备上（例如嵌入走 CPU、重排走 GPU），只报
    一个 `device` 会撒谎。
    """

    status: Literal["ok", "degraded"]
    backend: str
    device: str
    model: str
    dimension: int
    ready: bool
    threads: int
    rerank: RerankHealth | None = None


# ------------------------------------------------------------------------ 服务状态


@dataclass
class ServiceState:
    """进程级单例。模型只加载一次，所有请求共用。"""

    config: ServerConfig
    embedding: LlamaCppEmbedding
    rerank: LlamaCppRerank | None
    rerank_error: str | None
    embed_pool: ThreadPoolExecutor = field(
        default_factory=lambda: ThreadPoolExecutor(
            max_workers=POOL_SIZE, thread_name_prefix="embed"
        )
    )
    rerank_pool: ThreadPoolExecutor = field(
        default_factory=lambda: ThreadPoolExecutor(
            max_workers=POOL_SIZE, thread_name_prefix="rerank"
        )
    )
    ready: bool = False

    def health(self) -> HealthResponse:
        rerank_health: RerankHealth | None
        if self.rerank is not None:
            rerank_health = RerankHealth(
                enabled=True,
                backend=self.rerank.backend,
                device=self.rerank.device,
                model=self.rerank.model,
                score_semantics=self.rerank.score_semantics,  # type: ignore[arg-type]
            )
        elif self.rerank_error is not None:
            rerank_health = RerankHealth(
                enabled=False,
                backend=BACKEND_NAME,
                device=self.config.rerank_device,
                model=self.config.rerank_model_id,
                score_semantics=None,
                error=self.rerank_error,
            )
        else:
            rerank_health = None
        return HealthResponse(
            # `degraded` 只表达「重排不可用」这一件事：嵌入是主路径，它不可用进程
            # 根本起不来（启动即退出），所以 ready 为 true 时 status 只可能是 ok
            # 或 degraded。
            status="degraded" if self.rerank_error is not None else "ok",
            backend=self.embedding.backend,
            device=self.embedding.device,
            model=self.embedding.model,
            dimension=self.embedding.dimension,
            ready=self.ready,
            threads=self.embedding.threads,
            rerank=rerank_health,
        )


#: 进程级状态。`create_app()` 在启动时填它；请求处理函数通过 `get_state()` 拿。
_STATE: ServiceState | None = None


def get_state() -> ServiceState:
    if _STATE is None:  # pragma: no cover - 由 lifespan 保证不会发生
        raise RuntimeError("服务尚未初始化")
    return _STATE


# ------------------------------------------------------------------------ 错误形状


def openai_error(
    status_code: int, message: str, *, error_type: str, code: str
) -> JSONResponse:
    """OpenAI 的错误封套。

    `AiSdkEmbeddingProvider` 按 `statusCode` 分支（401/403、400/404/422、429、5xx），
    所以状态码必须准确；`message` 是给人看的，`code` 是稳定标识。
    """
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": error_type, "code": code}},
    )


async def require_authorization(request: Request) -> None:
    """要求 `Authorization` 头存在，**不校验值**。

    本地服务没有账号体系，校验值只会让部署多一个必填项。要求头存在是为了让「CoMem
    的 `providers.embedding.apiKey` 忘了填」在第一次请求时暴露成 401，而不是变成
    「向量全是同一条」这类更难查的症状。CoMem 的适配器在 apiKey 为 `""` 时仍会发
    `Authorization: Bearer `，所以空 key 也能通过——这里只挡「完全没有头」的客户端。
    """
    header = request.headers.get("authorization")
    if header is None or header.strip() == "":
        raise HTTPException(
            status_code=401,
            detail={
                "message": "缺少 Authorization 头。本地推理服务只检查它是否存在。",
                "type": "invalid_request_error",
                "code": "missing_authorization",
            },
        )


def _http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    """把 `HTTPException` 的 dict `detail` 转成 OpenAI 封套。"""
    detail = exc.detail
    if isinstance(detail, dict) and "message" in detail:
        return openai_error(
            exc.status_code,
            str(detail["message"]),
            error_type=str(detail.get("type", "invalid_request_error")),
            code=str(detail.get("code", "error")),
        )
    return openai_error(
        exc.status_code, str(detail), error_type="invalid_request_error", code="error"
    )


# --------------------------------------------------------------------------- 应用


def _resolve_dimensions(state: ServiceState, requested: int | None) -> int:
    """校验并解析 `dimensions`。

    超过原生维度直接 400。静默返回原生维度会让调用方的向量表长度与配置不一致，
    而这种不一致在余弦检索里表现为「查不出东西」而不是报错。
    """
    native = state.embedding.dimension
    if requested is None:
        return native
    if requested <= 0:
        raise HTTPException(
            status_code=400,
            detail={
                "message": f"dimensions 必须是正整数，收到 {requested}。",
                "type": "invalid_request_error",
                "code": "invalid_dimensions",
            },
        )
    if requested > native:
        raise HTTPException(
            status_code=400,
            detail={
                "message": (
                    f"dimensions={requested} 超过模型 {state.embedding.model} 的原生维度 "
                    f"{native}。Matryoshka 只能截断，不能补维度。"
                ),
                "type": "invalid_request_error",
                "code": "invalid_dimensions",
            },
        )
    return requested


def _check_model(requested: str, served: str) -> None:
    """校验请求体里的 `model`。

    空字符串放过（部分客户端不填）。写错就 404 并列出可用标识——让配置错误在第一
    次请求时定位，而不是靠「向量看起来不对」去猜。
    """
    if requested == "" or requested == served:
        return
    raise HTTPException(
        status_code=404,
        detail={
            "message": f"模型 {requested!r} 不存在。本服务提供：{served!r}。",
            "type": "invalid_request_error",
            "code": "model_not_found",
        },
    )


def _normalize(vectors: Sequence[Sequence[float]], dimensions: int) -> list[list[float]]:
    """截断 + 重归一化。

    顺序固定：**先截断、再归一化**。反过来的话 512 维向量的模长是 `sqrt(512/1024)`
    而 1024 维是 1.0，两种维度混在一个 `vec0` 表里余弦距离整体错位。
    """
    return [l2_normalize(truncate_matryoshka(vector, dimensions)) for vector in vectors]


def _apply_query_prefix(texts: Sequence[str], instruction: str) -> list[str]:
    """query 侧加 instruction 前缀。

    格式来自 Qwen3-Embedding 模型卡：`Instruct: {task}\\nQuery: {query}`。document
    侧不加——官方评估里只有 query 侧带指令。
    """
    prefix = f"Instruct: {instruction}\nQuery: "
    return [f"{prefix}{text}" for text in texts]


def create_app(config: ServerConfig) -> FastAPI:
    """构造应用。模型加载在 lifespan 里发生（`--list-devices` 不需要）。"""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        global _STATE

        LOGGER.info(
            "加载嵌入模型：device=%s threads=%d path=%s",
            config.device,
            config.threads,
            config.embedding_model_path,
        )
        embedding = LlamaCppEmbedding(
            model_path=config.embedding_model_path,
            model_id=config.embedding_model_id,
            device=config.device,
            threads=config.threads,
            max_seq_len=config.max_seq_len,
            n_batch=config.n_batch,
        )

        rerank: LlamaCppRerank | None = None
        rerank_error: str | None = None
        if config.rerank_enabled:
            try:
                rerank = LlamaCppRerank(
                    model_path=config.rerank_model_path,
                    model_id=config.rerank_model_id,
                    device=config.rerank_device,
                    threads=config.threads,
                    max_seq_len=config.max_seq_len,
                    n_batch=config.n_batch,
                )
            except BackendUnavailableError as error:
                # 重排不是主路径：起不来就退化成「只有嵌入」。但**必须可见**——
                # `/health` 报 degraded、`/v1/rerank` 返回 503 带原因，不能静默 404。
                # GGUF 校验失败也走这里（坏 GGUF 的分数看起来正常，静默放行最危险）。
                rerank_error = str(error)
                LOGGER.error("重排后端不可用，仅提供嵌入：%s", error)

        state = ServiceState(
            config=config,
            embedding=embedding,
            rerank=rerank,
            rerank_error=rerank_error,
        )
        _STATE = state
        app.state.service = state

        if config.warmup:
            # 预热：第一次推理要建 Vulkan pipeline / 加载 AVX-512 kernel，不预热的话
            # 启动后的第一条真实请求会超时。
            loop = asyncio.get_running_loop()
            batch = await loop.run_in_executor(
                state.embed_pool, lambda: state.embedding.embed(["warmup"])
            )
            LOGGER.info(
                "预热完成：%d 维，%d token",
                len(batch.vectors[0]) if batch.vectors else 0,
                batch.prompt_tokens,
            )

        state.ready = True
        LOGGER.info(
            "ready: backend=%s device=%s model=%s dimension=%d threads=%d rerank=%s",
            embedding.backend,
            embedding.device,
            embedding.model,
            embedding.dimension,
            embedding.threads,
            "on" if rerank is not None else "off",
        )
        try:
            yield
        finally:
            state.ready = False
            state.embed_pool.shutdown(wait=False, cancel_futures=True)
            state.rerank_pool.shutdown(wait=False, cancel_futures=True)
            embedding.close()
            if rerank is not None:
                rerank.close()
            _STATE = None

    app = FastAPI(
        title="CoMem local inference",
        version="1.0.0",
        description="本地 embedding / rerank 服务（OpenAI 与 Cohere 兼容）",
        lifespan=lifespan,
    )
    app.add_exception_handler(HTTPException, _http_error_handler)  # type: ignore[arg-type]

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return get_state().health()

    @app.get("/v1/models")
    async def models() -> dict[str, object]:
        state = get_state()
        data: list[dict[str, object]] = [
            {
                "id": state.embedding.model,
                "object": "model",
                "created": 0,
                "owned_by": "comem-local",
            }
        ]
        if state.rerank is not None:
            data.append(
                {
                    "id": state.rerank.model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "comem-local",
                }
            )
        return {"object": "list", "data": data}

    @app.post(
        "/v1/embeddings",
        response_model=EmbeddingResponse,
        dependencies=[Depends(require_authorization)],
    )
    async def embeddings(payload: EmbeddingRequest) -> EmbeddingResponse:
        state = get_state()
        _check_model(payload.model, state.embedding.model)
        dimensions = _resolve_dimensions(state, payload.dimensions)

        texts = [payload.input] if isinstance(payload.input, str) else list(payload.input)
        # 空数组不跑模型：回填任务在「没有待处理节点」时不该产生一次推理，
        # 更不该因为模型不可用而失败。
        if not texts:
            return EmbeddingResponse(
                data=[],
                model=state.embedding.model,
                usage=Usage(prompt_tokens=0, total_tokens=0),
            )

        if payload.input_type == "query":
            texts = _apply_query_prefix(texts, state.config.query_instruction)

        loop = asyncio.get_running_loop()
        vectors: list[list[float]] = []
        tokens = 0
        truncated: list[int] = []
        # 超过 `max_batch_size` 的内部切分后合并，**不是拒绝**：回填一万个节点时
        # 调用方不该关心批大小，而分批是必须的（模型侧装不下）。
        for start in range(0, len(texts), state.config.max_batch_size):
            batch_texts = texts[start : start + state.config.max_batch_size]
            try:
                batch = await loop.run_in_executor(
                    state.embed_pool, lambda b=batch_texts: state.embedding.embed(b)
                )
            except InferenceError as error:
                LOGGER.exception("嵌入失败")
                return openai_error(
                    500,
                    f"本地嵌入推理失败：{error}",
                    error_type="server_error",
                    code="inference_failed",
                )  # type: ignore[return-value]
            if len(batch.vectors) != len(batch_texts):
                # 向量条数错位会让调用方把 A 的向量写回 B 的节点，而类型检查
                # 不报错。宁可整批失败。
                return openai_error(
                    500,
                    f"嵌入后端返回 {len(batch.vectors)} 条向量，期望 {len(batch_texts)} 条。",
                    error_type="server_error",
                    code="vector_count_mismatch",
                )  # type: ignore[return-value]
            vectors.extend(batch.vectors)
            tokens += batch.prompt_tokens
            truncated.extend(start + index for index in batch.truncated)

        if truncated:
            LOGGER.warning(
                "截断了 %d 条超长输入到 max_seq_len=%d（下标 %s）",
                len(truncated),
                state.config.max_seq_len,
                truncated[:10],
            )

        normalized = _normalize(vectors, dimensions)

        return EmbeddingResponse(
            data=[
                EmbeddingItem(index=index, embedding=vector)
                for index, vector in enumerate(normalized)
            ],
            model=state.embedding.model,
            usage=Usage(prompt_tokens=tokens, total_tokens=tokens),
        )

    @app.post(
        "/v1/rerank",
        response_model=RerankResponse,
        dependencies=[Depends(require_authorization)],
    )
    async def rerank(payload: RerankRequest) -> RerankResponse:
        state = get_state()
        if state.rerank is None:
            return openai_error(
                503,
                state.rerank_error
                or "重排后端未启用。用 --rerank-model 指定模型，或加 --no-rerank 明确关闭。",
                error_type="server_error",
                code="rerank_unavailable",
            )  # type: ignore[return-value]
        _check_model(payload.model, state.rerank.model)

        if not payload.documents:
            return RerankResponse(
                model=state.rerank.model,
                results=[],
                usage=Usage(prompt_tokens=0, total_tokens=0),
            )

        top_n = len(payload.documents) if payload.top_n is None else payload.top_n
        if top_n <= 0:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"top_n 必须是正整数，收到 {top_n}。",
                    "type": "invalid_request_error",
                    "code": "invalid_top_n",
                },
            )

        loop = asyncio.get_running_loop()
        try:
            batch = await loop.run_in_executor(
                state.rerank_pool,
                lambda: state.rerank.score(payload.query, list(payload.documents)),
            )
        except InferenceError as error:
            LOGGER.exception("重排失败")
            return openai_error(
                500,
                f"本地重排推理失败：{error}",
                error_type="server_error",
                code="inference_failed",
            )  # type: ignore[return-value]

        if batch.truncated:
            LOGGER.warning(
                "重排截断了 %d 条超长文档到 max_seq_len=%d",
                len(batch.truncated),
                state.config.max_seq_len,
            )

        # 按分数降序，只返回 top_n 条。没有分数的文档（空串）不参与排序——它们在
        # 模型侧没有可打分的语义，返回一个编造的分数会让调用方无法区分。
        scored = [
            (index, score)
            for index, score in enumerate(batch.scores)
            if score is not None
        ]
        scored.sort(key=lambda item: item[1], reverse=True)

        return RerankResponse(
            model=state.rerank.model,
            results=[
                RerankResultItem(index=index, relevance_score=score)
                for index, score in scored[:top_n]
            ],
            usage=Usage(
                prompt_tokens=batch.prompt_tokens, total_tokens=batch.prompt_tokens
            ),
        )

    return app


# ------------------------------------------------------------------------ 设备探测


def _probe_devices() -> dict[str, object]:
    """探测本机的推理设备与 llama.cpp 的构建能力。

    不自动 fallback：`--device gpu` 但构建没有 Vulkan 时拒绝启动，而不是静默跑
    CPU——「以为跑在核显上、实际跑 CPU」是这类服务最常见的坑。
    """
    accel = sorted(str(path) for path in Path("/dev").glob("accel*"))
    dri = sorted(str(path) for path in Path("/dev/dri").glob("render*"))

    vulkan_devices: list[str] = []
    if shutil.which("vulkaninfo") is not None:
        try:
            import subprocess

            completed = subprocess.run(
                ["vulkaninfo", "--summary"],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            for line in completed.stdout.splitlines():
                stripped = line.strip()
                if stripped.startswith("deviceName"):
                    vulkan_devices.append(stripped.split("=", 1)[1].strip())
        except (OSError, subprocess.SubprocessError) as error:  # pragma: no cover
            vulkan_devices = [f"vulkaninfo 失败：{error}"]

    gpu_offload: bool | str
    try:
        import llama_cpp

        gpu_offload = llama_cpp.llama_supports_gpu_offload()
    except Exception as error:  # noqa: BLE001 - 探测失败要报告原因，不能吞
        gpu_offload = f"{type(error).__name__}: {error}"

    return {
        "cpu_count": os.cpu_count(),
        # llama.cpp 没有 NPU backend：这两个设备节点存在也不代表能用于推理。
        "npu_char_devices": accel,
        "render_nodes": dri,
        "vulkan_physical_devices": vulkan_devices,
        "llama_cpp_gpu_offload": gpu_offload,
    }


# ----------------------------------------------------------------------------- 入口


def _parse_args(argv: Sequence[str] | None = None) -> tuple[ServerConfig, bool]:
    parser = argparse.ArgumentParser(
        description="CoMem 本地推理服务（OpenAI 兼容 embedding + Cohere 兼容 rerank）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--device",
        choices=DEVICES,
        default="cpu",
        help="推理设备。npu 不被 llama.cpp 支持，会拒绝启动",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=default_threads(),
        help=f"推理线程数（默认 min({MAX_THREADS}, cpu_count // 2)）",
    )
    parser.add_argument("--max-batch-size", type=int, default=DEFAULT_MAX_BATCH_SIZE)
    parser.add_argument("--max-seq-len", type=int, default=DEFAULT_MAX_SEQ_LEN)
    parser.add_argument(
        "--n-batch",
        type=int,
        default=DEFAULT_N_BATCH,
        help="llama.cpp 的 -ub（micro batch）。小于输入长度时吞吐会掉一半",
    )
    parser.add_argument(
        "--embedding-model",
        default="",
        help=f"GGUF 文件，默认 models/{EMBEDDING_MODEL_FILE}",
    )
    parser.add_argument("--embedding-model-id", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--no-rerank", action="store_true", help="不加载重排模型")
    parser.add_argument("--rerank-device", choices=DEVICES, default=None)
    parser.add_argument(
        "--rerank-model",
        default="",
        help=f"GGUF 文件，默认 models/{RERANK_MODEL_FILE}",
    )
    parser.add_argument("--rerank-model-id", default=DEFAULT_RERANK_MODEL)
    parser.add_argument(
        "--query-instruction",
        default=DEFAULT_QUERY_INSTRUCTION,
        help="input_type=query 时加在输入前面的 instruction",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8089)
    parser.add_argument("--no-warmup", action="store_true", help="跳过启动预热")
    parser.add_argument(
        "--list-devices", action="store_true", help="打印设备探测结果后退出"
    )
    args = parser.parse_args(argv)

    for name in ("threads", "max_batch_size", "max_seq_len", "n_batch"):
        value = getattr(args, name)
        if value <= 0:
            parser.error(f"--{name.replace('_', '-')} 必须是正整数，收到 {value}")
    if args.rerank_device is not None and args.no_rerank:
        parser.error("--rerank-device 与 --no-rerank 不能同时给")

    config = ServerConfig(
        device=args.device,
        threads=args.threads,
        max_batch_size=args.max_batch_size,
        max_seq_len=args.max_seq_len,
        n_batch=args.n_batch,
        embedding_model_path=args.embedding_model
        or str(MODELS_DIR / EMBEDDING_MODEL_FILE),
        embedding_model_id=args.embedding_model_id,
        rerank_enabled=not args.no_rerank,
        rerank_device=args.rerank_device or args.device,
        rerank_model_path=args.rerank_model or str(MODELS_DIR / RERANK_MODEL_FILE),
        rerank_model_id=args.rerank_model_id,
        query_instruction=args.query_instruction,
        host=args.host,
        port=args.port,
        warmup=not args.no_warmup,
    )
    return config, args.list_devices


def main(argv: Sequence[str] | None = None) -> int:
    config, list_devices = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if list_devices:
        print(json.dumps(_probe_devices(), indent=2, ensure_ascii=False))
        return 0

    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        log_level="info",
        # 单进程：模型只加载一份。多 worker 会让每个进程各占一份内存，
        # 在 9–14GB 可用的机器上没有意义。
        workers=1,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
