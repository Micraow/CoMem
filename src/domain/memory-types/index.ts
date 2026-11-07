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

export function getMemoryType(type: string): MemoryTypeSchema | undefined {
  return Object.hasOwn(BUILTIN_MEMORY_TYPES, type) ? BUILTIN_MEMORY_TYPES[type] : undefined;
}
