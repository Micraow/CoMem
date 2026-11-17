import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 按话题拆分的偏好似记忆（架构文档 §11.1 的示例、§6.6 的 `preferences/code-style.md`）。
 *
 * 一个话题一个文件，identity 值就是文件名主干。
 */
export const preferencesMemoryType = {
  type: 'preferences',
  description: [
    '用户跨会话稳定选择的行为习惯、格式、沟通方式、工具或取舍。',
    '只记录用户明确表达或多次确认的「更喜欢怎样」，不要从一次执行推断。',
    '一次题解、具体参数、任务结果和临时限制不是偏好；这些留在 `cases` 或原会话。',
    '现实发生的事件、决定与状态变化属于 `events`，不要写成偏好。',
  ].join('\n'),
  directory: 'memories/preferences',
  filename: '{topic}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'topic',
      type: 'string',
      identity: true,
      required: true,
      description: '稳定的行为或选择维度，小写短横线，如 code-style、answer-format',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '一条可复用的偏好 bullet；保留适用条件、例外和用户明确说过的原因',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
