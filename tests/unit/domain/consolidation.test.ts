/**
 * 记忆合并的领域规则（架构文档 §11.8）。
 *
 * 这一份只测纯函数：`validateOperations` 的每条拒绝条件与 `resolveMemoryTarget`
 * 的 URI 还原。模型、锁、写盘在 `tests/integration/services/consolidation.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  resolveMemoryTarget,
  validateOperations,
  type ConsolidationOperation,
  type ValidateOperationsResult,
} from '../../../src/domain/consolidation.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = Uri.parse('comem://user/alice');
const SCOPE_PREFIX = 'comem://user/alice/memories/';
const CODE_STYLE = `${SCOPE_PREFIX}preferences/code-style.md`;
const LICENSE = `${SCOPE_PREFIX}rules/license-review/must-locate-license.md`;

const EXISTING = new Set([CODE_STYLE, LICENSE]);

function check(
  operations: readonly ConsolidationOperation[],
  existing: ReadonlySet<string> = EXISTING,
): ValidateOperationsResult {
  return validateOperations(operations, { existing, allowedScopes: [SCOPE_PREFIX] });
}

describe('validateOperations', () => {
  it('三类操作都合法时原样返回，URI 规范化', () => {
    const result = check([
      { kind: 'add', uri: `${SCOPE_PREFIX}preferences/editor.md`, content: '用 vim', reason: '新增' },
      { kind: 'update', uri: CODE_STYLE, content: '用 2 空格', reason: '更新' },
      { kind: 'delete', uri: LICENSE, content: null, reason: '规则已废止' },
    ]);

    expect(result).toEqual({
      valid: [
        { kind: 'add', uri: `${SCOPE_PREFIX}preferences/editor.md`, content: '用 vim', reason: '新增' },
        { kind: 'update', uri: CODE_STYLE, content: '用 2 空格', reason: '更新' },
        { kind: 'delete', uri: LICENSE, content: null, reason: '规则已废止' },
      ],
    });
  });

  it('末尾斜杠与重复斜杠被规范化，避免同一条记忆被当成两条', () => {
    const result = check([
      { kind: 'delete', uri: 'comem://user/alice//memories/preferences/code-style.md/', content: null, reason: '重复' },
    ]);

    expect(result).toEqual({
      valid: [{ kind: 'delete', uri: CODE_STYLE, content: null, reason: '重复' }],
    });
  });

  it('空操作列表是合法的（模型认为不需要改）', () => {
    expect(check([])).toEqual({ valid: [] });
  });

  it('update / delete 指向不存在的记忆时整批拒绝', () => {
    const result = check([
      { kind: 'update', uri: CODE_STYLE, content: '改', reason: '合法' },
      { kind: 'delete', uri: `${SCOPE_PREFIX}preferences/ghost.md`, content: null, reason: '幻觉' },
    ]);

    expect(result).toMatchObject({
      error: expect.stringContaining('不存在') as string,
    });
    expect(result).not.toHaveProperty('valid');
  });

  it('add 的目标已存在时整批拒绝（应该用 update）', () => {
    const result = check([
      { kind: 'add', uri: CODE_STYLE, content: '重复新增', reason: '看错了' },
    ]);

    expect(result).toMatchObject({ error: expect.stringContaining('已存在') as string });
  });

  it('URI 不在允许的 scope 内时整批拒绝', () => {
    const result = check([
      { kind: 'delete', uri: 'comem://user/bob/memories/preferences/code-style.md', content: null, reason: '越界' },
    ]);

    expect(result).toMatchObject({ error: expect.stringContaining('scope') as string });
  });

  it('前缀匹配有段边界：memoriesX 不算 memories/', () => {
    const result = check([
      {
        kind: 'delete',
        uri: 'comem://user/alice/memoriesX/preferences/code-style.md',
        content: null,
        reason: '越界',
      },
    ]);

    expect(result).toMatchObject({ error: expect.stringContaining('scope') as string });
  });

  it('allowedScopes 缺末尾斜杠时按目录补齐', () => {
    const result = validateOperations(
      [{ kind: 'delete', uri: CODE_STYLE, content: null, reason: 'ok' }],
      { existing: EXISTING, allowedScopes: ['comem://user/alice/memories'] },
    );

    expect(result).toEqual({
      valid: [{ kind: 'delete', uri: CODE_STYLE, content: null, reason: 'ok' }],
    });
  });

  it('add / update 的 content 为空时整批拒绝', () => {
    for (const content of [null, '', '   \n  ']) {
      const result = check([
        { kind: 'update', uri: CODE_STYLE, content, reason: '空正文' },
      ]);

      expect(result).toMatchObject({ error: expect.stringContaining('content') as string });
    }
  });

  it('delete 不要求 content', () => {
    expect(check([{ kind: 'delete', uri: CODE_STYLE, content: null, reason: 'ok' }])).toEqual({
      valid: [{ kind: 'delete', uri: CODE_STYLE, content: null, reason: 'ok' }],
    });
  });

  it('reason 为空时整批拒绝（没有理由的删除不可接受）', () => {
    const result = check([{ kind: 'delete', uri: CODE_STYLE, content: null, reason: '  ' }]);

    expect(result).toMatchObject({ error: expect.stringContaining('reason') as string });
  });

  it('同一个 URI 出现两次时整批拒绝（同一批里 update 又 delete 是自相矛盾的）', () => {
    const result = check([
      { kind: 'update', uri: CODE_STYLE, content: '改', reason: '合并' },
      { kind: 'delete', uri: CODE_STYLE, content: null, reason: '删掉' },
    ]);

    expect(result).toMatchObject({ error: expect.stringContaining('同一条记忆') as string });
  });

  it('URI 语法不合法时整批拒绝', () => {
    const result = check([
      { kind: 'delete', uri: 'not-a-uri', content: null, reason: '笔误' },
    ]);

    expect(result).toMatchObject({ error: expect.stringContaining('URI 不合法') as string });
  });

  it('一条不合法就整批不执行：合法的那条也不出现在结果里', () => {
    const result = check([
      { kind: 'update', uri: CODE_STYLE, content: '改', reason: '合法' },
      { kind: 'update', uri: `${SCOPE_PREFIX}preferences/ghost.md`, content: '改', reason: '幻觉' },
    ]);

    expect(result).not.toHaveProperty('valid');
    expect(result).toHaveProperty('error');
  });
});

describe('resolveMemoryTarget', () => {
  it('单段文件名：preferences 的 topic 从路径段读出', () => {
    const target = resolveMemoryTarget(SCOPE, Uri.parse(CODE_STYLE));

    expect(target?.schema.type).toBe('preferences');
    expect(target?.identity).toEqual({ topic: 'code-style' });
  });

  it('多段文件名：rules 的 scenario 与 rule 各归各位', () => {
    const target = resolveMemoryTarget(SCOPE, Uri.parse(LICENSE));

    expect(target?.schema.type).toBe('rules');
    expect(target?.identity).toEqual({ scenario: 'license-review', rule: 'must-locate-license' });
  });

  it('固定文件名：profile 的 identity 是空对象（name 不在模板里）', () => {
    const target = resolveMemoryTarget(SCOPE, Uri.parse('comem://user/alice/memories/profile.md'));

    expect(target?.schema.type).toBe('profile');
    expect(target?.identity).toEqual({});
  });

  it('不在 memories/ 下时返回 null', () => {
    expect(
      resolveMemoryTarget(SCOPE, Uri.parse('comem://user/alice/resources/foo.md')),
    ).toBeNull();
  });

  it('文件名不符合任何模板时返回 null', () => {
    expect(
      resolveMemoryTarget(SCOPE, Uri.parse('comem://user/alice/memories/preferences/code-style.txt')),
    ).toBeNull();
  });

  it('scope 之外（同段数）时返回 null', () => {
    expect(
      resolveMemoryTarget(SCOPE, Uri.parse('comem://user/bob/memories/profile.md')),
    ).toBeNull();
  });

  it('memories 目录本身不是记忆文件（比任何模板都浅）', () => {
    expect(resolveMemoryTarget(SCOPE, SCOPE.child('memories'))).toBeNull();
  });
});
