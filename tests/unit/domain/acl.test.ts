import { describe, expect, it } from 'vitest';

import {
  canModifyAcl,
  checkAction,
  createAclCache,
  effectiveAcl,
  formatPrincipal,
  levelSatisfies,
  parsePrincipal,
  rootPreset,
} from '../../../src/domain/acl.js';
import type { AclEntry, AclLevel, AclMode, AclNode } from '../../../src/domain/acl.js';
import { ComemError } from '../../../src/domain/errors.js';
import { Uri } from '../../../src/domain/uri.js';

function node(
  path: string,
  options: {
    readonly owner?: string;
    readonly mode?: AclMode;
    readonly entries?: readonly AclEntry[];
  } = {},
): AclNode {
  return {
    uri: Uri.parse(path),
    owner: options.owner ?? 'user:owner',
    mode: options.mode ?? 'inherit',
    entries: options.entries ?? [],
  };
}

function allow(principal: string, level: AclLevel): AclEntry {
  return { principal, level, effect: 'allow' };
}

function deny(principal: string, level: AclLevel): AclEntry {
  return { principal, level, effect: 'deny' };
}

function sortedLevels(levels: ReadonlySet<AclLevel>): AclLevel[] {
  return [...levels].sort((a, b) => a - b);
}

function expectInvalidArgument(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('INVALID_ARGUMENT');
    return;
  }
  throw new Error('期望抛出 ComemError');
}

describe('parsePrincipal / formatPrincipal', () => {
  it('解析 user 与 group 主体', () => {
    expect(parsePrincipal('user:alice')).toEqual({ kind: 'user', id: 'alice' });
    expect(parsePrincipal('group:eng')).toEqual({ kind: 'group', id: 'eng' });
  });

  it('解析 user:* 通配', () => {
    expect(parsePrincipal('user:*')).toEqual({ kind: 'user', id: '*' });
  });

  it('拒绝 group:*（§12.1）', () => {
    expectInvalidArgument(() => parsePrincipal('group:*'));
  });

  it('拒绝缺少 kind、缺少 id 或多余冒号的输入', () => {
    for (const raw of ['', 'alice', ':alice', 'user:', 'user:alice:extra', 'admin:alice']) {
      expectInvalidArgument(() => parsePrincipal(raw));
    }
  });

  it('与 formatPrincipal 互逆', () => {
    for (const raw of ['user:alice', 'group:eng', 'user:*', 'user:alice@example.com']) {
      expect(formatPrincipal(parsePrincipal(raw))).toBe(raw);
    }
  });
});

describe('levelSatisfies', () => {
  it('manage 覆盖所有级别', () => {
    expect(levelSatisfies(7, 1)).toBe(true);
    expect(levelSatisfies(7, 3)).toBe(true);
    expect(levelSatisfies(7, 7)).toBe(true);
  });

  it('write 覆盖 read，不覆盖 manage', () => {
    expect(levelSatisfies(3, 1)).toBe(true);
    expect(levelSatisfies(3, 3)).toBe(true);
    expect(levelSatisfies(3, 7)).toBe(false);
  });

  it('read 只覆盖 read', () => {
    expect(levelSatisfies(1, 1)).toBe(true);
    expect(levelSatisfies(1, 3)).toBe(false);
    expect(levelSatisfies(1, 7)).toBe(false);
  });
});

