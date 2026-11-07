import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 核心原则（架构文档 §11.1、§6.5 的 `memories/soul.md`）。
 *
 * 不可违背的价值观与决策准则。与 `rules` 的区别：`soul` 是「为什么这样做」的
 * 底层原则，`rules` 是「具体场景下必须做什么」的可执行约束。单文件类型。
 */
export const soulMemoryType = {
  type: 'soul',
  description: '核心原则：不可违背的价值观与决策准则',
  directory: 'memories',
  filename: 'soul.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'name',
      type: 'string',
      identity: true,
      required: true,
      description: '记忆主体的名字，用来确认这条原则属于谁',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '核心原则正文：不可违背的价值观与决策准则',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
