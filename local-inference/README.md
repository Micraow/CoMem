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
| `--rerank-instruction` | 模板原文 | 替换 rerank 模板里的 `<Instruct>:` 行（服务端，不是请求字段） |
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
| llama.cpp | `cpu` | ✅ | ggml CPU 后端，`AVX = 1 \| AVX_VNNI = 1 \| AVX2 = 1 \| F16C = 1 \| FMA = 1 \| REPACK = 1`（**没有 AVX-512**：Arrow Lake 的 P 核不支持） |
| llama.cpp | `gpu` | ✅ | Vulkan 1.4.363，`ggml_vulkan: 0 = Intel(R) Graphics (ARL) \| uma: 1 \| fp16: 1`，Mesa 26.2.6 |
| llama.cpp | `npu` | ❌ | **启动期拒绝（退出码 2）**：llama.cpp 上游没有 Intel NPU 的 ggml backend |

**NPU 的硬件是存在的**：`lspci` 报 `00:0b.0 Processing accelerators: Intel Corporation
Core Ultra 200H/200V Series Processors NPU`，`intel_vpu` 模块已加载，字符设备
`/dev/accel/accel0`（`crw-rw----  root:render`）可打开（`micraow` 在 `render` 组里）。
缺的是 llama.cpp 的 backend，不是驱动。**要用 NPU 只能换 OpenVINO**，而那是另一套
运行时与另一套分数语义——不在本服务的范围内。

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
    "score_semantics": "probability",
    "rerank_instruction": "Given a web search query, retrieve relevant passages that answer the query",
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
{"model": "Qwen3-Reranker-0.6B", "results": [{"index": 0, "relevance_score": 0.987}],
 "usage": {"prompt_tokens": 213, "total_tokens": 213}}
