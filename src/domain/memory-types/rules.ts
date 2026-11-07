import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 必须遵守的规则（架构文档 §11.1、§6.5 的 `rules/license-review/must-locate-license.md`）。
 *
 * 与 `experiences` 一样走复核闸门（§11.6）。§6.5 的示例在 `rules/` 下还有一层场景
 * 目录（`license-review/`），所以文件名模板是两段：场景决定目录，规则决定文件名。
 * 场景目录自己也有 `.abstract.md` / `.overview.md`，检索时按场景收窄。
 */
export const rulesMemoryType = {
  type: 'rules',
  description: '必须遵守的约束与触发条件',
  directory: 'memories/rules',
  filename: '{scenario}/{rule}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'scenario',
      type: 'string',
      identity: true,
      required: true,
      description: '规则所属场景，小写短横线，如 license-review',
    },
    {
      name: 'rule',
      type: 'string',
      identity: true,
      required: true,
      description: '规则标识，小写短横线，如 must-locate-license',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '规则正文：在什么场景下必须做什么，以及判断依据',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
