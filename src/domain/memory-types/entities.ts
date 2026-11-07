import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 项目、组织、人物等实体（架构文档 §11.1、§6.5 的 `entities/comem-project.md`）。
 *
 * 一个实体一个文件，用来回答「这个东西是什么」，与 events 的「什么时候发生了什么」区分。
 */
export const entitiesMemoryType = {
  type: 'entities',
  description: '项目、组织、人物等实体的稳定描述',
  directory: 'memories/entities',
  filename: '{name}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'name',
      type: 'string',
      identity: true,
      required: true,
      description: '实体名，小写短横线，如 comem-project',
    },
    {
      name: 'kind',
      type: 'string',
      merge: 'replace',
      description: '实体类别：project / organization / person',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '实体说明：它是什么、和用户的关系、关键事实',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