```

`relevance_score` 是分类头 softmax 后的 `P(yes)`，值域 `[0, 1]`（实测形如
`[0.987, 0.013]`，两个概率和为 1）。它**不是可排序的绝对相关性**：不同模型、
不同量化档位下的同一串数字不可比，只能在同一份模型内部比较。结果按分数降序，
只返回 `top_n` 条。空文档（`""`）不送模型，也不会出现在 `results` 里。

### 阈值怎么标定

`relevance_score` 是 `P(yes)`，不是跨模型可比的绝对相关性。CoMem 的检索接口
（`find` / `search`）**不设阈值**：相关性由排序 + `limit` 决定。要按分数过滤，
只能在**重排之后**、在调用方按 `P(yes)` 的分布定阈值（Hook 的
`COMEM_RECALL_SCORE_THRESHOLD` 就是这种过滤：它按本次最高分的比例算，不是绝对
分数下限）。这个阈值必须：

- **在选定的量化档位上重新标定。** Q8_0 与 Q4_K_M 的概率分布不同，同一个阈值
  不能跨档位复用。
- **换 rerank 模型（0.6B → 4B）时同样要重标。** 输出分布没有可继承的关系。
- **不要跨模型复用绝对阈值。** 阈值是「这份模型 + 这份语料」的联合性质，不是
  模型属性。

Hook 的默认值 `0.5` 是上述相对阈值（`score >= 本次最高分 × 0.5`），不是
`P(yes) == P(no)` 的中性点，也不是 CoMem 语料上的测量结果。
上线前用 `pnpm eval` 的 `hybrid+rerank` 变体跑一遍，看阈值移动对 Recall@10 的影响。

### rerank instruction

模型卡里的 instruction 是模板的一部分，不是请求字段。本服务用
`--rerank-instruction` 在**服务端**替换模板里的 `<Instruct>:` 行，所以 CoMem 的
`HttpRerankProvider` 与 `config.yaml` 一行都不用改：

```bash
.venv/bin/python server.py --rerank-instruction "Given a query, retrieve the passages that answer the query"
```

- **默认值保持模板原文**（`Given a web search query, retrieve relevant passages that
  answer the query`）。模型卡明确说它是 instruction-aware 的，公开基准上有
  instruction 比没有高 1%–5%；但 CoMem 的语料上没有测量，没有测量就改默认值，是
  没有证据支撑的场景适配。
- **没有 `{instruction}` 占位符。** 上游 llama.cpp 的 `/v1/rerank` 只认 `{query}` /
  `{document}`，未知字段静默忽略；这里是我们自己的端点，直接改模板。
- **不改 GGUF。** 改元数据要重写整个 639MB 文件，换一个 GGUF 就丢；模板在加载时
  已经进内存。
- **`/health` 的 `rerank_instruction` 是实际生效的文本**（最多 80 字符）。模板里没有
  `<Instruct>:` 行时它报 `null`，表示参数没有生效。
- **query 里的字面量 `{document}` 不会被替换。** 拼 prompt 是单遍扫描，取代了会
  互相覆盖的顺序两次 `str.replace`（对应上游 issue #30816）。

## 性能

**测法**：`nice -n 10 taskset -c 0-5 .venv/bin/python bench.py --devices cpu,gpu,npu
--batch-sizes 1,8,32 --lengths 32,128 --repeat 5`。每个设备跑在独立子进程里（两份权重
不同时驻留内存），测量期间机器负载约 5（同机有其它服务在跑）。

| 设备 | 批大小 | 目标 token | 实测 token/条 | 吞吐（条/秒） | P50 (ms) | P95 (ms) |
|---|---:|---:|---:|---:|---:|---:|
| cpu | 1 | 32 | 61 | 3.21 | 302.2 | 373.7 |
| cpu | 1 | 128 | 151 | 1.44 | 621.5 | 956.1 |
| cpu | 8 | 32 | 61 | 3.76 | 2163.9 | 2512.3 |
| cpu | 8 | 128 | 151 | 1.46 | 5563.7 | 5778.2 |
| cpu | 32 | 32 | 61 | 3.15 | 10311.6 | 10893.6 |
| cpu | 32 | 128 | 151 | 1.09 | 29100.6 | 31841.7 |
| gpu | 1 | 32 | 61 | 5.99 | 166.8 | 174.1 |
| gpu | 1 | 128 | 151 | 3.05 | 322.6 | 365.2 |
| gpu | 8 | 32 | 61 | 17.52 | 445.9 | 500.8 |
| gpu | 8 | 128 | 151 | 6.70 | 1160.4 | 1251.6 |
| gpu | 32 | 32 | 61 | 14.97 | 2102.9 | 2271.9 |
| gpu | 32 | 128 | 151 | 4.24 | 7422.6 | 7995.2 |
| npu | — | — | — | **不可用**（见「设备矩阵」） | — | — |

**怎么读**：

- **GPU 在批大小 ≥ 8 时明显更快**（14.97 vs 3.15 条/秒，4.7 倍）。核显有独立的
  EU 阵列，批量 GEMM 能喂满；CPU 在 6 核上已经是单次预填的吞吐上限。
- **CPU 的批大小收益几乎为零**（3.21 → 3.15）。Q8_0 的 GEMV 在 CPU 上是内存带宽
  受限的，增大批大小不改变要读的权重体积。
- **回填 900 条会话（按每条 151 token 算）**：GPU 约 10 分钟，CPU 约 25 分钟。
  两者都远好于「远程供应商配额」这个约束，但 GPU 是默认推荐。
- **P50 与 P95 的差距小**（< 10%），说明延迟稳定，没有 GC 或线程调度的抖动。

### 一个必须知道的坑：Vulkan 设备可见时 CPU 会退化成单线程

这个构建同时带 CPU 与 Vulkan 后端。`n_gpu_layers=0` 只表示「不把层放到显存」，
ggml 的调度器仍然把 KV cache 与计算缓冲区分配成 Vulkan 的 host 缓冲，而 Vulkan
后端的 host 侧 `graph_compute` 是单线程的。

| 配置 | 并行度（CPU 时间 / 墙钟） | 177 token 预填 |
|---|---:|---:|
| Vulkan 设备可见 | 0.98x | 67 tok/s |
| `GGML_VK_VISIBLE_DEVICES=""` | **4.42x** | **248 tok/s** |

`server.py` 在 `--device cpu` 且重排也在 CPU 时自动设这个环境变量（见
`backends/llama_cpp.py` 的 `hide_vulkan_devices`）。**混合部署（嵌入 CPU + 重排 GPU）
不能这么做**，启动日志会打一条 `warn`。


## 内存与磁盘

| 项 | 体积 | 说明 |
|---|---:|---|
| 两个 GGUF Q8_0 | **1.28 GB** | 639,150,592 B + 639,153,184 B |
| `.venv/` | **470 MB** | 含 `libllama.so` 与 `libggml-cpu.so` / `libggml-vulkan.so` |
| 常驻内存（`--max-seq-len 8192`） | **3.93 GB** | 1.28 GB 权重 + 2×1.5 GB KV cache |
| 常驻内存（`--max-seq-len 2048`） | **2.22 GB** | 同上，KV cache 缩到 1/4 |
| 峰值内存（bench，batch 32） | **4.85 GB** | 一次 4832 token 的预填 |

**KV cache 是大头**：28 层 × 8192 ctx × 8 KV 头 × 128 维 × 2（K+V）× 2 字节
≈ 1.5 GB/模型。**本机只有 9–14GB 可用**，两个模型默认就要 3.9GB——如果同机还有
别的服务，用 `--max-seq-len 2048` 降到 2.2GB。

CPU 占用：`--threads 6` 时推理期间稳定 6 个核（`taskset -c 0-5` 全占满），空闲时
接近 0（没有轮询）。**不要**把 `--threads` 设成 16：那会占满整机，而同机的其它服务
会明显卡顿（这是上一次的事故）。


## 已知限制

- **NPU 不可用。** 本机有 Intel AI Boost NPU（`00:0b.0`，`intel_vpu` 驱动已加载），
  但 llama.cpp 上游没有 NPU 的 ggml backend，`--device npu` 在启动期直接报错。
  要用 NPU 只能换 OpenVINO，而那是另一套分数语义。
- **rerank 的 GGUF 只有 `ggml-org` 那一个仓库是对的。** 社区仓的 Q8_0 是坏转换器
  的产物，服务启动时会校验 `tensor_count == 311`、`pooling_type == RANK(4)`、
  `classifier.output_labels` 含 `yes`/`no`、`tokenizer.chat_template.rerank` 存在，
  任何一条不过就拒绝启动。
- **分数尺度依赖量化档位。** 不同量化档位的 `P(yes)` 分布不同：排序可能相近，
  绝对分数会漂。做阈值过滤时按「阈值怎么标定」重新标定，不要跨档位、跨模型复用
  同一个绝对阈值。
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
