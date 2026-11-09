import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore, type AclFile } from '../../../src/adapters/fs/acl-file.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import {
  PermissionRepository,
  type PermissionRow,
} from '../../../src/adapters/sqlite/permission-repository.js';
import { levelSatisfies } from '../../../src/domain/acl.js';
import type { AclEntry, AclLevel, RootPreset } from '../../../src/domain/acl.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { NodeKind } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService, type AclInput, type AclSnapshot } from '../../../src/services/acl.js';

const ROOT = 'comem://user/alice';
const GROUP_ROOT = 'comem://group/eng';

let dataDir: string;
let db: DatabaseSync;
let aclFile: AclFileStore;
let permissions: PermissionRepository;
let nodes: NodeRepository;
let logger: Logger;
let locks: PathLockManager;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-acl-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  aclFile = new AclFileStore({ dataDir, logger });
  permissions = new PermissionRepository({ db, logger });
  nodes = new NodeRepository({ db, logger });
  // 轮询间隔压到 1ms：并发用例靠锁排队，默认 25ms 会把等待放大到可测量。
  locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/**
 * 绑定了请求身份的 ACL 门面。
 *
 * `AclService` 的 `Authorizer` 方法收显式 `principals`（§12.4）：身份是参数，不是
 * 构造期绑定。测试用这个门面把 `subject` / `groups` 展开成 principals 再传进去，
 * 用例读起来仍然像「某个用户发了一次请求」。
 */
interface BoundAcl {
  check(uri: Uri, action: AclLevel): Promise<boolean>;
  filterReadable(uris: readonly Uri[]): Promise<ReadonlySet<string>>;
  getAcl(uri: Uri, subject: string): Promise<AclSnapshot>;
  setAcl(uri: Uri, input: AclInput, subject: string): Promise<void>;
  ensureRootPreset(uri: Uri, ownerUserId?: string | null): Promise<RootPreset>;
  setGroupOwner(uri: Uri, previousOwnerId: string | null, nextOwnerId: string): Promise<void>;
  materializeNode(uri: Uri): Promise<void>;
  purgePrincipal(principal: string): Promise<number>;
  purgeSubtree(root: Uri): Promise<number>;
  resolvePrincipals(subject: string, groups: readonly string[]): readonly string[];
}

function createService(
  options: {
    readonly subject?: string;
    readonly groups?: readonly string[];
    readonly groupDefaultLevel?: AclLevel;
  } = {},
): BoundAcl {
  const subject = options.subject ?? 'user:alice';
  const groups = options.groups ?? [];
  const acl = new AclService({
    db,
    aclFile,
    permissions,
    nodes,
    logger,
    locks,
    groupDefaultLevel: options.groupDefaultLevel,
  });
  const principals = acl.resolvePrincipals(subject, groups);
  return {
    check: (uri, action) => acl.check(uri, action, principals),
    filterReadable: (uris) => acl.filterReadable(uris, principals),
    getAcl: (uri, requester) => acl.getAcl(uri, requester, principals),
    setAcl: (uri, input, requester) => acl.setAcl(uri, input, requester, principals),
    ensureRootPreset: (uri, ownerUserId) => acl.ensureRootPreset(uri, ownerUserId),
    setGroupOwner: (uri, previousOwnerId, nextOwnerId) =>
      acl.setGroupOwner(uri, previousOwnerId, nextOwnerId),
    materializeNode: (uri) => acl.materializeNode(uri),
    purgePrincipal: (principal) => acl.purgePrincipal(principal),
    purgeSubtree: (root) => acl.purgeSubtree(root),
    resolvePrincipals: (requester, requesterGroups) =>
      acl.resolvePrincipals(requester, requesterGroups),
  };
}

function allow(principal: string, level: AclLevel): AclEntry {
  return { principal, level, effect: 'allow' };
}

function deny(principal: string, level: AclLevel): AclEntry {
  return { principal, level, effect: 'deny' };
}

function nodeRow(uri: string, kind: NodeKind = 'directory'): NodeRow {
  const parsed = Uri.parse(uri);
  return {
    uri,
    parentUri: parsed.parent()?.toString() ?? '',
    scope: parsed.scope,
    kind,
    contextType: 'memory',
    memoryType: null,
    level: 'L0',
    abstract: null,
    bodyDigest: 'digest',
    size: 0,
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: 'active',
  };
}

