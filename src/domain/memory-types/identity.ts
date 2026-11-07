import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 代理的身份设定（架构文档 §11.1、§6.5 的 `memories/identity.md`）。
 *
 * 与 `profile` 的区别：`profile` 描述用户，`identity` 描述「这个 agent 是谁」——
 * 名字、职责、语气与能力边界。单文件类型。
 */
export const identityMemoryType = {
  type: 'identity',
  description: '代理的身份设定：名字、职责与能力边界',
  directory: 'memories',
  filename: 'identity.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'name',
      type: 'string',
      identity: true,
      required: true,
      description: '代理的名字或称呼',
    },
    {
      name: 'purpose',
      type: 'string',
      merge: 'patch',
      description: '这个代理存在的目的与服务对象',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '身份设定正文：职责、语气与能力边界',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
