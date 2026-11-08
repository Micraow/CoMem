# CoMem 生产镜像。
#
# 默认目标是**核心镜像**：没有本地推理（llama.cpp / Vulkan / Mesa / Python），
# 适合绝大多数「嵌入走远程 OpenAI 兼容 API」的部署。本地推理是显式 target：
#
#   docker build -t comem:local .                                     # 核心（默认）
#   docker build --target inference-runtime -t comem:local-inference . # 核心 + 本地推理
#
# 阶段划分：
#   base        node 24 + ca-certificates（两个运行期镜像的共同底座）
#   deps        pnpm + 完整 Node 依赖（含 devDependencies，构建要它们）
#   build       typecheck + 配置自检 + 控制台构建 + `pnpm build`（dist/）
#   test        lint + unit/integration + integrations 测试（只在 --target test 时构建）
#   prod-deps   把 deps 的依赖树裁成生产子集
#   inference   源码编译 llama-cpp-python（CPU + Vulkan），与 CoMem 源码无关
#   core        核心运行时：dist + 生产 node_modules + prompts + integrations + web/.output
#   inference-runtime  core + 推理 venv / Python / Vulkan 运行库
#   runtime     默认目标，等于 core（放在最后，`docker build .` 产出核心镜像）
#
# 为什么生产跑 dist/ 而不是 tsx：`tsx` 会把 TypeScript（esbuild）带进运行镜像，
# 实测 123MB，而它只省掉一次 `tsc`（1.9 秒）。`pnpm build` 用单独的
# tsconfig.build.json 产出 dist/，`start` 就是 `node dist/bootstrap/main.js`。
#
# 为什么是 node:24 而不是 22：engines.node >= 22.5.0 是硬下限（node:sqlite），
# 24 是当前 LTS 且 node:sqlite / node:test / fetch 都稳定。镜像标签固定到
# 次版本（bookworm-slim），不用 latest。
#
# 不换 alpine：`sqlite-vec` 是 glibc 原生扩展，musl 上要重编译；`node:sqlite`
# 的行为也不同。省下的约 100MB 不值得引入一整个平台的差异。

# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- base：Node 运行时 + 根证书 ----------
FROM ${NODE_IMAGE} AS base

# ca-certificates 必须装：node:24-bookworm-slim 不带 /etc/ssl/certs，
# 模型供应商的 HTTPS 请求会以 UNABLE_TO_VERIFY_LEAF_SIGNATURE 失败，而错误
# 只在第一次调用 LLM 时出现（启动、/health、全部离线路径都正常）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 控制台的 Nuxt 构建在 deps/build 阶段跑；运行期只是复制产物。
ENV NUXT_TELEMETRY_DISABLED=1

WORKDIR /app

# ---------- deps：pnpm + 完整依赖（层缓存只依赖 lockfile） ----------
FROM base AS deps

# pnpm 只装到构建链上：运行镜像用 `node dist/...` 启动，不需要包管理器。
# 版本固定，镜像可复现，不随 latest 漂移。
ARG PNPM_VERSION=12.17.0
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

# 后端与控制台是**两个独立的 pnpm 包**：根 pnpm-workspace.yaml 只有 allowBuilds，
# 没有 packages 字段；web/ 自带 package.json + pnpm-lock.yaml + pnpm-workspace.yaml。
# 所以两次 install，不能一条命令装完。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/

# 依赖宿主机挂的 pnpm store 缓存：改源码不会重装，换 lockfile 才重装。
RUN --mount=type=cache,id=comem-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN --mount=type=cache,id=comem-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --dir web

# ---------- build：类型检查 + 配置自检 + 控制台 + 后端产物 ----------
FROM deps AS build

# 源码放在依赖之后：改一行源码只重跑这一层，依赖层命中缓存。
COPY . .

# 类型门禁与配置自检必须在镜像里也能过——否则「镜像能起」不代表「代码是合法的」。
RUN pnpm typecheck \
 && pnpm check:config

# 控制台：Nuxt 3 独立构建，产物在 web/.output（自包含，含 server/node_modules）。
RUN pnpm --dir web build

# 后端：tsc 出 dist/（`start` 指向 dist/bootstrap/main.js）。SQL 迁移文件由
# scripts/copy-build-assets.mjs 一起复制——`database.ts` 用 import.meta.url 定位。
RUN pnpm build