/** 用生产写路径建 `node` 行：`node` 表由 `SqliteFtsIndex.upsert` 维护。 */
async function seed(...uris: readonly string[]): Promise<void> {
  await new SqliteFtsIndex({ db, logger }).upsert(
    uris.map((uri) => ({ ...nodeRow(uri), content: '' })),
  );
}

async function seedDocument(uri: string): Promise<void> {
  await new SqliteFtsIndex({ db, logger }).upsert([{ ...nodeRow(uri, 'document'), content: '' }]);
}

function aclEntriesOf(uri: string): readonly { uri: string; principal: string; level: number; effect: string }[] {
  return db
    .prepare('SELECT uri, principal, level, effect FROM acl_entry WHERE uri = ? ORDER BY principal ASC')
    .all(uri)
    .map((row) => ({
      uri: String(row['uri']),
      principal: String(row['principal']),
      level: Number(row['level']),
      effect: String(row['effect']),
    }));
}

function permissionsOf(nodeUri: string): readonly PermissionRow[] {
  return db
    .prepare(
      'SELECT node_uri, principal, level, effect FROM node_permission WHERE node_uri = ? ORDER BY principal ASC',
    )
    .all(nodeUri)
    .map((row) => ({
      nodeUri: String(row['node_uri']),
      principal: String(row['principal']),
      level: Number(row['level']) as AclLevel,
      effect: String(row['effect']) as PermissionRow['effect'],
    }));
}

async function expectComemError(
  run: () => Promise<unknown>,
  code: ComemError['code'],
): Promise<ComemError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    const comem = error as ComemError;
    expect(comem.code).toBe(code);
    return comem;
  }
  throw new Error(`期望抛出 ComemError(${code})，但没有抛错`);
}

describe('resolvePrincipals', () => {
  it('subject + 组 + user:* 通配', () => {
    const service = createService({ subject: 'user:alice', groups: ['group:eng'] });

    expect(service.resolvePrincipals('user:alice', ['group:eng'])).toEqual([
      'user:alice',
      'group:eng',
      'user:*',
    ]);
    expect(service.resolvePrincipals('user:alice', [])).toEqual(['user:alice', 'user:*']);
  });

  it('去重且保留 subject 在首位', () => {
    const service = createService();

    expect(service.resolvePrincipals('user:alice', ['group:eng', 'group:eng'])).toEqual([
      'user:alice',
      'group:eng',
      'user:*',
    ]);
  });

  it('subject 必须是 user 主体，组必须是 group 主体', () => {
    const service = createService();

    expect(() => service.resolvePrincipals('group:eng', [])).toThrow(ComemError);
    expect(() => service.resolvePrincipals('user:alice', ['user:bob'])).toThrow(ComemError);
    expect(() => service.resolvePrincipals('group:*', [])).toThrow(ComemError);
  });
});

describe('根预置', () => {
  it('user 根：owner 得到 manage，其他用户没有权限', async () => {
    const root = Uri.parse(ROOT);
    await createService().ensureRootPreset(root);

    expect(await createService().check(root, 7)).toBe(true);
    expect(await createService().check(root, 1)).toBe(true);
    expect(await createService({ subject: 'user:bob' }).check(root, 1)).toBe(false);

    const snapshot = await createService().getAcl(root, 'user:alice');
    expect(snapshot.mode).toBe('inherit');
    expect(snapshot.entries).toEqual([allow('user:alice', 7)]);
    expect(snapshot.effective.get('user:alice')).toEqual(new Set([7]));
  });

  it('group 根：组员得到 write，组外用户没有权限', async () => {
    const root = Uri.parse(GROUP_ROOT);
    await createService().ensureRootPreset(root);

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    expect(await member.check(root, 1)).toBe(true);
    expect(await member.check(root, 3)).toBe(true);
    expect(await member.check(root, 7)).toBe(false);

    expect(await createService({ subject: 'user:carol' }).check(root, 1)).toBe(false);

    // getAcl 需要 manage（§12.4），组员只有 write，读不到快照。
    await expectComemError(() => member.getAcl(root, 'user:bob'), 'PERMISSION_DENIED');
  });

  it('group 根配成 read 时组员只有 read', async () => {
    const root = Uri.parse(GROUP_ROOT);
    await createService({ groupDefaultLevel: 1 }).ensureRootPreset(root);

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    expect(await member.check(root, 1)).toBe(true);
    expect(await member.check(root, 3)).toBe(false);
  });

  it('幂等：已有 ACL 文件就不覆盖', async () => {
    const root = Uri.parse(ROOT);
    await createService().ensureRootPreset(root);
    await aclFile.write(root, { mode: 'restricted', entries: [] });

    await createService().ensureRootPreset(root);

    expect((await aclFile.read(root))?.mode).toBe('restricted');
  });

  it('非根 URI 抛 INVALID_ARGUMENT', async () => {
    await expectComemError(
      () => createService().ensureRootPreset(Uri.parse('comem://user/alice/memories')),
      'INVALID_ARGUMENT',
    );
  });
});

