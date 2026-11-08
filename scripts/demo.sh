#!/usr/bin/env bash
#
# CoMem 演示脚本（架构文档 §20 的六条核心链路）。
#
# 一条命令跑完全流程：写记忆 → 目录级检索 → 会话归档 → 归档产物 → 复核闸门 →
# 摘要生成 → ACL。用临时数据根，不碰 `~/.local/share/comem` 里的真实数据。
#
# 用法：
#   bash scripts/demo.sh                # 默认 127.0.0.1:19330
#   COMEM_DEMO_PORT=19331 bash scripts/demo.sh
#
# 依赖：Node ≥ 22.5（`node:sqlite`）与仓库里已安装的 devDependencies（`tsx`）。
# 先跑过 `pnpm install`。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_ROOT="${COMEM_DEMO_ROOT:-/tmp/comem-demo}"
DEMO_PORT="${COMEM_DEMO_PORT:-19330}"
BASE_URL="http://127.0.0.1:${DEMO_PORT}"
NODE_BIN="${NODE_BIN:-node}"

# ── 前置检查 ──────────────────────────────────────────────────────────────

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node ≥ 22.5。" >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低：$NODE_VERSION。需要 ≥ 22.5（node:sqlite）。" >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules/tsx" ]; then
  echo "缺少 tsx：先在仓库根目录跑 pnpm install。" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "缺少 curl：结尾的健康检查用它取原始 JSON。" >&2
  exit 1
fi

# 只清理 /tmp 下的演示目录。`rm -rf` 的目标必须显式确认过，不能是拼出来的任意路径。
case "$DEMO_ROOT" in
  /tmp/*) ;;
  *)
    echo "拒绝清理非 /tmp 目录：$DEMO_ROOT（用 COMEM_DEMO_ROOT 指定一个 /tmp 下的路径）。" >&2
    exit 1
    ;;
esac

# JSON 美化：jq 优先，没有就退到 python3，再没有就原样输出。
pretty() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool
  else
    cat
  fi
}

# ── 启动与清理 ────────────────────────────────────────────────────────────

SERVER_PID=""

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    echo "服务已停止（pid ${SERVER_PID}）。"
  fi
  exit "$status"
}

trap cleanup EXIT INT TERM

rm -rf "$DEMO_ROOT"
mkdir -p "$DEMO_ROOT/data"

# 演示配置。
#
# **没有「离线提供者」这种假东西。** 有模型凭据就跑真实抽取，没有就把 `generator`
# 降成 `rule` 并明确告诉用户「阶段二需要模型」——不拿空结果冒充成功。
LLM_KEY="${COMEM_LLM_KEY:-}"
LLM_BASE_URL="${COMEM_LLM_BASE_URL:-http://127.0.0.1:3425/v1}"
LLM_MODEL="${COMEM_LLM_MODEL:-comate/600085158/xiaomi/mimo-v2.6-flash//public}"

if [ -n "$LLM_KEY" ]; then
  SUMMARY_GENERATOR=llm
  PROVIDERS_BLOCK="providers:
  llm:
    default:
      type: openai-compatible
      baseUrl: ${LLM_BASE_URL}
      model: ${LLM_MODEL}
      apiKey: ${LLM_KEY}
      maxTokens: 32768
      timeoutSeconds: 120"
else
  SUMMARY_GENERATOR=rule
  PROVIDERS_BLOCK="# 没有 COMEM_LLM_KEY，阶段二会失败重试后进死信。摘要降级成规则生成。"
fi

cat > "$DEMO_ROOT/config.yaml" <<YAML
dataDir: ${DEMO_ROOT}/data
${PROVIDERS_BLOCK}
summary:
  generator: ${SUMMARY_GENERATOR}
server:
  host: 127.0.0.1
  port: ${DEMO_PORT}
logging:
  level: warn
YAML

echo "CoMem 演示"
echo "  仓库    ${REPO_ROOT}"
echo "  数据根  ${DEMO_ROOT}/data"
echo "  服务    ${BASE_URL}"
echo "  配置    ${DEMO_ROOT}/config.yaml"
echo

# 一个 node 进程，不用 pnpm 包一层：`kill` 打到的是服务本身，不会留下孤儿进程。
"$NODE_BIN" --import tsx "$REPO_ROOT/src/bootstrap/main.ts" --config "$DEMO_ROOT/config.yaml" \
  > "$DEMO_ROOT/server.log" 2>&1 &
SERVER_PID=$!

demo() {
  CO_MEM_LLM_ENABLED="$([ -n "$LLM_KEY" ] && echo 1 || echo 0)" \
    "$NODE_BIN" "$REPO_ROOT/scripts/demo.mjs" "$@" --base-url "$BASE_URL" --root "$DEMO_ROOT"
}

echo "==> 服务就绪"
demo wait-ready --timeout 60000

echo
echo "==> 1/7 写入一条偏好记忆"
demo write-preference

echo
echo "==> 2/7 目录级检索"
demo find --query "TypeScript 严格模式"

echo
echo "==> 3/7 建会话、写消息、提交归档"
demo archive

echo
echo "==> 4/7 看归档产物"
demo show-archive

echo
echo "==> 5/7 通过复核"
demo review

echo
echo "==> 6/7 摘要生成"
demo summary

echo
echo "==> 7/7 ACL"
demo acl

echo
echo "==> 演示完成"
echo "  数据根    ${DEMO_ROOT}/data"
echo "  服务日志  ${DEMO_ROOT}/server.log"
echo "  /metrics  见 ${BASE_URL}/metrics（Prometheus 文本）"
echo
echo "  GET /health（原样 JSON）:"
curl -fsS "${BASE_URL}/health" | pretty | sed 's/^/    /'
echo
echo "重跑：bash scripts/demo.sh"
