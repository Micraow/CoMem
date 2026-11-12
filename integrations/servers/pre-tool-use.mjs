#!/usr/bin/env node
/**
 * `PreToolUse`：拦住把 `comem://` 当本地路径的文件工具调用（架构文档 §15.2）。
 *
 * 模型看到 `comem://user/alice/memories/profile.md` 时，第一反应经常是 `Read` 它。
 * 宿主拿到这个路径会报「文件不存在」——错误信息指向的是文件系统，不是「你该用
 * MCP 工具」，模型会开始猜别的路径。这个 hook 把错误信息换成正确的入口。
 *
 * 只拦 `Read` / `Write` / `Edit`（任务书列的三个），且只拦**以 `comem://` 开头**
 * 的路径。普通路径、其它工具、没有路径参数的调用一律放行——旁路 hook 多拦一次，
 * 用户就多一次「工具被莫名其妙拒绝」的体验。
 *
 * Bypass 开关（§8.9）关的是记忆的注入与采集，不是路径守卫：`comem://` 不管开没
 * 开 bypass 都不是本地路径。
 *
 * ## 错误路径必须是「放行」
 *
 * 这个 hook 的判定完全在本地（只看字符串前缀），**不发 HTTP**，所以后端不可达
 * 不会让它变慢，也不会让它改主意。任何内部错误——载荷解析失败、插件配置坏、
 * 进程级异常——都收敛成「没有输出 + 退出码 0」，宿主按「没有决定」处理，工具调用
 * 继续走正常权限流程。`handlePreToolUse` 只会返回 `{deny}` 或 `undefined`，
 * `runHook` 的 catch 分支不会写 stdout，因此不存在「异常 → deny」的路径。
 */

import { resolveHost } from '../lib/config.mjs';
import { isMainModule } from '../lib/is-main.mjs';
import { runMain } from '../lib/lifecycle.mjs';

/** URI 方案（架构文档 §6.1）。 */
const COMEM_SCHEME = 'comem://';

/** 工具名 → 该用的 MCP 工具。只列任务书要求的三个。 */
const MCP_TOOL_FOR = Object.freeze({ Read: 'read', Write: 'write', Edit: 'edit' });

/**
 * 命中返回拦截理由，否则返回 `undefined`（放行）。
 *
 * 理由里给出**下一步该做什么**：只说「不允许」模型会换一个错误的路径重试。
 *
 * @param {{ toolName: string | null, filePath: string | null }} event
 * @returns {{ deny: string } | undefined}
 */
export function handlePreToolUse(event) {
  if (event.filePath === null || !event.filePath.startsWith(COMEM_SCHEME)) {
    return undefined;
  }
  const tool = event.toolName === null ? undefined : MCP_TOOL_FOR[event.toolName];
  if (tool === undefined) {
    return undefined;
  }
  return {
    deny:
      `${event.filePath} 是 CoMem 的 URI，不是本地路径，宿主文件工具读不到它。` +
      `改用 MCP 工具 ${tool}（参数 uri=${event.filePath}）；不知道它对应哪个节点时先用 find 检索。`,
  };
}

/** 直接可执行时走宿主信封；被测试 import 时不执行。 */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  await runMain('hook pre-tool-use', async () => {
    const host = await resolveHost();
    await host.runHook(async (event) => handlePreToolUse(event), { hardExit: true });
  });
}
