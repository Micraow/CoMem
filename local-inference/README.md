# 本地推理服务

给 CoMem 提供**本地** embedding 与 rerank 的 HTTP 服务，OpenAI 的
`/v1/embeddings` 与 Cohere 的 `/v1/rerank` 两种形状。CoMem 通过
`providers.embedding.baseUrl` / `providers.rerank.baseUrl` 指向它，把「远程供应商」
换成 `http://127.0.0.1:8089/v1`，不需要改任何代码。

```
local-inference/
├── server.py              # HTTP 服务（FastAPI + uvicorn）
├── backends/
│   ├── base.py            # 共享类型与纯函数（归一化、Matryoshka 截断）
│   └── llama_cpp.py        # llama.cpp 后端（GGUF，CPU / Vulkan）
├── bench.py               # 基准测试（每个设备跑在子进程里）
├── models/                # 模型权重（不进版本控制）
└── pyproject.toml
```

## 为什么需要本地推理

两个独立的理由，任一成立就够：

1. **远程配额会被回填打爆。** 导入 810MB 历史对话（900+ 会话）时每条会话都要算
   embedding。远程供应商按 token 计费，一次全量回填就是几十万次调用——配额先于
   成本耗尽，而 CoMem 的索引重建是「随时可能发生」的运维动作（换模型、改维度、
   `reindex`），不能每次都被配额卡住。
2. **数据不出本机。** CoMem 的定位是「本地数据库」。把每一条记忆的正文发给第三方
   做嵌入，等于把「本地」这个前提交出去；而且依赖第三方可用性之后，对方一次故障
   就是 CoMem 的语义检索全挂。

## 安装

### 1. Python 3.12

系统 Python 是 3.14，而 `llama-cpp-python` 的源码编译在新版本上会撞 CPython 内部
头文件变更。用 `uv` 装一个 3.12 专用解释器，不碰系统 Python：

```bash
uv python install 3.12
cd local-inference
uv venv --python 3.12 .venv
```

### 2. 依赖（含 Vulkan 源码编译）

`llama-cpp-python` 的预编译 wheel **只有 CPU 后端**。要用 Intel Arc 核显必须带
`GGML_VULKAN=ON` 自己编译：

```bash
sudo pacman -S --needed vulkan-headers spirv-headers shaderc
# 只需要一次；编译产物在 ~/.cache/uv 里，后续重装不再联网

CMAKE_ARGS="-DGGML_VULKAN=ON -DGGML_NATIVE=ON" \
CMAKE_BUILD_PARALLEL_LEVEL=6 \
CMAKE_PREFIX_PATH=/usr/share/cmake \
nice -n 10 uv pip install --python .venv/bin/python --no-binary llama-cpp-python llama-cpp-python
```

> `CMAKE_PREFIX_PATH=/usr/share/cmake` 是 Arch 特有的：`spirv-headers` 的 CMake
> 配置文件装在 `/usr/share/cmake` 下，而 CMake 默认只查 `/usr/lib/cmake`。

其余依赖（FastAPI / uvicorn / pydantic）都是纯 wheel：

```bash
uv pip install --python .venv/bin/python fastapi "uvicorn[standard]" pydantic
```

**不需要 PyTorch。** 模型是预量化好的 GGUF，`llama.cpp` 直接 mmap 加载；引入
`torch` 只会多 2.5GB 磁盘和一整套 CUDA / XPU 运行时。

### 3. 模型

两个 GGUF，合计 **1.28GB**：

| 用途 | 仓库 | 文件 | 体积 |
|---|---|---|---|
| Embedding | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `Qwen3-Embedding-0.6B-Q8_0.gguf` | 639,150,592 B |
| Rerank | `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` | `qwen3-reranker-0.6b-q8_0.gguf` | 639,153,184 B |

```bash
cd local-inference/models

# 国内直连 ModelScope（本机实测可用；huggingface 需要代理）
curl -L -C - -o Qwen3-Embedding-0.6B-Q8_0.gguf \
  "https://www.modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf"

curl -L -C - -o qwen3-reranker-0.6b-q8_0.gguf \
  "https://www.modelscope.cn/models/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/master/qwen3-reranker-0.6b-q8_0.gguf"
```

走 Hugging Face 时**必须**设镜像（`huggingface.co` 直连在本机 401）：

