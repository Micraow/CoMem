import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 从执行结果蒸馏的经验（架构文档 §11.1、§6.5 的 `experiences/monorepo-migration.md`）。
 *
 * 走「复核闸门」：抽取产出的是 `pending` 记录，人工通过后才进检索（§11.6）。
 * 一个话题一个文件，旧的结论被新经验修正时用 patch 合并。
 */
export const experiencesMemoryType = {
  type: 'experiences',
  description: '从执行结果蒸馏出的经验与教训',
  directory: 'memories/experiences',
  filename: '{topic}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'topic',
      type: 'string',
      identity: true,
      required: true,
      description: '经验归属的话题，小写短横线，如 monorepo-migration',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '经验正文：做对了什么、踩过什么坑、下次怎么做得更好',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