/**
 * 回归：服务层拒绝通配主体（架构文档 §12.2 的「ACL 条目是授权的唯一来源」）。
 *
 * HTTP 路径有 `assertValidUserId` 挡着，但 `AclService` 是公开入口。直接传 `*`
 * 会写出 `user:* = manage`——通配主体拿到 manage 等于所有人都是组管理员。
 */
describe('组 owner 主体校验', () => {
  it('ensureRootPreset 拒绝通配与非 user 格式，且不写盘', async () => {
    const root = Uri.parse(GROUP_ROOT);

    await expectComemError(() => createService().ensureRootPreset(root, '*'), 'INVALID_ARGUMENT');
    await expectComemError(
      () => createService().ensureRootPreset(root, 'group:eng'),
      'INVALID_ARGUMENT',
    );

    // 拒绝发生在写盘之前：没有 `.acl.json`，也没有物化行。
    expect(await aclFile.read(root)).toBeNull();
    expect(permissionsOf(GROUP_ROOT)).toEqual([]);
  });

  it('setGroupOwner 拒绝通配与非 user 格式，且不改动已有预置', async () => {
    const root = Uri.parse(GROUP_ROOT);
    const service = createService();
    await service.ensureRootPreset(root, 'alice');
    const before = await aclFile.read(root);

    await expectComemError(
      () => service.setGroupOwner(root, 'alice', '*'),
      'INVALID_ARGUMENT',
    );
    await expectComemError(
      () => service.setGroupOwner(root, 'alice', 'group:eng'),
      'INVALID_ARGUMENT',
    );

    expect(await aclFile.read(root)).toEqual(before);
  });

  it('替换 owner 条目，保留其它条目与 mode', async () => {
    const root = Uri.parse(GROUP_ROOT);
    const service = createService();
    await service.ensureRootPreset(root, 'alice');
    const initial = await aclFile.read(root);
    await aclFile.write(root, {
      mode: 'restricted',
      entries: [...(initial?.entries ?? []), { principal: 'user:carol', level: 'read', effect: 'allow' }],
    });

    await service.setGroupOwner(root, 'alice', 'bob');

    const file = await aclFile.read(root);
    expect(file?.mode).toBe('restricted');
    expect(file?.entries).toEqual(
      expect.arrayContaining([
        { principal: 'user:bob', level: 'manage', effect: 'allow' },
        { principal: 'group:eng', level: 'write', effect: 'allow' },
        { principal: 'user:carol', level: 'read', effect: 'allow' },
      ]),
    );
    expect(file?.entries.some((entry) => entry.principal === 'user:alice')).toBe(false);
  });
});

describe('继承与切断', () => {
  it('深层节点没有 .acl.json 时继承到根', async () => {
    await seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    const deep = Uri.parse(`${ROOT}/memories/deep`);
    expect(await member.check(deep, 1)).toBe(true);
    expect(await member.check(deep, 3)).toBe(false);
  });

  it('restricted 切断继承：祖先 allow 不生效', async () => {
    await seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');
    await service.setAcl(
      Uri.parse(`${ROOT}/memories`),
      { mode: 'restricted', entries: [] },
      'user:alice',
    );

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    expect(await member.check(Uri.parse(`${ROOT}/memories`), 1)).toBe(false);
    expect(await member.check(Uri.parse(`${ROOT}/memories/deep`), 1)).toBe(false);
  });

  it('restricted 下本节点直接授权仍然生效', async () => {
    await seed(ROOT, `${ROOT}/memories`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(`${ROOT}/memories`),
      { mode: 'restricted', entries: [allow('user:bob', 3)] },
      'user:alice',
    );

    const bob = createService({ subject: 'user:bob' });
    expect(await bob.check(Uri.parse(`${ROOT}/memories`), 3)).toBe(true);
    expect(await bob.check(Uri.parse(`${ROOT}/memories`), 7)).toBe(false);
  });
});

