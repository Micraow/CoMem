#!/usr/bin/env bash
#
# `pnpm dev`：同时起后端与控制台。
#
# 两个进程生命周期绑在一起——关掉一个另一个也必须停，否则再跑一次会撞端口
# （EADDRINUSE），而报错信息指向的是「端口被占用」不是「上次没关干净」。
#
# `set -m` 让后台 job 各自成为进程组。清理时只终止这两个子进程组，避免
# `pnpm` 自身的多层子进程留下孤儿，也不会向启动脚本的父 shell 发信号。

set -euo pipefail
set -m

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_PORT="$(
  node --import tsx --input-type=module -e '
    import { loadConfig } from "./src/config/index.ts";
    process.stdout.write(String(loadConfig({ argv: process.argv.slice(1) }).server.port));
  ' -- "$@"
)"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
WEB_PORT="${COMEM_WEB_PORT:-3081}"
BACKEND_PID=""
WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$WEB_PID" ]; then
    kill -TERM -- "-$WEB_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ]; then
    kill -TERM -- "-$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "$WEB_PID" ]; then
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ]; then
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_is_available() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen({ host: "127.0.0.1", port: Number(process.argv[1]), exclusive: true }, () => {
      server.close(() => process.exit(0));
    });
  ' -- "$1"
}

if [ "$BACKEND_PORT" = "$WEB_PORT" ]; then
  echo "错误：后端和控制台不能使用同一个端口。请用 COMEM_WEB_PORT 指定控制台端口。" >&2
  exit 1
fi

for port in "$BACKEND_PORT" "$WEB_PORT"; do
  if ! port_is_available "$port"; then
    echo "错误：端口 ${port} 不可用；请换端口后重试。" >&2
    exit 1
  fi
done

echo "==> 后端 ${BACKEND_URL}"
pnpm dev:server "$@" &
BACKEND_PID=$!

# 等后端完成启动和数据库迁移，再启动控制台。
echo "==> 等待后端就绪"
READY=0
for _ in $(seq 1 120); do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "" >&2
    echo "错误：后端进程已退出，无法启动控制台。" >&2
    echo "      具体原因见上面的后端日志。" >&2
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

echo "==> 控制台 http://127.0.0.1:${WEB_PORT}"
# 把端口传给控制台的 devProxy：两边必须指向同一个后端。
COMEM_SERVER_PORT="$BACKEND_PORT" pnpm --dir web exec nuxt dev --host 127.0.0.1 --port "$WEB_PORT" &
WEB_PID=$!

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

echo "错误：开发进程意外退出。" >&2
exit 1