# 断言：sqlite-vec 的平台预编译包必须在产物里——它是可选依赖，装漏了
# `vec0` 虚拟表会在第一次向量检索时报 "no such module"。
RUN test -f "$(node -p "require('sqlite-vec').getLoadablePath()")" \
 || (echo "缺少 sqlite-vec 平台预编译包（getLoadablePath() 指向的 .so 不存在）" >&2; exit 1)

# 断言：入口与迁移文件在 dist 里。少了任何一个，镜像都能构建成功但起不来。
RUN test -f dist/bootstrap/main.js \
 && test -d dist/adapters/sqlite/migrations \
 || (echo "dist 产物不完整：缺少 bootstrap/main.js 或 SQL 迁移目录" >&2; exit 1)

# ---------- test：只在验证/CI 里构建 ----------
# 生产镜像不带 vitest / eslint（见 prod-deps）。全量门禁在这个阶段跑，它与
# runtime 共用 base（同一个 Node、同一个 sqlite-vec 预编译包）。
FROM build AS test
RUN pnpm lint \
 && pnpm test \
 && pnpm test:integrations

# ---------- inference：源码编译 llama-cpp-python（CPU + Vulkan） ----------
#
# 这一层**不 COPY 任何 CoMem 源码**：改一行 TypeScript 不会重编 llama.cpp。
# 依赖只有本阶段的 apt 包与 pip 版本，缓存键与源码无关。
#
# 用 python:3.12 而不是 Debian 自带的 3.11：`local-inference/pyproject.toml` 钉
# `requires-python >=3.12,<3.13`，且 3.14 上 llama-cpp-python 的源码编译会撞
# CPython 内部头文件变更。
FROM python:3.12-slim-bookworm AS inference

# 可移植性开关：
#   0（默认）= GGML_NATIVE=ON：按构建机 CPU 指令集编译，最快。前提是「在目标机
#               上 docker build」，编译机与运行机同一台。
#   1         = GGML_CPU_ALL_VARIANTS=ON：编出多套 ISA 变体，运行期按 CPU 选择。
#               在 CI 里构建再分发到不同 CPU 的机器上时必须打开，否则部署机
#               执行到 AVX-512 指令会 SIGILL。
#
#               **必须同时开 GGML_BACKEND_DL=ON**，否则 llama.cpp 在配置阶段
#               直接拒绝：
#                 CMake Error at ggml/src/CMakeLists.txt:489 (message):
#                   GGML_CPU_ALL_VARIANTS requires GGML_BACKEND_DL
#               多变体是「后端以 .so 动态加载」的另一种形态，两者是绑定的。
ARG COMEM_PORTABLE_CPU=0
ARG LLAMA_CPP_PYTHON_VERSION=0.3.36

