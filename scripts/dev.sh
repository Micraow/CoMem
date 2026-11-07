#!/usr/bin/env bash
#
# `pnpm dev`：同时起后端与控制台。
#
# 两个进程生命周期绑在一起——关掉一个另一个也必须停，否则再跑一次会撞端口
# （EADDRINUSE），而报错信息指向的是「端口被占用」不是「上次没关干净」。
#
# 用 `kill 0` 杀整个进程组而不是杀 `$!`：`pnpm dev:server` 自己会 fork 出
# `tsx` 子进程，只杀父进程会留下孤儿占着端口。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_PORT="${COMEM_SERVER_PORT:-1933}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
BACKEND_PID=""

cleanup() {
  # 负号 = 整个进程组。忽略失败：进程可能已经自己退出了。
  kill -- -$$ 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> 后端 ${BACKEND_URL}"
pnpm dev:server &
BACKEND_PID=$!

# 等后端把数据库迁移跑完再起控制台。
#
# **必须同时确认两件事**：进程还活着，且 `/health` 返回的是**我们的**服务。
# 只看进程存活不够——端口被别的服务占着时 `listen` 会失败，但控制台照样能起来，
# 然后 `devProxy` 把请求转发给那个陌生服务。用户在控制台里看到的是一份别人的
# 数据，而且没有任何报错。
echo "==> 等待后端就绪"
READY=0
for _ in $(seq 1 120); do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "" >&2
    echo "错误：后端进程已退出，无法启动控制台。" >&2
    echo "      常见原因是 ${BACKEND_PORT} 端口被别的服务占用（EADDRINUSE）。" >&2
    echo "      换个端口：COMEM_SERVER_PORT=1934 pnpm dev" >&2
    exit 1
  fi

  # 只认 CoMem 的封套：`{"status":"ok","result":{...}}`。别的服务可能也返回 200。
  if curl -sf -m 1 "${BACKEND_URL}/health" 2>/dev/null | grep -q '"result"'; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  echo "" >&2
  echo "错误：后端 60 秒内没有就绪（${BACKEND_URL}/health）。" >&2
  echo "      看后端日志确认是启动失败还是启动太慢。" >&2
  exit 1
fi

echo "==> 控制台 http://127.0.0.1:3081"
# 把端口传给控制台的 devProxy：两边必须指向同一个后端。
COMEM_SERVER_PORT="$BACKEND_PORT" pnpm dev:web
