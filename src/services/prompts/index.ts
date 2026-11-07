/**
 * 提示词模板（架构文档 §9.2、§11.3、§11.4）。
 *
 * 三个文件都是纯函数：输入结构化数据，返回 `LlmPrompt`。不读文件、不调模型、
 * 不做 IO——这样模板可以逐片段断言，不需要起一个真实的 LLM。
 */

export { buildExtractPrompt, NEW_PAGE_ID_START, type ExtractPage, type ExtractPromptInput } from './extract.js';
export { buildSummaryPrompt, type SummaryPromptInput } from './summarize.js';
