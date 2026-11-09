/**
 * 内置记忆类型汇总（架构文档 §11.1）。
 *
 * 八个类型不多不少。查找用 `getMemoryType`，不要直接下标：`Record` 的下标会命中原型
 * 链上的 `__proto__` / `constructor`，把模型给的类型名变成任意对象。
 */

import type { MemoryTypeSchema } from '../memory-type.js';
import { entitiesMemoryType } from './entities.js';
import { eventsMemoryType } from './events.js';
import { experiencesMemoryType } from './experiences.js';
import { identityMemoryType } from './identity.js';
import { preferencesMemoryType } from './preferences.js';
import { profileMemoryType } from './profile.js';
import { rulesMemoryType } from './rules.js';
import { soulMemoryType } from './soul.js';

export {
  entitiesMemoryType,
  eventsMemoryType,
  experiencesMemoryType,
  identityMemoryType,
  preferencesMemoryType,
  profileMemoryType,
  rulesMemoryType,
  soulMemoryType,
};

export const BUILTIN_MEMORY_TYPES: Readonly<Record<string, MemoryTypeSchema>> = Object.freeze({
  profile: profileMemoryType,
  preferences: preferencesMemoryType,
  entities: entitiesMemoryType,
  events: eventsMemoryType,
  identity: identityMemoryType,
  soul: soulMemoryType,
  experiences: experiencesMemoryType,
  rules: rulesMemoryType,
});

/**
 * 不参与记忆 TTL 的类型（架构文档 §11.7）。
 *
 * 这四类是**稳定的身份与约束**：`profile` 是用户是谁、`identity` 是 agent 是谁、
 * `soul` 是它遵循的原则、`rules` 是双方约定过的规则。它们会被反复读到，但「没被
 * 读到」不等于「不再重要」——一条过期规则可能整整一个月没有触发场景。让它们跟
 * `events` / `experiences` 一起到期，等于让 agent 忘掉自己是谁、忘掉用户是谁、忘掉
 * 约定，而 TTL 想清掉的是「某时发生的事」这类时效性内容。
 *
 * **硬编码，不做配置。** 这是记忆模型的语义（哪些类型承载身份），不是部署偏好：
 * 把它做成配置只会多一个「配错之后 agent 忘了自己是谁」的入口（`AGENTS.md` §6）。
 * 要调整只能改这里，类型名从各类型的 `type` 字段取，不重复写字符串字面量。
 *
 * 读取方：`NodeRepository.sweepExpired` 把它展开成 SQL 的 `NOT IN` 列表。集合为空会
 * 拼出非法的 `IN ()`，所以这里不允许被过滤成空数组。
 */
export const TTL_EXEMPT_MEMORY_TYPES: readonly string[] = [
  profileMemoryType.type,
  identityMemoryType.type,
  soulMemoryType.type,
  rulesMemoryType.type,
];

export function getMemoryType(type: string): MemoryTypeSchema | undefined {
  return Object.hasOwn(BUILTIN_MEMORY_TYPES, type) ? BUILTIN_MEMORY_TYPES[type] : undefined;
}
