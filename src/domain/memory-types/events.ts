import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 决策与里程碑（架构文档 §11.1 的 `events`，`addOnly`）。
 *
 * 事件是「某时发生了什么」，发生之后不会改变，因此只允许新增：合并时不会产出
 * 更新操作，content 与 occurredAt 都是 `immutable`。
 * 文件名形如 `2026-11-05-architecture-decision.md`（§6.5）。
 */
export const eventsMemoryType = {
  type: 'events',
  description: [
    '某个时间真实发生的事件、决定、承诺、进展或结果。',
    '只记录发生本身与当时必要的背景，不把方案草稿、解题步骤、完整执行过程或可复用做法写成事件。',
    '具体任务的尝试、参数、失败分支与结果归 `cases`；跨案例抽象归 `experiences`。',
  ].join('\n'),
  directory: 'memories/events',
  filename: '{event}.md',
  operationMode: 'addOnly',
  fields: [
    {
      name: 'event',
      type: 'string',
      identity: true,
      required: true,
      description: '事件标识，形如 2026-11-05-architecture-decision',
    },
    {
      name: 'occurredAt',
      type: 'string',
      merge: 'immutable',
      description: '事件发生时间，ISO 8601 时间串',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'immutable',
      description: '事件正文：决策内容、里程碑与当时的依据',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