# Debian 12（bookworm）的包名，和 README 里 Arch 的 vulkan-headers /
# spirv-headers / shaderc 不是同一套。已用 `apt-cache show` 逐个确认存在：
#   libvulkan-dev      Vulkan 头文件 + libvulkan.so（CMake find_package(Vulkan)）
#   glslc              shaderc 的着色器编译器，llama.cpp 的 Vulkan 后端在
#                      构建期调用它编译 .comp 着色器
#   glslang-tools      glslangValidator（Vulkan shader 校验）
#   spirv-headers      SPIRV-Headers 的 CMake 配置文件
#   cmake / ninja-build / build-essential  scikit-build-core 的构建工具链
# 装完在同一层删 apt 缓存（`rm -rf /var/lib/apt/lists/*`）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git pkg-config \
      libvulkan-dev glslc glslang-tools spirv-headers \
 && rm -rf /var/lib/apt/lists/*

# **bookworm 的 Vulkan 头文件太旧。** Debian 12 的 libvulkan-dev 是 1.3.239，
# 而 llama-cpp-python 0.3.36 vendor 的 llama.cpp 用了 VK_EXT_layer_settings
# （`vk::LayerSettingEXT`，Vulkan-Headers 1.3.263 起才有）。用系统头文件编译
# 会在 ggml-vulkan.cpp 报一屏 `'LayerSettingEXT' is not a member of 'vk'`。
#
# 只换头文件、不换 loader：Vulkan 1.0 起 ABI 稳定，llama.cpp 用到的入口
# 1.3.239 的 libvulkan.so 都导出。头文件版本钉死，构建可复现。
ARG VULKAN_HEADERS_VERSION=v1.4.368
RUN git clone --depth 1 --branch "${VULKAN_HEADERS_VERSION}" \
      https://github.com/KhronosGroup/Vulkan-Headers /opt/vulkan-headers

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VIRTUAL_ENV=/opt/comem-inference/.venv \
    PATH=/opt/comem-inference/.venv/bin:$PATH

RUN python -m venv "$VIRTUAL_ENV"

# 并行度取 6（README 的 `CMAKE_BUILD_PARALLEL_LEVEL=6`）：16 核全开会同时跑
# 16 个 g++ 实例，llama.cpp 的 Vulkan 后端在模板展开阶段能吃掉 10GB 以上。
RUN if [ "${COMEM_PORTABLE_CPU}" = "1" ]; then \
      export CMAKE_ARGS="-DGGML_VULKAN=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DVulkan_INCLUDE_DIR=/opt/vulkan-headers/include"; \
    else \
      export CMAKE_ARGS="-DGGML_VULKAN=ON -DGGML_NATIVE=ON -DVulkan_INCLUDE_DIR=/opt/vulkan-headers/include"; \
    fi; \
    export CMAKE_BUILD_PARALLEL_LEVEL=6; \
    echo "CMAKE_ARGS=${CMAKE_ARGS}"; \
    pip install --no-cache-dir --no-binary llama-cpp-python \
      "llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}"

# 纯 wheel 依赖（README「其余依赖」）。fastapi / uvicorn / pydantic 不打模型。
# 同时把解析结果冻成 requirements.lock 放进镜像：local-inference 没有 lockfile，
# 至少让「这个镜像里装的是哪几个版本」可查。
RUN pip install --no-cache-dir \
      "fastapi>=0.115" \
      "uvicorn[standard]>=0.34" \
      "pydantic>=2.9" \
 && pip freeze > /opt/comem-inference/requirements.lock

# 验证 Vulkan 后端真的编进去了。
#
# **不能用 `llama_supports_gpu_offload()`**：它在构建容器里返回 false——构建
# 容器没有 `--device /dev/dri`，Vulkan loader 找不到物理设备，ggml 的 GPU 设备
# 列表为空。这个断言会误报「没编入 Vulkan」，而实际编入了。构建期只能证明
# 「后端库在包里」；设备可见性在运行期用 `vulkaninfo` + `--device gpu` 验证。
RUN python - <<'PY'
import os
import pathlib
import shutil

import llama_cpp

package = pathlib.Path(llama_cpp.__file__).resolve().parent
libs = sorted(path.name for path in package.rglob("libggml-*.so"))
print("ggml backends:", libs)
assert any("vulkan" in name for name in libs), f"没有编入 Vulkan 后端：{libs}"

# 可移植构建的 CPU 变体在 `site-packages/bin/`（scikit-build 的 runtime 目录），
# 不在包目录里。ggml 的 `ggml_backend_load_all()` 只扫「可执行文件所在目录」，
# 而 venv 的 python 是 /usr/local/bin/python3.12 的符号链接，`/proc/self/exe`
# 解析到 /usr/local/bin。所以变体要放到 /usr/local/bin，构建期先收进
# /opt/comem-inference/backends/cpu，由运行期阶段 COPY 过去。
backends = pathlib.Path("/opt/comem-inference/backends")
(backends / "cpu").mkdir(parents=True, exist_ok=True)
variants = sorted(pathlib.Path(package.parent / "bin").glob("libggml-cpu-*.so"))
for variant in variants:
    shutil.copy2(variant, backends / "cpu" / variant.name)
print("cpu variants:", [variant.name for variant in variants])
if not variants:
    assert os.environ.get("COMEM_PORTABLE_CPU") != "1", "可移植构建没有产出 CPU 变体"

# Vulkan 走另一条路：`ggml_backend_load_best("vulkan")` 只认
# `libggml-vulkan-<变体>.so` 前缀、并且要 `ggml_backend_score` 符号（Vulkan 没
# 导出），所以 DL 构建里它永远不会被自动扫到。用 `GGML_BACKEND_PATH` 直接指定
# 这一个文件（该变量收的是文件路径，不是目录）。符号链接，不复制 60MB。
(backends / "libggml-vulkan.so").unlink(missing_ok=True)
(backends / "libggml-vulkan.so").symlink_to(package / "lib" / "libggml-vulkan.so")

pathlib.Path("/opt/comem-inference/ggml-backends.txt").write_text(
    "\n".join(libs + [f"backends/cpu/{variant.name}" for variant in variants]) + "\n"
)
PY

# ---------- prod-deps：生产依赖子集 ----------
FROM deps AS prod-deps

# 先装完整依赖再裁剪，而不是在 runtime 里重新 `pnpm install --prod`：
# 后者要么再打一次网络、要么把 store 挂进来，构建时间翻倍；prune 只改
# node_modules，105ms 完成。
#
# `pnpm prune --prod` 保留 dependencies 的传递闭包（fastify / ai / zod / yaml /
# sqlite-vec-<platform>），删掉 devDependencies（typescript / eslint / vitest / tsx）。
RUN pnpm prune --prod

# ---------- core：核心运行时（默认镜像） ----------
FROM base AS core

# 生产形态给 node 看的开关。NODE_ENV=production 必须在这里设，不能设在 base：
# 否则 deps 阶段的 `pnpm install` 会跳过 devDependencies，nuxt / vitest 全装不上。
ENV NODE_ENV=production \
    COMEM_SERVER_HOST=0.0.0.0

# 数据根（架构文档 §6.5：容器里固定 /var/lib/comem）。
# 宿主挂匿名卷 / 命名卷时，Docker 从这里继承属主；bind mount 需要宿主自己 chown。
RUN mkdir -p /var/lib/comem \
 && chown node:node /var/lib/comem

# 生产依赖（符号链接结构原样复制）。tsx / typescript / vitest 已被 prune 掉。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# 运行时要读的仓库文件。config.yaml 不在镜像里：它是部署方的配置，靠挂载提供。
# package.json 必须留着：`"type": "module"` 决定 dist/ 按 ESM 解析。
COPY --from=build --chown=node:node \
     /app/package.json \
     /app/config.example.yaml \
     ./
# 后端产物：dist/ 由 `pnpm build` 生成（含复制过去的 SQL 迁移）。
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prompts ./prompts
# 宿主 Hook 插件是纯 .mjs，不 import src/，独立复制。
COPY --from=build --chown=node:node /app/integrations ./integrations
COPY --from=build --chown=node:node /app/web/.output ./web/.output

# 入口脚本只有 exec 一行：把 PID 1 让给 node，信号才能到进程。
# 写成文件是为了让 `ENTRYPOINT` + `CMD` 分离，同时允许
#   docker run comem:local node dist/commands/ingest.js --source all
# 这种「整体替换命令」的用法。
RUN printf '%s\n' '#!/bin/sh' 'set -e' 'exec "$@"' > /usr/local/bin/comem-entrypoint \
 && chmod 0755 /usr/local/bin/comem-entrypoint

USER node

# 实际默认端口（config.schema.ts 的 server.port 默认 1933）。改端口用
# `-e COMEM_SERVER_PORT=...` 或挂载配置，EXPOSE 只是元数据。
EXPOSE 1933

# 端口从「服务实际读到的配置」推导，不硬编码：
#   1. /proc/1/cmdline 里的 --config（默认 CMD 传的就是它）
#   2. 没有 --config 时回落到 /app/config.yaml（loadConfig 的默认路径）
#   3. 环境变量 COMEM_SERVER_PORT / COMEM_SERVER_HOST 覆盖（与 loadConfig 的
#      优先级一致：CLI > env > 文件 > 默认值）
# 监听 0.0.0.0 / :: 时探 127.0.0.1。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "import fs from 'node:fs';import { createRequire } from 'node:module';const require = createRequire('/app/package.json');const parse = require('yaml').parse;const argv = fs.existsSync('/proc/1/cmdline') ? fs.readFileSync('/proc/1/cmdline', 'utf8').split('\\0') : [];const i = argv.indexOf('--config');const cfg = i >= 0 && argv[i + 1] ? argv[i + 1] : '/app/config.yaml';let port = 1933;let host = '127.0.0.1';try { const c = parse(fs.readFileSync(cfg, 'utf8')); port = c?.server?.port ?? port; host = c?.server?.host ?? host; } catch {}if (process.env.COMEM_SERVER_PORT) port = Number(process.env.COMEM_SERVER_PORT);if (process.env.COMEM_SERVER_HOST) host = process.env.COMEM_SERVER_HOST;if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });process.exit(res.ok ? 0 : 1);"]

# 默认命令：跑服务端。`--config` 指向的文件可以不存在（loadConfig 把
# 「文件不存在」当默认值），挂载进来就生效。
ENTRYPOINT ["/usr/local/bin/comem-entrypoint"]
CMD ["node", "dist/bootstrap/main.js", "--config", "/etc/comem/config.yaml"]

# ---------- inference-runtime：core + 本地推理运行时 ----------
#
# 只有需要在容器里跑 embedding / rerank（llama.cpp）时才构建这个目标。
# 多出来的 647MB 全是推理：Mesa + Vulkan + Python + venv。
FROM core AS inference-runtime

# 这个镜像有两种用法：默认 CMD 跑 Node 后端，compose / 文档里覆盖成 Python 推理
# 服务。core 的 HEALTHCHECK 探的是 1933，对 Python 进程会一直报 unhealthy。
# 关掉内置探活，由 compose 的 inference 服务定义 8089 的探活；单独 `docker run`
# 时如果要探活，用 `--health-cmd` 自己加。
HEALTHCHECK NONE

USER root

# 运行期依赖：
#   libvulkan1       Vulkan loader（--device /dev/dri 用）
#   mesa-vulkan-drivers  Intel / AMD 的 Vulkan ICD（容器里没有它就看得到
#                    loader、看不到物理设备）
#   vulkan-tools     vulkaninfo，排查「GPU 设备可见吗」用
#   libgomp1         llama.cpp CPU 后端的 OpenMP 运行时
#
# **Mesa 必须用 bookworm-backports。** Debian 12 自带的 Mesa 22.3.6 不认识
# Intel Arc（ARL，PCI ID 0x7d51）：
#   MESA: warning: Driver does not support the 0x7d51 PCI ID.
#   ERROR: [anv_device.c:848] Code 0 : VK_ERROR_INCOMPATIBLE_DRIVER
#   Devices:（空）
# 22.3.6 的 ICD 只覆盖到 DG2/ADL，ARL 的 PCI ID 是 Mesa 24 之后才加的。
# backports 的 25.0.7 能枚举到 `Intel(R) Graphics (ARL)`。
#
# Python 解释器是从 `python:3.12-slim-bookworm` 复制过来的，**扩展模块的动态库
# 依赖要自己补**：node 的镜像里没有 libsqlite3 / libncursesw / libreadline 这些。
# 漏了 libsqlite3-0 时 `import sqlite3`（llama_cpp 的依赖链会走到）会报
#   ImportError: libsqlite3.so.0: cannot open shared object file
# 这些都是几十 KB 到几 MB 的运行时库；tkinter 用的 libtk / libtcl 不装
# （服务不 import tkinter）。
#
# 装完删掉 backports 源，避免运行期被 `apt upgrade` 意外跨版本升级。
RUN echo 'deb http://deb.debian.org/debian bookworm-backports main' \
      > /etc/apt/sources.list.d/bookworm-backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers/bookworm-backports vulkan-tools libgomp1 \
      libsqlite3-0 libncursesw6 libgdbm6 libnsl2 libtirpc3 libreadline8 \
 && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/bookworm-backports.list

# 本地推理：源码 + 编译好的 venv。模型权重（1.28GB）不进镜像，运行时挂到 /models。
# Python 3.12 的解释器从 inference 阶段复制：Debian 12 自带的 3.11 不满足
# pyproject 的 requires-python，而且换解释器版本会让 venv 里的 .so 对不上。
COPY --from=build --chown=node:node /app/local-inference ./local-inference
COPY --from=inference /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=inference /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=inference /usr/local/bin/python /usr/local/bin/python
COPY --from=inference /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=inference /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=inference /opt/comem-inference /opt/comem-inference
# 可移植构建的 CPU 变体：ggml 按「可执行文件所在目录」扫描后端 .so，而 venv 的
# python 指向 /usr/local/bin/python3.12。native 构建这里是空目录，COPY 不产生文件。
COPY --from=inference /opt/comem-inference/backends/cpu/ /usr/local/bin/
RUN ldconfig

# GGML_BACKEND_PATH 指向本地推理的 Vulkan 后端：DL 构建里 ggml 不会自动扫到它
# （见 inference 阶段的说明）。指向符号链接；native 构建里这个 .so 已经作为依赖
# 载入，再 dlopen 一次是幂等的。
ENV GGML_BACKEND_PATH=/opt/comem-inference/backends/libggml-vulkan.so \
    PYTHONDONTWRITEBYTECODE=1

USER node

# ---------- runtime：默认目标，等于 core ----------
# 单独一个阶段是为了让默认 target 落在核心镜像上：`docker build .` 不带
# --target 时构建最后一个阶段。推理镜像用 `--target inference-runtime`。
FROM core AS runtime
