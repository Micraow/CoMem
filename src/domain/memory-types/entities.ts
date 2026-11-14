import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 项目、组织、人物等实体（架构文档 §11.1、§6.5 的 `entities/comem-project.md`）。
 *
 * 一个实体一个文件，用来回答「这个东西是什么」，与 events 的「什么时候发生了什么」区分。
 */
export const entitiesMemoryType = {
  type: 'entities',
  description: '项目、组织、人物、设备与运行环境的稳定描述。设备写明属于谁、哪台机器；远程服务器、容器、当前执行环境与用户主力电脑分别记录，不凭当前工具环境推定个人设备。用户明确纠正同一实体属性时更新原条目，不同设备不得合并。',
  directory: 'memories/entities',
  filename: '{name}.md',
  operationMode: 'upsert',
  fields: [
    { name: 'aliases', type: 'string[]', merge: 'replace', description: '明确、稳定的专有称呼；不能把我的电脑、这台机器等上下文指代或用户、软件、Linux等类别和技术名当作具体设备的别名' },
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
      description: '实体类别：project / organization / person / device / environment',
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