```bash
export HF_ENDPOINT=https://hf-mirror.com
hf download Qwen/Qwen3-Embedding-0.6B-GGUF Qwen3-Embedding-0.6B-Q8_0.gguf --local-dir models
hf download ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF qwen3-reranker-0.6b-q8_0.gguf --local-dir models
```

> **reranker 的 GGUF 只能选 `ggml-org` 那个。** 社区仓（`mradermacher` 等）的
> Q8_0 是用旧转换器做的，只有 310 个张量、缺 `cls.output.weight`、`pooling_type`
> 也不是 `RANK`。这种模型**能加载、能返回分数、分数看起来在合理范围**，但排序是
> 垃圾。服务启动时会校验元数据，不过就拒绝启动——见下面的「rerank 的 GGUF 校验」。

## 运行

```bash
# 限 6 核 + 降优先级：16 核全占满会让同机的其它服务明显卡顿
cd local-inference
nice -n 10 taskset -c 0-5 .venv/bin/python server.py --device cpu --threads 6
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--device` | `cpu` | `cpu` / `gpu`（Vulkan）。`npu` 会被拒绝，见「已知限制」 |
| `--threads` | `min(6, cpu_count // 2)` | 推理线程数。16 核机器上就是 6 |
| `--max-batch-size` | `32` | 单次请求内部切分的批大小。超出自动切分后合并 |
| `--max-seq-len` | `8192` | 截断上限。超过记 `warn` |
| `--n-batch` | `8192` | llama.cpp 的 `-ub`（micro batch）。小于输入长度时吞吐掉一半 |
| `--no-rerank` | 关 | 只加载 embedding 模型 |
| `--rerank-device` | 同 `--device` | 重排可以单独选设备 |
| `--port` | `8089` | 监听端口 |
| `--list-devices` | — | 打印设备探测结果后退出 |

启动后会先跑一次 `embed(["warmup"])` 再打印 `ready:`——不预热的话第一条真实请求
会等到 Vulkan pipeline 编译完成（数百毫秒）。

### 怎么调线程数

`--threads` 直接传给 `llama.cpp` 的 `n_threads`。经验规则：

- **6 核以内**：线性收益。6 → 12 核约 +30%，12 → 16 核基本没有（P 核已经饱和）。
- **与同机其它服务抢核时**：把 `taskset` 的核集合与 `--threads` 设成一样大。两者
  不一致时 `llama.cpp` 的 worker 线程会被调度到集合之外，`taskset` 就白设了。
- **冒烟测试**可以用 `--threads 2`，吞吐约 1/3，但机器完全不受影响。

## 设备矩阵

`curl /health` 的 `device` 字段是**实际生效**的设备，不是配置里写的那个。

| 后端 | `--device` | 能不能跑 | 证据 |
|---|---|---|---|
| llama.cpp | `cpu` | ✅ | ggml CPU 后端 + AVX-512（`avx_vnni` / `avx512` 由 CPU 标志确认） |
| llama.cpp | `gpu` | ✅ | Vulkan 1.4，`ggml_vulkan: 0 = Intel(R) Graphics (ARL)`，Mesa 26.2.6 |
| llama.cpp | `npu` | ❌ | **启动期拒绝**：llama.cpp 上游没有 Intel NPU 的 ggml backend |

`--device gpu` 在构建没有 Vulkan 时会**拒绝启动**而不是静默跑 CPU：

```
BackendUnavailableError: 这个 llama-cpp-python 构建没有 GPU 后端。
需要带 `CMAKE_ARGS='-DGGML_VULKAN=ON'` 重新编译
```

核显是 Intel Arc Pro 130T/140T（`00:02.0`，deviceID `0x7d51`），**没有 CUDA**。
`vulkaninfo --summary` 报告 `uma: 1`——统一内存架构，核显与 CPU 共享那 30GB。

## 与 CoMem 对接

`config.yaml`：

```yaml
providers:
  embedding:
    type: openai-compatible
    baseUrl: http://127.0.0.1:8089/v1
    model: Qwen3-Embedding-0.6B
    apiKey: local            # 只检查 Authorization 头存在，值不校验
    dimension: 1024
    maxBatchSize: 32
    timeoutSeconds: 60       # 本地推理不需要 30 秒那么紧
  rerank:
    type: http
    baseUrl: http://127.0.0.1:8089/v1
    model: Qwen3-Reranker-0.6B
    apiKey: local
    timeoutSeconds: 20
    topN: 50

retrieval:
  engine: hybrid             # 本地嵌入才谈得上语义检索
  rerank:
    enabled: true
```