describe('effectiveAcl', () => {
  it('空链返回空集', () => {
    expect(sortedLevels(effectiveAcl([], 'user:alice'))).toEqual([]);
  });

  it('单节点链：没有 entry 时没有权限', () => {
    const chain = [node('comem://user/alice')];
    expect(sortedLevels(effectiveAcl(chain, 'user:bob'))).toEqual([]);
  });

  it('单节点链：owner 恒 manage', () => {
    const chain = [node('comem://user/alice', { owner: 'user:alice' })];
    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([7]);
  });

  it('user 根预置：owner 得到 manage，其他用户没有权限', () => {
    const root = Uri.parse('comem://user/alice');
    const chain = [node(root.toString(), { owner: 'user:alice', entries: rootPreset(root).entries })];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([7]);
    expect(sortedLevels(effectiveAcl(chain, 'user:bob'))).toEqual([]);
  });

  it('group 根预置：组员得到 write，组外用户没有权限', () => {
    const root = Uri.parse('comem://group/eng');
    const chain = [node(root.toString(), { owner: 'user:owner', entries: rootPreset(root).entries })];

    expect(sortedLevels(effectiveAcl(chain, 'group:eng'))).toEqual([3]);
    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('深层节点没有 ACL 时继承到根', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects'),
      node('comem://user/alice/projects/comem'),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([1]);
  });

  it('多层叠加：祖先 allow read，本层 allow write', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects', { entries: [allow('user:alice', 3)] }),
      node('comem://user/alice/projects/comem'),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([1, 3]);
  });

  it('restricted 切断继承：只保留本节点直接授权', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects', {
        mode: 'restricted',
        entries: [allow('user:alice', 3)],
      }),
      node('comem://user/alice/projects/comem'),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([3]);
  });

  it('restricted 且本节点没有授权时结果为空', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects', { mode: 'restricted' }),
      node('comem://user/alice/projects/comem'),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('restricted 下本节点的 deny 仍然生效', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects', {
        mode: 'restricted',
        entries: [allow('user:alice', 3), deny('user:alice', 3)],
      }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('同节点 deny 优先：allow write + deny write 后无权限', () => {
    const chain = [
      node('comem://user/alice', {
        entries: [allow('user:alice', 3), deny('user:alice', 3)],
      }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('同节点 deny 会清空祖先继承来的权限', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:alice', 1)] }),
      node('comem://user/alice/projects', { entries: [deny('user:alice', 3)] }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('祖先的 deny 不会阻止本节点的直接授权', () => {
    const chain = [
      node('comem://user/alice', { entries: [deny('user:alice', 1)] }),
      node('comem://user/alice/projects', { entries: [allow('user:alice', 3)] }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([3]);
  });

  it('owner 不能被 deny 收回', () => {
    const chain = [
      node('comem://user/alice', {
        owner: 'user:alice',
        entries: [deny('user:alice', 7), deny('user:alice', 1)],
      }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([7]);
  });

  it('owner 在祖先节点时，后代仍然拿到 manage', () => {
    const chain = [
      node('comem://user/alice', { owner: 'user:alice' }),
      node('comem://user/alice/projects'),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([7]);
  });

  it('user:* 通配命中任何 user 主体，不命中 group 主体', () => {
    const chain = [
      node('comem://user/alice', { entries: [allow('user:*', 1)] }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:bob'))).toEqual([1]);
    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([1]);
    expect(sortedLevels(effectiveAcl(chain, 'group:eng'))).toEqual([]);
  });

  it('user:* 的 deny 优先于具体主体的 allow', () => {
    const chain = [
      node('comem://user/alice', {
        entries: [allow('user:alice', 3), deny('user:*', 3)],
      }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('group 主体只命中 group 条目', () => {
    const chain = [
      node('comem://group/eng', { entries: [allow('group:eng', 3)] }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'group:eng'))).toEqual([3]);
    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([]);
  });

  it('同一节点的多条 allow 全部保留', () => {
    const chain = [
      node('comem://user/alice', {
        entries: [allow('user:alice', 1), allow('user:alice', 7)],
      }),
    ];

    expect(sortedLevels(effectiveAcl(chain, 'user:alice'))).toEqual([1, 7]);
  });
});

describe('checkAction', () => {
  it('manage 满足 read / write / manage', () => {
    const chain = [node('comem://user/alice', { owner: 'user:alice' })];
    expect(checkAction(chain, 'user:alice', 1)).toBe(true);
    expect(checkAction(chain, 'user:alice', 3)).toBe(true);
    expect(checkAction(chain, 'user:alice', 7)).toBe(true);
  });

  it('write 满足 read，不满足 manage', () => {
    const chain = [node('comem://user/alice', { entries: [allow('user:alice', 3)] })];
    expect(checkAction(chain, 'user:alice', 1)).toBe(true);
    expect(checkAction(chain, 'user:alice', 3)).toBe(true);
    expect(checkAction(chain, 'user:alice', 7)).toBe(false);
  });

  it('read 只满足 read', () => {
    const chain = [node('comem://user/alice', { entries: [allow('user:alice', 1)] })];
    expect(checkAction(chain, 'user:alice', 1)).toBe(true);
    expect(checkAction(chain, 'user:alice', 3)).toBe(false);
    expect(checkAction(chain, 'user:alice', 7)).toBe(false);
  });

  it('空链不满足任何级别', () => {
    expect(checkAction([], 'user:alice', 1)).toBe(false);
    expect(checkAction([], 'user:alice', 7)).toBe(false);
  });
});

describe('canModifyAcl', () => {
  it('owner 可以改 ACL', () => {
    const chain = [node('comem://user/alice', { owner: 'user:alice' })];
    expect(canModifyAcl(chain, 'user:alice')).toBe(true);
  });

  it('只有 write 不能改 ACL', () => {
    const chain = [node('comem://user/alice', { entries: [allow('user:alice', 3)] })];
    expect(canModifyAcl(chain, 'user:alice')).toBe(false);
  });

  it('manage 授权可以改 ACL', () => {
    const chain = [node('comem://user/alice', { entries: [allow('user:alice', 7)] })];
    expect(canModifyAcl(chain, 'user:alice')).toBe(true);
  });

  it('没有权限时不能改 ACL', () => {
    expect(canModifyAcl([node('comem://user/alice')], 'user:alice')).toBe(false);
  });
});

describe('rootPreset', () => {
  it('user 根预置 owner = manage', () => {
    expect(rootPreset(Uri.parse('comem://user/alice'))).toEqual({
      entries: [{ principal: 'user:alice', level: 7, effect: 'allow' }],
      ownerMissing: false,
    });
  });

  it('group 根预置 group = write；没有 owner 时 ownerMissing', () => {
    expect(rootPreset(Uri.parse('comem://group/eng'))).toEqual({
      entries: [{ principal: 'group:eng', level: 3, effect: 'allow' }],
      ownerMissing: true,
    });
  });

  it('group 根有 owner 时预置两条：owner 恒 manage，组员 write', () => {
    expect(rootPreset(Uri.parse('comem://group/eng'), { ownerUserId: 'alice' })).toEqual({
      entries: [
        { principal: 'user:alice', level: 7, effect: 'allow' },
        { principal: 'group:eng', level: 3, effect: 'allow' },
      ],
      ownerMissing: false,
    });
  });

  it('groupDefaultLevel 只作用于组条目，不把 owner 的 manage 降级', () => {
    expect(
      rootPreset(Uri.parse('comem://group/eng'), { ownerUserId: 'alice', groupLevel: 1 }),
    ).toEqual({
      entries: [
        { principal: 'user:alice', level: 7, effect: 'allow' },
        { principal: 'group:eng', level: 1, effect: 'allow' },
      ],
      ownerMissing: false,
    });
  });
});

describe('createAclCache', () => {
  it('未写入时返回 undefined', () => {
    const cache = createAclCache();
    expect(cache.get(Uri.parse('comem://user/alice'), 'user:alice')).toBeUndefined();
  });

  it('set / get 按 URI 与主体隔离', () => {
    const cache = createAclCache();
    const alice = Uri.parse('comem://user/alice');
    const bob = Uri.parse('comem://user/bob');
    const value = new Set<AclLevel>([1, 3]);

    cache.set(alice, 'user:alice', value);

    expect(cache.get(alice, 'user:alice')).toBe(value);
    expect(cache.get(bob, 'user:alice')).toBeUndefined();
    expect(cache.get(alice, 'user:bob')).toBeUndefined();
  });

  it('clear 清空全部条目', () => {
    const cache = createAclCache();
    const alice = Uri.parse('comem://user/alice');

    cache.set(alice, 'user:alice', new Set<AclLevel>([7]));
    cache.clear();

    expect(cache.get(alice, 'user:alice')).toBeUndefined();
  });

  it('不同实例之间不共享状态（没有全局单例）', () => {
    const first = createAclCache();
    const second = createAclCache();
    const alice = Uri.parse('comem://user/alice');

    first.set(alice, 'user:alice', new Set<AclLevel>([7]));

    expect(second.get(alice, 'user:alice')).toBeUndefined();
  });
});