describe('求值不变量', () => {
  it('同节点 deny 优先：allow write + deny write → 无权限', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [allow('user:bob', 3), deny('user:bob', 3)] },
      'user:alice',
    );

    const bob = createService({ subject: 'user:bob' });
    expect(await bob.check(Uri.parse(ROOT), 1)).toBe(false);
    expect(await bob.check(Uri.parse(ROOT), 3)).toBe(false);
  });

  it('owner 不可收回：owner 节点上有 user:alice = deny，alice 依然 manage', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [deny('user:alice', 7)] },
      'user:alice',
    );

    expect(await service.check(Uri.parse(ROOT), 7)).toBe(true);
    expect(await service.check(Uri.parse(ROOT), 1)).toBe(true);
    expect(permissionsOf(ROOT)).toEqual([
      { nodeUri: ROOT, principal: 'user:alice', level: 7, effect: 'allow' },
    ]);
  });

  it('多层叠加：不同层级的 allow 合并后取最高', async () => {
    await seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('user:bob', 1)] }, 'user:alice');
    await service.setAcl(
      Uri.parse(`${ROOT}/memories`),
      { mode: 'inherit', entries: [allow('user:bob', 3)] },
      'user:alice',
    );

    const bob = createService({ subject: 'user:bob' });
    expect(await bob.check(Uri.parse(ROOT), 1)).toBe(true);
    expect(await bob.check(Uri.parse(ROOT), 3)).toBe(false);
    expect(await bob.check(Uri.parse(`${ROOT}/memories/deep`), 3)).toBe(true);
  });
});

describe('退组立即生效', () => {
  it('组身份每次重新展开：去掉组后同一份物化表立即失去权限', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 3)] }, 'user:alice');

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    expect(await member.check(Uri.parse(ROOT), 3)).toBe(true);

    const outsider = createService({ subject: 'user:bob', groups: [] });
    expect(await outsider.check(Uri.parse(ROOT), 3)).toBe(false);
    expect(await outsider.check(Uri.parse(ROOT), 1)).toBe(false);
  });
});

describe('物化', () => {
  it('setAcl 重算整棵子树', async () => {
    const targets = [ROOT, `${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/c`];
    await seed(...targets);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');
    for (const target of targets) {
      expect(permissionsOf(target)).toEqual(
        expect.arrayContaining([
          { nodeUri: target, principal: 'group:eng', level: 1, effect: 'allow' },
          { nodeUri: target, principal: 'user:alice', level: 7, effect: 'allow' },
        ]),
      );
    }

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 3)] }, 'user:alice');
    for (const target of targets) {
      expect(permissionsOf(target).find((row) => row.principal === 'group:eng')?.level).toBe(3);
    }
  });

  it('段边界：alice 的 setAcl 不影响 alice2 的子树', async () => {
    await seed(ROOT, `${ROOT}/a`, 'comem://user/alice2', 'comem://user/alice2/a');
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.ensureRootPreset(Uri.parse('comem://user/alice2'));
    const before = permissionsOf('comem://user/alice2/a');

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    expect(permissionsOf('comem://user/alice2/a')).toEqual(before);
  });

  it('文档节点继承所在目录的权限', async () => {
    await seed(ROOT, `${ROOT}/memories`);
    await seedDocument(`${ROOT}/memories/note.md`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(`${ROOT}/memories`),
      { mode: 'inherit', entries: [allow('group:eng', 1)] },
      'user:alice',
    );

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    expect(await member.check(Uri.parse(`${ROOT}/memories/note.md`), 1)).toBe(true);
  });

  it('ACL 只能设在目录上', async () => {
    await seed(ROOT, `${ROOT}/memories`);
    await seedDocument(`${ROOT}/memories/note.md`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    await expectComemError(
      () =>
        service.setAcl(
          Uri.parse(`${ROOT}/memories/note.md`),
          { mode: 'inherit', entries: [] },
          'user:alice',
        ),
      'INVALID_ARGUMENT',
    );
  });
});

