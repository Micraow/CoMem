import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  fieldByName,
  identityFields,
  renderPath,
  validateMemoryType,
  type MemoryTypeSchema,
} from '../../../src/domain/memory-type.js';
import {
  BUILTIN_MEMORY_TYPES,
  getMemoryType,
  preferencesMemoryType,
} from '../../../src/domain/memory-types/index.js';

function schema(overrides: Partial<MemoryTypeSchema> = {}): MemoryTypeSchema {
  return {
    type: 'preferences',
    description: '用户在某个话题上的偏好',
    directory: 'memories/preferences',
    filename: '{topic}.md',
    operationMode: 'upsert',
    fields: [
      {
        name: 'topic',
        type: 'string',
        identity: true,
        required: true,
        description: '偏好所属话题',
      },
      { name: 'content', type: 'string', merge: 'patch', description: '偏好内容' },
    ],
    ...overrides,
  };
}

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

describe('validateMemoryType', () => {
  it('合法的类型定义能通过', () => {
    expect(() => {
      validateMemoryType(schema());
    }).not.toThrow();
  });

  it('没有 identity 字段时拒绝', () => {
    const invalid = schema({
      fields: [
        { name: 'topic', type: 'string', description: '话题' },
        { name: 'content', type: 'string', description: '内容' },
      ],
    });

    expectInvalidArgument(() => {
      validateMemoryType(invalid);
    });
  });

  it('多个 identity 字段合法，只要 filename 占位符都是 identity', () => {
    const valid = schema({
      filename: '{topic}/{content}.md',
      fields: [
        { name: 'topic', type: 'string', identity: true, description: '话题' },
        { name: 'content', type: 'string', identity: true, description: '内容' },
      ],
    });

    expect(() => {
      validateMemoryType(valid);
    }).not.toThrow();
  });

  it('filename 模板含空段时拒绝', () => {
    expectInvalidArgument(() => {
      validateMemoryType(schema({ filename: '{topic}//x.md' }));
    });
  });

  it('filename 模板含 .. 段时拒绝', () => {
    expectInvalidArgument(() => {
      validateMemoryType(schema({ filename: '{topic}/../x.md' }));
    });
  });

  it('filename 占位符不在 fields 里时拒绝', () => {
    const invalid = schema({ filename: '{scope}.md' });

    expectInvalidArgument(() => {
      validateMemoryType(invalid);
    });
  });

  it('filename 占位符不是 identity 字段时拒绝', () => {
    const invalid = schema({ filename: '{content}.md' });

    expectInvalidArgument(() => {
      validateMemoryType(invalid);
    });
  });

  it('filename 里残留不完整占位符时拒绝', () => {
    expectInvalidArgument(() => {
      validateMemoryType(schema({ filename: '{topic.md' }));
    });
  });

  it('directory 不允许绝对路径、末尾斜杠与 ..', () => {
    for (const directory of ['/memories/preferences', 'memories/preferences/', 'memories/../etc']) {
      expectInvalidArgument(() => {
        validateMemoryType(schema({ directory }));
      });
    }
  });

  it('directory 不允许空段与控制字符', () => {
    for (const directory of ['memories//preferences', 'memories/\u0000preferences']) {
      expectInvalidArgument(() => {
        validateMemoryType(schema({ directory }));
      });
    }
  });

  it('type 名只允许小写短横线', () => {
    for (const type of ['', 'Preferences', 'pref_erences', '-preferences']) {
      expectInvalidArgument(() => {
        validateMemoryType(schema({ type }));
      });
    }
  });

  it('字段名为空、重复或 description 为空时拒绝', () => {
    expectInvalidArgument(() => {
      validateMemoryType(schema({ fields: [] }));
    });
    expectInvalidArgument(() => {
      validateMemoryType(
        schema({
          fields: [
            { name: 'topic', type: 'string', identity: true, description: '话题' },
            { name: 'topic', type: 'string', description: '重复' },
          ],
        }),
      );
    });
    expectInvalidArgument(() => {
      validateMemoryType(
        schema({
          fields: [{ name: 'topic', type: 'string', identity: true, description: '  ' }],
        }),
      );
    });
  });
});

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

describe('identityFields / fieldByName', () => {
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

  it('按名字取字段，不存在返回 undefined', () => {
    expect(fieldByName(preferencesMemoryType, 'content')?.merge).toBe('patch');
    expect(fieldByName(preferencesMemoryType, 'missing')).toBeUndefined();
  });
});

describe('内置记忆类型', () => {
  it('八个内置类型全部合法', () => {
    expect(Object.keys(BUILTIN_MEMORY_TYPES)).toHaveLength(8);
    for (const [type, memoryType] of Object.entries(BUILTIN_MEMORY_TYPES)) {
      expect(memoryType.type).toBe(type);
      expect(() => {
        validateMemoryType(memoryType);
      }).not.toThrow();
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

  it('getMemoryType 不命中原型链上的名字', () => {
    expect(getMemoryType('__proto__')).toBeUndefined();
    expect(getMemoryType('constructor')).toBeUndefined();
    expect(getMemoryType('toString')).toBeUndefined();
    expect(getMemoryType('unknown-type')).toBeUndefined();
  });
});
