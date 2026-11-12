import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import { renderPath } from '../../../src/domain/memory-type.js';
import { deriveCreationIdentity } from '../../../src/domain/memory-types/creation.js';
import {
  eventsMemoryType,
  preferencesMemoryType,
  profileMemoryType,
  rulesMemoryType,
} from '../../../src/domain/memory-types/index.js';

const NOW = new Date('2026-11-12T09:30:00+08:00');

describe('deriveCreationIdentity', () => {
  it('单段标题折叠空白，固定文件名类型把标题写进 identity', () => {
    const preferences = deriveCreationIdentity(preferencesMemoryType, '  代码   风格 ', NOW);
    expect(preferences).toEqual({ topic: '代码-风格' });
    expect(renderPath(preferencesMemoryType, preferences)).toBe(
      'memories/preferences/代码-风格.md',
    );

    expect(deriveCreationIdentity(profileMemoryType, 'Alice', NOW)).toEqual({ name: 'Alice' });
    expect(renderPath(profileMemoryType, {})).toBe('memories/profile.md');
  });

  it('事件补日期前缀，多段标题按 / 分配并拒绝缺段', () => {
    expect(deriveCreationIdentity(eventsMemoryType, 'architecture-decision', NOW)).toEqual({
      event: '2026-11-12-architecture-decision',
    });
    expect(deriveCreationIdentity(eventsMemoryType, '2026-11-05-release', NOW)).toEqual({
      event: '2026-11-05-release',
    });

    expect(deriveCreationIdentity(rulesMemoryType, 'license-review/must-locate-license', NOW)).toEqual(
      { scenario: 'license-review', rule: 'must-locate-license' },
    );

    let caught: unknown;
    try {
      deriveCreationIdentity(rulesMemoryType, 'only-one-segment', NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('INVALID_ARGUMENT');
  });
});
