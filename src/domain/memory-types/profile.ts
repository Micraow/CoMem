import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 用户画像（架构文档 §11.1、§6.5 的 `memories/profile.md`）。
 *
 * 单文件类型：整个 scope 只有一条，filename 里没有占位符，identity 只作为
 * 合并时的记录标识。
 */
export const profileMemoryType = {
  type: 'profile',
  description: '用户画像：基本信息、职业与工作方式',
  directory: 'memories',
  filename: 'profile.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'name',
      type: 'string',
      identity: true,
      required: true,
      description: '用户的名字或常用称呼',
    },
    {
      name: 'role',
      type: 'string',
      merge: 'patch',
      description: '职业、岗位或主要角色，如「后端工程师」',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '用户画像正文：基本信息、技术栈与工作方式',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