describe('权限检查', () => {
  it('setAcl 无 manage 抛 PERMISSION_DENIED', async () => {
    await seed(ROOT);
    await createService().ensureRootPreset(Uri.parse(ROOT));

    await expectComemError(
      () =>
        createService({ subject: 'user:bob' }).setAcl(
          Uri.parse(ROOT),
          { mode: 'inherit', entries: [] },
          'user:bob',
        ),
      'PERMISSION_DENIED',
    );
  });

  it('getAcl 无 manage 抛 PERMISSION_DENIED', async () => {
    await seed(ROOT);
    await createService().ensureRootPreset(Uri.parse(ROOT));

    await expectComemError(
      () => createService({ subject: 'user:bob' }).getAcl(Uri.parse(ROOT), 'user:bob'),
      'PERMISSION_DENIED',
    );
  });

  it('未物化的节点对任何人不可见', async () => {
    expect(await createService().check(Uri.parse('comem://user/alice/none'), 1)).toBe(false);
  });

  it('filterReadable 批量：10 个 URI 只查一次', async () => {
    const uris = Array.from({ length: 10 }, (_, index) => `${ROOT}/m${index}`);
    await seed(ROOT, ...uris);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    const spy = vi.spyOn(permissions, 'readableUris');
    const readable = await service.filterReadable(uris.map((uri) => Uri.parse(uri)));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(readable).toEqual(new Set(uris));
  });

  it('filterReadable 空输入不查库', async () => {
    const spy = vi.spyOn(permissions, 'readableUris');
    await expect(createService().filterReadable([])).resolves.toEqual(new Set());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('事务与反查表', () => {
  it('aclFile.write 抛错时 node_permission 未变', async () => {
    await seed(ROOT, `${ROOT}/a`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    const before = permissionsOf(`${ROOT}/a`);

    vi.spyOn(aclFile, 'write').mockRejectedValueOnce(new Error('磁盘满'));

    await expect(
      service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice'),
    ).rejects.toThrow('磁盘满');

    expect(permissionsOf(`${ROOT}/a`)).toEqual(before);
  });

  it('acl_entry 与 node_permission 同步更新', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    expect(aclEntriesOf(ROOT)).toEqual([
      { uri: ROOT, principal: 'group:eng', level: 1, effect: 'allow' },
    ]);
    expect(permissionsOf(ROOT)).toEqual([
      { nodeUri: ROOT, principal: 'group:eng', level: 1, effect: 'allow' },
      { nodeUri: ROOT, principal: 'user:alice', level: 7, effect: 'allow' },
    ]);
  });

  it('getAcl 的 effective 与 check 结果一致', async () => {
    await seed(ROOT, `${ROOT}/a`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    const snapshot = await service.getAcl(Uri.parse(ROOT), 'user:alice');
    const bob = createService({ subject: 'user:bob', groups: ['group:eng'] });

    const levels = new Set<AclLevel>();
    for (const principal of bob.resolvePrincipals('user:bob', ['group:eng'])) {
      for (const level of snapshot.effective.get(principal) ?? []) {
        levels.add(level);
      }
    }

    for (const action of [1, 3, 7] as const) {
      const satisfied = [...levels].some((level) => levelSatisfies(level, action));
      expect(satisfied).toBe(await bob.check(Uri.parse(ROOT), action));
    }
  });
});

/**
 * 回归：物化表必须能表达 deny（架构文档 §12.2 不变量 2）。
 *
 * 修复前 `node_permission` 只有 level，物化阶段遇到「有效权限为空」直接跳过，
 * 于是 `user:alice = deny` 在检索侧消失，alice 通过 `user:* = allow` 读到了
 * 本应被拒绝的节点。这个用例同时覆盖链式求值、批量过滤与 FTS 检索三条读路径。
 */
describe('回归：deny 必须被物化', () => {
  const BOB_ROOT = 'comem://user/bob';
  const RESTRICTED = `${BOB_ROOT}/restricted`;

  async function seedRestricted(): Promise<void> {
    await seed(BOB_ROOT, RESTRICTED);
    const bob = createService({ subject: 'user:bob' });
    await bob.ensureRootPreset(Uri.parse(BOB_ROOT));
    await bob.setAcl(
      Uri.parse(RESTRICTED),
      { mode: 'restricted', entries: [allow('user:*', 1), deny('user:alice', 1)] },
      'user:bob',
    );
  }

  it('alice 被 deny 挡住，bob 通过 user:* 可读', async () => {
    await seedRestricted();
    const alice = createService({ subject: 'user:alice' });
    const bob = createService({ subject: 'user:bob' });

    expect(await alice.check(Uri.parse(RESTRICTED), 1)).toBe(false);
    expect(await bob.check(Uri.parse(RESTRICTED), 1)).toBe(true);
    expect(await alice.filterReadable([Uri.parse(RESTRICTED)])).toEqual(new Set());
  });

  it('FTS 检索同样挡住 alice', async () => {
    await seedRestricted();
    const index = new SqliteFtsIndex({ db, logger });
    await index.upsert([
      {
        uri: RESTRICTED,
        parentUri: BOB_ROOT,
        scope: 'user',
        kind: 'directory',
        contextType: 'memory',
        memoryType: null,
        level: 'L0',
        abstract: null,
        content: '记忆',
        bodyDigest: 'digest',
        size: 2,
        updatedAt: '2026-11-08T00:00:00.000Z',
        status: 'active',
      },
    ]);

    const alice = createService({ subject: 'user:alice' });
    const bob = createService({ subject: 'user:bob' });
    const hits = await index.search({
      text: '记忆',
      scopes: [BOB_ROOT],
      principals: alice.resolvePrincipals('user:alice', []),
      limit: 10,
    });
    expect(hits.map((hit) => hit.uri)).not.toContain(RESTRICTED);

    const bobHits = await index.search({
      text: '记忆',
      scopes: [BOB_ROOT],
      principals: bob.resolvePrincipals('user:bob', []),
      limit: 10,
    });
    expect(bobHits.map((hit) => hit.uri)).toContain(RESTRICTED);
  });
});

describe('通配与 deny 物化', () => {
  it('user:* = allow 且没有 deny 时任何人可读', async () => {
    const target = `${ROOT}/public`;
    await seed(ROOT, target);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(target),
      { mode: 'restricted', entries: [allow('user:*', 1)] },
      'user:alice',
    );

    expect(permissionsOf(target)).toEqual(
      expect.arrayContaining([
        { nodeUri: target, principal: 'user:*', level: 1, effect: 'allow' },
      ]),
    );
    expect(await createService({ subject: 'user:bob' }).check(Uri.parse(target), 1)).toBe(true);
  });

  it('user:* = deny 时任何人不可读，owner 仍然 manage', async () => {
    const target = `${ROOT}/secret`;
    await seed(ROOT, target);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(target),
      { mode: 'restricted', entries: [deny('user:*', 1)] },
      'user:alice',
    );

    // user:* 是通配符，不是「被拒绝的人」：不能给它写 deny 行，否则 owner 一起被挡掉。
    expect(permissionsOf(target)).toEqual([
      { nodeUri: target, principal: 'user:alice', level: 7, effect: 'allow' },
    ]);
    expect(await createService({ subject: 'user:bob' }).check(Uri.parse(target), 1)).toBe(false);
    expect(await createService({ subject: 'user:alice' }).check(Uri.parse(target), 7)).toBe(true);
  });

  it('同一主体 allow + deny：物化结果是 deny，查询与链式求值一致', async () => {
    const target = `${ROOT}/mixed`;
    await seed(ROOT, target);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(target),
      { mode: 'restricted', entries: [allow('user:bob', 7), deny('user:bob', 1)] },
      'user:alice',
    );

    expect(permissionsOf(target)).toEqual(
      expect.arrayContaining([
        { nodeUri: target, principal: 'user:bob', level: 1, effect: 'deny' },
      ]),
    );
    const bob = createService({ subject: 'user:bob' });
    for (const action of [1, 3, 7] as const) {
      expect(await bob.check(Uri.parse(target), action)).toBe(false);
    }
  });

  it('materializeNode：新建节点继承父目录的有效权限', async () => {
    const parent = `${ROOT}/memories`;
    const target = `${parent}/note.md`;
    await seed(ROOT, parent);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(parent),
      { mode: 'inherit', entries: [allow('group:eng', 3)] },
      'user:alice',
    );
    await seedDocument(target);
    expect(permissionsOf(target)).toEqual([]);

    await service.materializeNode(Uri.parse(target));

    expect(permissionsOf(target)).toEqual([
      { nodeUri: target, principal: 'group:eng', level: 3, effect: 'allow' },
      { nodeUri: target, principal: 'user:alice', level: 7, effect: 'allow' },
    ]);
    expect(
      await createService({ subject: 'user:bob', groups: ['group:eng'] }).check(
        Uri.parse(target),
        3,
      ),
    ).toBe(true);
  });

  it('materializeNode 从父目录继承 deny（父目录被 deny 的主体在子节点也不可读）', async () => {
    const parent = `${ROOT}/blocked`;
    const child = `${parent}/note.md`;
    await seed(ROOT, parent);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(parent),
      { mode: 'restricted', entries: [allow('user:*', 1), deny('user:bob', 1)] },
      'user:alice',
    );
    await seedDocument(child);

    await service.materializeNode(Uri.parse(child));

    expect(permissionsOf(child)).toEqual(
      expect.arrayContaining([
        { nodeUri: child, principal: 'user:*', level: 1, effect: 'allow' },
        { nodeUri: child, principal: 'user:bob', level: 1, effect: 'deny' },
      ]),
    );
    expect(await createService({ subject: 'user:bob' }).check(Uri.parse(child), 1)).toBe(false);
  });
});

