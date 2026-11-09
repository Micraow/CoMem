import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 从执行结果蒸馏的经验（架构文档 §11.1、§6.5 的 `experiences/monorepo-migration.md`）。
 *
 * 走「复核闸门」：写 experiences 的是阶段二第 5 步 `experience_distill`（§10.1），
 * 它读本次会话与已有经验后整段重写该 topic 的正文，写入后 `status = 'pending'`，
 * 人工通过后才进检索（§11.6）。一个话题一个文件；`content` 的 `merge: 'patch'`
 * 只描述抽取路径的字段级语义，归纳路径由服务端在 `upsertMemory` 的锁内整段覆盖。
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
