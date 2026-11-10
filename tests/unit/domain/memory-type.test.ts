import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  identityFields,
  memoryContentOf,
  renderPath,
} from '../../../src/domain/memory-type.js';
import {
  BUILTIN_MEMORY_TYPES,
  getMemoryType,
  preferencesMemoryType,
  profileMemoryType,
} from '../../../src/domain/memory-types/index.js';

function expectInvalidArgument(run: () => void): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_ARGUMENT');
  return error;
}

describe('renderPath', () => {
  it('把 identity 值填进文件名模板', () => {
    expect(renderPath(preferencesMemoryType, { topic: 'code-style' })).toBe(
      'memories/preferences/code-style.md',
    );
  });

  it('多段模板按占位符逐段填充', () => {
    const rules = getMemoryType('rules');
    expect(rules).toBeDefined();
    if (rules === undefined) {
      return;
    }
    expect(renderPath(rules, { scenario: 'license-review', rule: 'must-locate-license' })).toBe(
      'memories/rules/license-review/must-locate-license.md',
    );
  });

  it('identity 值含斜杠时拒绝', () => {
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: '../../etc/passwd' }));
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: 'a/b' }));
  });

  it('identity 值含 .. 时拒绝', () => {
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: '..' }));
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: 'a..b' }));
  });

  it('identity 值为空或含反斜杠时拒绝', () => {
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: '' }));
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: 'a\\b' }));
  });

  it('缺占位符值时报错，不会拼出带花括号的路径', () => {
    const rules = getMemoryType('rules');
    expect(rules).toBeDefined();
    if (rules === undefined) {
      return;
    }
    expectInvalidArgument(() => renderPath(rules, { scenario: 'license-review' }));
  });

  it('多传没有对应占位符的字段时报错', () => {
    expectInvalidArgument(() => renderPath(preferencesMemoryType, { topic: 'x', extra: 'y' }));
  });

  it('单文件类型没有占位符，不需要任何值', () => {
    const profile = getMemoryType('profile');

    expect(profile).toBeDefined();
    if (profile === undefined) {
      return;
    }
    expect(renderPath(profile, {})).toBe('memories/profile.md');
  });
});

describe('identityFields', () => {
  it('取到 identity 字段', () => {
    expect(identityFields(preferencesMemoryType).map((field) => field.name)).toEqual(['topic']);
  });

  it('rules 有两个 identity 字段', () => {
    const rules = getMemoryType('rules');
    expect(rules).toBeDefined();
    if (rules === undefined) {
      return;
    }
    expect(identityFields(rules).map((field) => field.name)).toEqual(['scenario', 'rule']);
  });

  it('没有 identity 字段时抛错', () => {
    expectInvalidArgument(() =>
      identityFields({
        ...preferencesMemoryType,
        fields: preferencesMemoryType.fields.map((field) => ({ ...field, identity: false })),
      }),
    );
  });
});

describe('内置记忆类型', () => {
  it('八个内置类型的键与 type 一致', () => {
    expect(Object.keys(BUILTIN_MEMORY_TYPES)).toHaveLength(8);
    for (const [type, memoryType] of Object.entries(BUILTIN_MEMORY_TYPES)) {
      expect(memoryType.type).toBe(type);
    }
  });

  it('events 是 addOnly，其余是 upsert', () => {
    for (const [type, memoryType] of Object.entries(BUILTIN_MEMORY_TYPES)) {
      expect(memoryType.operationMode).toBe(type === 'events' ? 'addOnly' : 'upsert');
    }
  });

  it('getMemoryType 命中内置类型', () => {
    expect(getMemoryType('preferences')).toBe(preferencesMemoryType);
  });

  /**
   * `profile` 的说明会原样进抽取提示词。它退化回一行摘要时，模型没有判据，就会把
   * 类型签名、配置值与性格评价一起写进画像（实测 8 次归档 1,259 字）。
   *
   * 这条测试守的是「规则密度」：收录范围、路由表、格式契约各有一条可被模型读到的
   * 明确规则。只改措辞不会失败，删掉一整类判定才会。
   */
  it('profile 的说明写清收录范围、路由表与格式契约', () => {
    const description = profileMemoryType.description;

    // 收录：只有稳定身份
    expect(description).toContain('稳定身份');
    // 不收录：技术细节、临时状态、性格评价
    expect(description).toContain('一次性技术细节');
    expect(description).toContain('临时状态');
    expect(description).toContain('性格评价');
    // 路由表：三类最容易塞错的内容各有明确的归位
    expect(description).toContain('`events`');
    expect(description).toContain('`preferences`');
    expect(description).toContain('`entities`');
    // 格式契约：日期后缀、单条上限、只留最新值
    expect(description).toContain('(as of YYYY-MM-DD)');
    expect(description).toContain('30 字');
    expect(description).toContain('只保留最新值');
  });

  it('getMemoryType 不命中原型链上的名字', () => {
    expect(getMemoryType('__proto__')).toBeUndefined();
    expect(getMemoryType('constructor')).toBeUndefined();
    expect(getMemoryType('toString')).toBeUndefined();
    expect(getMemoryType('unknown-type')).toBeUndefined();
  });
});

/**
 * 正文取法只有这一份（`services/consolidation.ts` 与
 * `services/commit/steps/memory-extract.ts` 都调它）：合并步骤在 `fields.content`
 * 上应用 SEARCH/REPLACE，取错字段或去掉类型判断会让「模型读到的正文」与「打补丁的
 * 正文」分叉。
 */
describe('memoryContentOf', () => {
  it('取 content 字段的字符串值', () => {
    expect(memoryContentOf({ content: '缩进用 2 个空格。', topic: 'code-style' })).toBe(
      '缩进用 2 个空格。',
    );
  });

  it('字段缺失或不是字符串时给空串', () => {
    // frontmatter 是 YAML：`content: 42` 解析出来是数字，不是字符串。
    expect(memoryContentOf({})).toBe('');
    expect(memoryContentOf({ content: 42 })).toBe('');
    expect(memoryContentOf({ content: null })).toBe('');
  });
});
