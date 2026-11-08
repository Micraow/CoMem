/**
 * 提示词模板（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 三条提示词（六条模板）的静态骨架在仓库的 `prompts/*.md` 里，由
 * `services/prompt-service.ts` 按「仓库默认 < 数据库覆盖」的优先级取用，可以在
 * 控制台查看和修改。
 *
 * 本目录只做**动态部分的渲染**：输入结构化数据，返回 `LlmPrompt`。不读文件、不调
 * 模型、不做 IO——模板取用走 `registry.ts` 的进程级绑定（见那段推导）。
 */

export { buildExtractPrompt, NEW_PAGE_ID_START, type ExtractPage, type ExtractPromptInput } from './extract.js';
export { buildSummaryPrompt, type SummaryPromptInput } from './summarize.js';
export {
  buildRewriteUserPrompt,
  REWRITE_SCHEMA,
  REWRITE_SYSTEM_PROMPT,
  type RewriteMessage,
  type RewriteOutput,
  type RewritePromptInput,
} from './rewrite.js';