/**
 * 并发回归：读-改-写必须在同一把 `exact(uri)` 锁内完成。
 *
 * 三条用例都靠 `Promise.all` 制造交错，并用「显式延迟一个写者」把窗口拉宽到
 * 稳定可测：延迟挂在 `aclFile.read` 上——修复后这个读在锁内，延迟只会让另一个
 * 写者排队；去掉锁后这个读在锁外，延迟会让两个写者各拿一份旧条目，后写者整份
 * 覆盖。变异验证：注释掉 `setAcl` / `ensureRootPreset` 的 `withLock`，三条全红。
 */
describe('并发写入不丢条目（§10.6 锁契约回归）', () => {
  /** 给第一次 `aclFile.read` 加延迟：模拟一个慢写者在读到旧快照后才继续。 */
  function slowFirstRead(ms: number): () => void {
    const original = aclFile.read.bind(aclFile);
    let fired = false;
    const spy = vi.spyOn(aclFile, 'read').mockImplementation(async (uri) => {
      const result = await original(uri);
      if (!fired) {
        fired = true;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return result;
    });
    return () => spy.mockRestore();
  }

  it('两个并发 setAcl 到同一目录，两个条目都保留', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    // 两个 transform 各自只加自己那条（等价于 /acl/grant 的锁内读-改-写）。
    const restore = slowFirstRead(50);
    try {
      await Promise.all([
        service.setAcl(
          Uri.parse(ROOT),
          (current) => ({ mode: current.mode, entries: [...current.entries, allow('user:bob', 1)] }),
          'user:alice',
        ),
        service.setAcl(
          Uri.parse(ROOT),
          (current) => ({ mode: current.mode, entries: [...current.entries, allow('user:carol', 1)] }),
          'user:alice',
        ),
      ]);
    } finally {
      restore();
    }

    const file = await aclFile.read(Uri.parse(ROOT));
    const principals = (file?.entries ?? []).map((entry) => entry.principal);
    expect(principals).toContain('user:bob');
    expect(principals).toContain('user:carol');
    expect(principals).toContain('user:alice');
  });

  it('并发 ensureRootPreset 不会丢条目', async () => {
    await seed(GROUP_ROOT);
    const service = createService({ subject: 'user:alice' });

    // 先建立 manage（组根预置），再把文件改回「预置尚未应用」但 alice 仍有 manage 的
    // 状态：这样 ensureRootPreset 会真的走写入分支，与并发 grant 撞车。
    await service.ensureRootPreset(Uri.parse(GROUP_ROOT), 'alice');
    await service.setAcl(
      Uri.parse(GROUP_ROOT),
      { mode: 'inherit', entries: [allow('user:alice', 7)] },
      'user:alice',
    );

    // 并发 grant user:bob 与组根预置。锁外实现里 ensureRootPreset 读到「还没有
    // group:eng 条目」，于是写一份只含预置的整份文件，把 bob 冲掉。
    const restore = slowFirstRead(50);
    try {
      await Promise.all([
        service.setAcl(
          Uri.parse(GROUP_ROOT),
          (current) => ({ mode: current.mode, entries: [...current.entries, allow('user:bob', 1)] }),
          'user:alice',
        ),
        service.ensureRootPreset(Uri.parse(GROUP_ROOT), 'alice'),
      ]);
    } finally {
      restore();
    }

    const file = await aclFile.read(Uri.parse(GROUP_ROOT));
    const principals = (file?.entries ?? []).map((entry) => entry.principal);
    expect(principals).toContain('group:eng');
    expect(principals).toContain('user:alice');
    expect(principals).toContain('user:bob');
  });

  it('purgeSubtree 与 setAcl 并发不死锁', async () => {
    const subtree = [ROOT, `${ROOT}/a`, `${ROOT}/a/b`];
    await seed(...subtree);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [allow('user:bob', 1)] },
      'user:alice',
    );
    await service.setAcl(
      Uri.parse(`${ROOT}/a`),
      { mode: 'inherit', entries: [allow('user:bob', 3)] },
      'user:alice',
    );

    // purgeSubtree 持 tree(ROOT)，setAcl 到子目录要 exact(ROOT/a)：二者冲突但必须
    // 在超时内完成（排队），不能等自己 5 秒后抛 CONFLICT。给足够大的超时保护，
    // 断言 N 秒内 resolve。
    const done = Promise.all([
      service.purgeSubtree(Uri.parse(ROOT)),
      service.setAcl(
        Uri.parse(`${ROOT}/a/b`),
        { mode: 'inherit', entries: [allow('user:dave', 1)] },
        'user:alice',
      ),
    ]);

    await expect(done).resolves.toBeDefined();
  }, 8000);
});

