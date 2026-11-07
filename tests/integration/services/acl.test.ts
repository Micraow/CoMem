import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import {
  PermissionRepository,
  type PermissionRow,
} from '../../../src/adapters/sqlite/permission-repository.js';
import { levelSatisfies } from '../../../src/domain/acl.js';
import type { AclEntry, AclLevel } from '../../../src/domain/acl.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { NodeKind } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';

const ROOT = 'comem://user/alice';
const GROUP_ROOT = 'comem://group/eng';

let dataDir: string;
let db: DatabaseSync;
let aclFile: AclFileStore;
let permissions: PermissionRepository;
let nodes: NodeRepository;
let logger: Logger;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-acl-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  aclFile = new AclFileStore({ dataDir, logger });
  permissions = new PermissionRepository({ db, logger });
  nodes = new NodeRepository({ db, logger });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function createService(
  options: {
    readonly subject?: string;
    readonly groups?: readonly string[];
    readonly groupDefaultLevel?: AclLevel;
  } = {},
): AclService {
  return new AclService({
    dataDir,
    db,
    aclFile,
    permissions,
    nodes,
    logger,
    subject: options.subject ?? 'user:alice',
    groups: options.groups ?? [],
    groupDefaultLevel: options.groupDefaultLevel,
  });
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

function seed(...uris: readonly string[]): void {
  nodes.upsert(uris.map((uri) => nodeRow(uri)));
}

function seedDocument(uri: string): void {
  nodes.upsert([nodeRow(uri, 'document')]);
}

function permissionsOf(nodeUri: string): readonly PermissionRow[] {
  return db
    .prepare(
      'SELECT node_uri, principal, level FROM node_permission WHERE node_uri = ? ORDER BY principal ASC',
    )
    .all(nodeUri)
    .map((row) => ({
      nodeUri: String(row['node_uri']),
      principal: String(row['principal']),
      level: Number(row['level']) as AclLevel,
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

describe('继承与切断', () => {
  it('深层节点没有 .acl.json 时继承到根', async () => {
    seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    const member = createService({ subject: 'user:bob', groups: ['group:eng'] });
    const deep = Uri.parse(`${ROOT}/memories/deep`);
    expect(await member.check(deep, 1)).toBe(true);
    expect(await member.check(deep, 3)).toBe(false);
  });

  it('restricted 切断继承：祖先 allow 不生效', async () => {
    seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
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
    seed(ROOT, `${ROOT}/memories`);
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
    seed(ROOT);
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
    seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.setAcl(
      Uri.parse(ROOT),
      { mode: 'inherit', entries: [deny('user:alice', 7)] },
      'user:alice',
    );

    expect(await service.check(Uri.parse(ROOT), 7)).toBe(true);
    expect(await service.check(Uri.parse(ROOT), 1)).toBe(true);
    expect(permissionsOf(ROOT)).toEqual([{ nodeUri: ROOT, principal: 'user:alice', level: 7 }]);
  });

  it('多层叠加：不同层级的 allow 合并后取最高', async () => {
    seed(ROOT, `${ROOT}/memories`, `${ROOT}/memories/deep`);
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
    seed(ROOT);
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
    seed(...targets);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');
    for (const target of targets) {
      expect(permissionsOf(target)).toEqual(
        expect.arrayContaining([
          { nodeUri: target, principal: 'group:eng', level: 1 },
          { nodeUri: target, principal: 'user:alice', level: 7 },
        ]),
      );
    }

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 3)] }, 'user:alice');
    for (const target of targets) {
      expect(permissionsOf(target).find((row) => row.principal === 'group:eng')?.level).toBe(3);
    }
  });

  it('段边界：alice 的 setAcl 不影响 alice2 的子树', async () => {
    seed(ROOT, `${ROOT}/a`, 'comem://user/alice2', 'comem://user/alice2/a');
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));
    await service.ensureRootPreset(Uri.parse('comem://user/alice2'));
    const before = permissionsOf('comem://user/alice2/a');

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    expect(permissionsOf('comem://user/alice2/a')).toEqual(before);
  });

  it('文档节点继承所在目录的权限', async () => {
    seed(ROOT, `${ROOT}/memories`);
    seedDocument(`${ROOT}/memories/note.md`);
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
    seed(ROOT, `${ROOT}/memories`);
    seedDocument(`${ROOT}/memories/note.md`);
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
    seed(ROOT);
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
    seed(ROOT);
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
    seed(ROOT, ...uris);
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
    seed(ROOT, `${ROOT}/a`);
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
    seed(ROOT);
    const service = createService();
    await service.ensureRootPreset(Uri.parse(ROOT));

    await service.setAcl(Uri.parse(ROOT), { mode: 'inherit', entries: [allow('group:eng', 1)] }, 'user:alice');

    expect(permissions.entriesOf(ROOT)).toEqual([
      { uri: ROOT, principal: 'group:eng', level: 1, effect: 'allow' },
    ]);
    expect(permissionsOf(ROOT)).toEqual([
      { nodeUri: ROOT, principal: 'group:eng', level: 1 },
      { nodeUri: ROOT, principal: 'user:alice', level: 7 },
    ]);
  });

  it('getAcl 的 effective 与 check 结果一致', async () => {
    seed(ROOT, `${ROOT}/a`);
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
