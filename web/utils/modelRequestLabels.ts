/**
 * 模型调用用途与状态 → 界面文案。
 *
 * 取值来自 §17.4 和 `/telemetry/llm-calls` 的契约。控制台是独立包，不能 import
 * 后端领域类型，所以这里保留一份闭集；`tests/unit/web/model-request-labels.test.ts`
 * 与 `src/domain/llm.ts` 对拍，后端新增用途时测试失败。
 */
export const LLM_CALL_PURPOSES = [
  'query_rewrite',
  'recall_compression',
  'directory_summary',
  'archive_summary',
  'working_memory',
  'memory_extract',
  'dreamer',
  'config_probe',
  'unspecified',
] as const

export type LlmCallPurpose = (typeof LLM_CALL_PURPOSES)[number]

const PURPOSE_LABEL = {
  query_rewrite: '查询理解',
  recall_compression: '召回压缩',
  directory_summary: '目录摘要',
  archive_summary: '归档摘要',
  working_memory: '会话工作记忆',
  memory_extract: '记忆抽取',
  dreamer: '记忆整理',
  config_probe: '模型连接测试',
  unspecified: '其他调用',
} satisfies Record<LlmCallPurpose, string>

export function llmCallPurposeLabel(purpose: LlmCallPurpose): string {
  return PURPOSE_LABEL[purpose]
}

export const LLM_CALL_KINDS = ['text', 'json'] as const

export type LlmCallKind = (typeof LLM_CALL_KINDS)[number]

export const LLM_CALL_STATUSES = ['success', 'error'] as const

export type LlmCallStatus = (typeof LLM_CALL_STATUSES)[number]

const STATUS_LABEL = {
  success: '成功',
  error: '失败',
} satisfies Record<LlmCallStatus, string>

export function llmCallStatusLabel(status: LlmCallStatus): string {
  return STATUS_LABEL[status]
}

export const LLM_CALL_STATUS_VARIANT = {
  success: 'green',
  error: 'red',
} as const satisfies Record<LlmCallStatus, 'green' | 'red'>