/**
 * 回归：撤权的回滚只有一条路径（`#commitAclRewrites`）。
 *
 * 撤权顺序是「先写 `.acl.json`、再改索引」。中间失败的形态是**提权**：磁盘上
 * 授权已撤、`node_permission` 还留着 allow，求值继续放行，而且不报错。两条撤权
 * 路径（`purgeSubtree` / `purgePrincipal`）各有一份实现时，修好一份不保证另一份
 * 也修好——所以这里对两条路径分别构造「磁盘写成功、索引写入失败」。
 *
 * 断言三件事：失败前磁盘确实被写过清空后的内容（否则回滚是空操作，测了个寂寞）、
 * 失败后磁盘恢复成原内容、索引行停在原值。去掉回滚后磁盘那两条断言会变红。
 */
describe('撤权回滚：磁盘已写、索引写失败', () => {
  /** 记录每次 `.acl.json` 写入并真的落盘，用来确认「先写了清空版本」。 */
  function recordWrites(): { written: AclFile[]; restore: () => void } {
    const written: AclFile[] = [];
    const original = aclFile.write.bind(aclFile);
    const spy = vi.spyOn(aclFile, 'write').mockImplementation(async (uri, file) => {
      written.push(file);
      await original(uri, file);
    });
    return { written, restore: () => spy.mockRestore() };
  }

  it('purgeSubtree：物化写入失败时恢复 .acl.json，node_permission 维持原状', async () => {
    await seed(ROOT, `${ROOT}/a`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [allow('group:eng', 1)] },
      'user:alice',
    );

    const diskBefore = await aclFile.read(Uri.parse(ROOT));
    const rowsBefore = permissionsOf(ROOT);
    expect(rowsBefore.length).toBeGreaterThan(0);

    const writes = recordWrites();
    const failIndex = vi.spyOn(permissions, 'replaceSubtree').mockImplementation(() => {
      throw new Error('索引写入失败');
    });

    try {
      await expect(service.purgeSubtree(Uri.parse(ROOT))).rejects.toThrow('索引写入失败');
    } finally {
      writes.restore();
      failIndex.mockRestore();
    }

    // 失败之前文件已经写成了「条目清空」的版本：回滚不是空操作。
    expect(writes.written[0]?.entries).toEqual([]);
    expect(writes.written.at(-1)).toEqual(diskBefore);
    expect(await aclFile.read(Uri.parse(ROOT))).toEqual(diskBefore);
    expect(permissionsOf(ROOT)).toEqual(rowsBefore);
  });

  it('purgePrincipal：索引行删除失败时恢复 .acl.json，node_permission 维持原状', async () => {
    await seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [allow('group:eng', 1)] },
      'user:alice',
    );

    const diskBefore = await aclFile.read(Uri.parse(ROOT));
    const rowsBefore = permissionsOf(ROOT);
    const entryRowsBefore = aclEntriesOf(ROOT);
    expect(diskBefore?.entries).toEqual([
      { principal: 'group:eng', level: 'read', effect: 'allow' },
    ]);

    const writes = recordWrites();
    // 让 `DELETE FROM acl_entry` 先执行成功，再让 `DELETE FROM node_permission`
    // 失败：回滚必须把前一条删除也撤销掉。
    const originalPrepare = db.prepare.bind(db);
    const failIndex = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM node_permission')) {
        throw new Error('索引写入失败');
      }
      return originalPrepare(sql);
    });

    try {
      await expect(service.purgePrincipal('group:eng')).rejects.toThrow('索引写入失败');
    } finally {
      writes.restore();
      failIndex.mockRestore();
    }

    expect(writes.written[0]?.entries).toEqual([]);
    expect(writes.written.at(-1)).toEqual(diskBefore);
    expect(await aclFile.read(Uri.parse(ROOT))).toEqual(diskBefore);
    expect(permissionsOf(ROOT)).toEqual(rowsBefore);
    expect(aclEntriesOf(ROOT)).toEqual(entryRowsBefore);
  });
});
