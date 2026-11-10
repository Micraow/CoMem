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

/**
 * 内置记忆类型的名字，**按控制台与提示词里的展示顺序**。
 *
 * 数组是唯一来源，类型从它派生：`BUILTIN_MEMORY_TYPES` 的键、`TTL_EXEMPT_MEMORY_TYPES`
 * 的成员、`MemoryRecord.memoryType` 的取值都从它来。往数组加一个类型时下面是
 * `Record<MemoryType, MemoryTypeSchema>`，漏写实现即编译错误；反过来（先写联合、
 * 再手抄一份键）漏抄一个键是静默的，`getMemoryType` 会返回 `undefined`。
 */
const BUILTIN_MEMORY_TYPE_NAMES = [
  'profile',
  'preferences',
  'entities',
  'events',
  'identity',
  'soul',
  'experiences',
  'rules',
] as const;

export type MemoryType = (typeof BUILTIN_MEMORY_TYPE_NAMES)[number];

/**
 * 八个内置类型，键必须是 `MemoryType` 的每个成员。
 *
 * 查找用 `getMemoryType`，不要直接下标：`Record` 的下标会命中原型链上的
 * `__proto__` / `constructor`，把模型给的类型名变成任意对象。
 */
export const BUILTIN_MEMORY_TYPES: Readonly<Record<MemoryType, MemoryTypeSchema>> = Object.freeze({
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
 * 要调整只能改这里。成员类型是 `MemoryType`：写错一个名字编译失败，而「键与
 * `type` 字段一致」由 `tests/unit/domain/memory-type.test.ts` 对拍。
 *
 * 读取方：`NodeRepository.sweepExpired` 把它展开成 SQL 的 `NOT IN` 列表。集合为空会
 * 拼出非法的 `IN ()`，所以这里不允许被过滤成空数组。
 */
export const TTL_EXEMPT_MEMORY_TYPES: readonly MemoryType[] = [
  'profile',
  'identity',
  'soul',
  'rules',
];

/**
 * 类型名守卫。
 *
 * 写成 `.some()` 而不是 `Object.hasOwn(BUILTIN_MEMORY_TYPES, ...)`：后者只判「这个键
 * 存在」，而这里的入参是模型给的字符串，需要的是类型收窄——收窄之后下标才不需要断言。
 */
function isMemoryType(value: string): value is MemoryType {
  return BUILTIN_MEMORY_TYPE_NAMES.some((name) => name === value);
}

export function getMemoryType(type: string): MemoryTypeSchema | undefined {
  return isMemoryType(type) ? BUILTIN_MEMORY_TYPES[type] : undefined;
}