`dimension` **必须**是 1024（0.6B 的原生维度）。写错会在第一次嵌入时抛
`PROVIDER_UNAVAILABLE`——服务端按 `dimensions` 校验，超过 1024 直接 400。

## API

### `GET /health`

```json
{
  "status": "ok",
  "backend": "llama-cpp",
  "device": "cpu",
  "model": "Qwen3-Embedding-0.6B",
  "dimension": 1024,
  "ready": true,
  "threads": 6,
  "rerank": {
    "enabled": true,
    "backend": "llama-cpp",
    "device": "cpu",
    "model": "Qwen3-Reranker-0.6B",
    "score_semantics": "logit",
    "error": null
  }
}
```

`status: degraded` 只表示**重排不可用**（嵌入起不来的话进程已经退出了）。

### `GET /v1/models`

OpenAI 形状。只列实际加载成功的模型。

### `POST /v1/embeddings`

```json
{"model": "Qwen3-Embedding-0.6B", "input": ["文本1", "文本2"], "dimensions": 1024}
```

- `input` 支持 `string` 与 `string[]`；空数组返回空 `data`，不跑模型
- `dimensions` 支持 Matryoshka 截断（1024 / 512 / 256），**截断后重新做 L2 归一化**
- 输出已 L2 归一化（模长 1.0）
- `input_type: "query"` 会在前面加 `Instruct: {task}\nQuery: ` 前缀（默认 `document`
  不加）
- 超过 `max_batch_size` 的输入内部切分后合并
- 缺 `Authorization` 头返回 401（**只检查存在，不校验值**）

### `POST /v1/rerank`

```json
{"model": "Qwen3-Reranker-0.6B", "query": "...", "documents": ["...", "..."], "top_n": 3}
```

```json
{"model": "Qwen3-Reranker-0.6B", "results": [{"index": 0, "relevance_score": 12.75}],
 "usage": {"prompt_tokens": 213, "total_tokens": 213}}
```

`relevance_score` 是 `logit(yes) - logit(no)`：**未归一化、可以是负数**，不做
clamp。结果按分数降序，只返回 `top_n` 条。空文档（`""`）不送模型，也不会出现在
`results` 里。

## 性能

<!-- BENCH_TABLE -->

## 内存与磁盘

<!-- MEMORY_TABLE -->

## 已知限制

- **NPU 不可用。** 本机有 Intel AI Boost NPU（`00:0b.0`，`intel_vpu` 驱动已加载），
  但 llama.cpp 上游没有 NPU 的 ggml backend，`--device npu` 在启动期直接报错。
  要用 NPU 只能换 OpenVINO，而那是另一套分数语义。
- **rerank 的 GGUF 只有 `ggml-org` 那一个仓库是对的。** 社区仓的 Q8_0 是坏转换器
  的产物，服务启动时会校验 `tensor_count == 311`、`pooling_type == RANK(4)`、
  `classifier.output_labels` 含 `yes`/`no`、`tokenizer.chat_template.rerank` 存在，
  任何一条不过就拒绝启动。
- **分数尺度依赖量化档位。** Q8_0 与 Q4_K_M 的排序基本一致，但绝对分数会漂。
  如果 CoMem 将来做阈值过滤（`scoreThreshold`），必须在**选定的档位**上重新标定，
  不能跨档位复用。
- **不要给 embedding / rerank 开 KV cache 量化**（`-ctk q4_0 -ctv q4_0`）。上游
  issue #16407 明确不建议：KV 量化会给池化后的向量引入与输入长度相关的偏差。
- **单进程、单线程池。** 模型实例不是线程安全的，所有推理请求串行执行。并发请求
  排队，不会并行跑——这是刻意的：16 核机器上并行推理只会让每个请求都变慢。
- **`input_type: "query"` 是本地扩展。** CoMem 目前把整段正文当 document 嵌入，
  没有 query / document 区分。加上前缀在官方评估里提升 1%–5%，但会改变向量分布，
  切换时必须全量重建索引。
- **模型体积 1.28GB**（两个 Q8_0）。换成 Q4_K_M 可以到 0.7GB 左右，代价是检索
  质量下降——没有实测过两者的检索指标差异，不做推荐。

## 目录与产物

| 路径 | 内容 | 进版本控制 |
|---|---|---|
| `local-inference/models/*.gguf` | 模型权重（1.28GB） | 否 |
| `local-inference/.venv/` | Python 虚拟环境 | 否 |
