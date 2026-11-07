import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 按话题拆分的偏好似记忆（架构文档 §11.1 的示例、§6.6 的 `preferences/code-style.md`）。
 *
 * 一个话题一个文件，identity 值就是文件名主干。
 */
export const preferencesMemoryType = {
  type: 'preferences',
  description: '用户在某个话题上的偏好',
  directory: 'memories/preferences',
  filename: '{topic}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'topic',
      type: 'string',
      identity: true,
      required: true,
      description: '偏好所属话题，小写短横线，如 code-style',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '偏好内容，一句话说清「用户偏好什么」',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
