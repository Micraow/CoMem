/**
 * 「这个 URI 对当前主体可不可读」的两份 SQL 谓词的行为对拍（架构文档 §8.2、§12.2）。
 *
 * 同一个判定有两份实现：
 *
 * - `adapters/sqlite/retrieval-index.ts` 的 `permissionPredicate`：折进 `search` /
 *   `glob` 的 `EXISTS` 子查询，一次查询完成「匹配 + 权限」；
 * - `adapters/sqlite/permission-repository.ts` 的 `readableUris`：批量 `IN (...)`，
 *   服务「候选已经在内存里」的路径（`grep` 的前置过滤、技能列表、`list` / `tree`）。
 *
 * 两处漂移的后果是可见集合分叉：同一次请求里 `search` 看得到的节点 `grep` 看不到
 * （或反之），用户只能理解为「检索坏了」。`retrieval-index.ts` 文件头写着「两处必须
 * 用同一套谓词」，但两侧各自有测试只保证各自没坏，没有一条用例拿同一份
 * `node_permission` 对拍过。
 *
 * 这里的 fixture 走**生产写路径**物化：`AclService.ensureRootPreset` + `setAcl`
 * 写出 `.acl.json` 并重算整棵子树。所以「祖先目录的授权对子文件生效」是真实继承的
 * 结果（子文件自己没有 ACL 文件，行是物化时按链算出来的），不是用例手抄的行。
 * 另外两格由直接写入构造，因为生产路径在这份 fixture 里写不出来，见 `seedRawStates`。
 *
 * **比较集合，不比较 SQL 字符串**：谓词换个写法不该让测试变红，判定结果变了才该红。
 *
 * 不在本用例要求范围内的口径（只报告，不改）：
 * - `glob` 还有 `status = 'active'` 与「节点自身那一行」的过滤，`readableUris` 只
 *   回答「入参列表里哪些可读」——所以对拍的口径是「同一个节点集合里哪些可读」，
 *   见 `universe()`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, globPrefixPattern, nodeSelfRowSql } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { AclEffect, AclEntry, AclLevel } from '../../../src/domain/acl.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { NodeKind } from '../../../src/domain/node.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';

const ROOT = 'comem://user/alice';
const NOW = new Date('2026-11-09T00:00:00.000Z');

/** 域外且不存在的 URI：不在 `node` 表里，也没有任何权限行。 */
const OUTSIDE = 'comem://user/bob/elsewhere/x.md';

/** 手工写入的 level 0 行所在节点。 */
const LEGACY_ZERO = `${ROOT}/legacy-zero.md`;

/**
 * 手工写入的非规范级别行所在节点。生产写路径只产生 1 / 3 / 7（`isAclLevel`），
 * 2 / 6 只带高位、读位为 0，5 同时带读位与 manage 位。这三格用来对拍两套 SQL
 * 与单节点读路径的位测试是否同结论。
 */
const LEGACY_LEVEL_TWO = `${ROOT}/legacy-level-2.md`;
const LEGACY_LEVEL_SIX = `${ROOT}/legacy-level-6.md`;
const LEGACY_LEVEL_FIVE = `${ROOT}/legacy-level-5.md`;

/**
 * 同一节点上的多条 allow 行。`node_permission` 的主键是
 * `(node_uri, principal)`，所以「多条」只能来自不同主体：`user:bob` 与
 * `group:eng` 都在查询主体集合里，两条授权的并集才是 bob 的级别。
 *
 * - `multi-read`：1 与 4，并集 5 含读位；`MAX(level)` 会取 4、读位为 0。
 * - `multi-no-read`：2 与 4，并集 6 不含读位；三条路径都必须不可读。
 */
const MULTI_READ = `${ROOT}/multi-read.md`;
const MULTI_NO_READ = `${ROOT}/multi-no-read.md`;

/** §12.1 的 read 位。单节点读路径的 `AclAction` 只要求 read。 */
const READ: AclLevel = 1;

/**
 * 物化之后才出现的节点。
 *
 * 索引滞后时这是真实状态（`src/services/index-observer.ts` 有专门的补写路径）：
 * 节点在 `node` 表里，`node_permission` 里一行都没有。它也是矩阵里「被 deny 的
 * 祖先下的子文件、子文件自己没有权限行」那一格。
 */
const LATE = `${ROOT}/deny-dir/late.md`;

interface SeedNode {
  readonly uri: string;
  readonly kind: NodeKind;
  readonly level: Level;
  /** 这一格在矩阵里的意思，失败时帮助定位。 */
  readonly cell: string;
}

/**
 * 物化之前就存在的节点。目录只写 L0（节点自身那一行），文件写 L2，与真实索引一致。
 *
 * `deny-dir/` 的 ACL 是「allow group:eng + deny user:bob」，子文件自己没有任何
 * `.acl.json`；物化会把这两行继承下去，所以子文件在矩阵里是「祖先 deny 对子文件
 * 生效」的证据，而不是「子文件没有行」。
 */
const NODES: readonly SeedNode[] = [
  { uri: `${ROOT}/read-dir`, kind: 'directory', level: 'L0', cell: '直接 read（level 1）' },
  { uri: `${ROOT}/read-dir/note.md`, kind: 'document', level: 'L2', cell: '祖先 read 继承到子文件' },
  { uri: `${ROOT}/write-dir`, kind: 'directory', level: 'L0', cell: '直接 write（level 3）' },
  { uri: `${ROOT}/write-dir/note.md`, kind: 'document', level: 'L2', cell: '祖先 write 继承到子文件' },
  { uri: `${ROOT}/manage-dir`, kind: 'directory', level: 'L0', cell: '直接 manage（level 7）' },
  { uri: `${ROOT}/manage-dir/note.md`, kind: 'document', level: 'L2', cell: '祖先 manage 继承到子文件' },
  { uri: `${ROOT}/deny-dir`, kind: 'directory', level: 'L0', cell: 'allow + deny 同节点，deny 优先' },
  { uri: `${ROOT}/deny-dir/blocked.md`, kind: 'document', level: 'L2', cell: '祖先 deny 继承到子文件' },
  { uri: `${ROOT}/private`, kind: 'directory', level: 'L0', cell: '没有 bob 的权限行' },
  { uri: `${ROOT}/private/secret.md`, kind: 'document', level: 'L2', cell: '没有 bob 的权限行' },
  { uri: `${ROOT}/carol-dir`, kind: 'directory', level: 'L0', cell: '只授权 carol，bob 不可见' },
  { uri: `${ROOT}/carol-dir/note.md`, kind: 'document', level: 'L2', cell: 'carol 的授权继承到子文件' },
  { uri: LEGACY_ZERO, kind: 'document', level: 'L2', cell: 'level 0 的 allow 行不算 read' },
  { uri: LEGACY_LEVEL_TWO, kind: 'document', level: 'L2', cell: '手工 level 2：只有 WRITE 位' },
  { uri: LEGACY_LEVEL_SIX, kind: 'document', level: 'L2', cell: '手工 level 6：WRITE + MANAGE 位' },
  { uri: LEGACY_LEVEL_FIVE, kind: 'document', level: 'L2', cell: '手工 level 5：READ + MANAGE 位' },
  { uri: MULTI_READ, kind: 'document', level: 'L2', cell: '多行 allow：1 与 4，并集 5 含读位' },
  {
    uri: MULTI_NO_READ,
    kind: 'document',
    level: 'L2',
    cell: '多行 allow：2 与 4，并集 6 不含读位',
  },
];

/** 三个主体。`user:*` 与 `AclService.resolvePrincipals` 的输出同形；fixture 没有通配条目。 */
const SUBJECTS = [
  { name: 'bob（组员）', principals: ['user:bob', 'group:eng', 'user:*'] },
  { name: 'carol', principals: ['user:carol', 'user:*'] },
  { name: 'alice（owner）', principals: ['user:alice', 'user:*'] },
] as const;

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let permissions: PermissionRepository;
let index: SqliteFtsIndex;
let acl: AclService;

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

function record(uri: string, kind: NodeKind, level: Level): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind,
    contextType: kind === 'directory' ? 'resource' : 'memory',
    memoryType: kind === 'document' ? 'preferences' : null,
    level,
    abstract: null,
    content: '',
    bodyDigest: 'digest',
    size: 0,
    updatedAt: NOW.toISOString(),
    status: 'active',
  };
}

function entry(principal: string, level: AclLevel, effect: AclEffect = 'allow'): AclEntry {
  return { principal, level, effect };
}

async function setDirAcl(
  acl: AclService,
  owner: readonly string[],
  uri: string,
  entries: readonly AclEntry[],
): Promise<void> {
  await acl.setAcl(Uri.parse(uri), { mode: 'inherit', entries }, 'user:alice', owner);
}

/** 1) 索引行：根 + 物化前就存在的节点。 */
async function seedIndex(): Promise<void> {
  await index.upsert([
    { ...record(ROOT, 'directory', 'L0'), parentUri: '' },
    ...NODES.map((node) => record(node.uri, node.kind, node.level)),
  ]);
}

/** 2) 生产写路径：根预置（owner 恒 manage）+ 五条子目录 ACL，各自重算整棵子树。 */
async function materializeAcl(): Promise<void> {
  acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions,
    nodes: new NodeRepository({ db, logger }),
    logger,
    locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
  });
  const owner = acl.resolvePrincipals('user:alice', []);

  await acl.ensureRootPreset(Uri.parse(ROOT));
  await setDirAcl(acl, owner, `${ROOT}/read-dir`, [entry('user:bob', 1)]);
  await setDirAcl(acl, owner, `${ROOT}/write-dir`, [entry('user:bob', 3)]);
  await setDirAcl(acl, owner, `${ROOT}/manage-dir`, [entry('user:bob', 7)]);
  // 同一目录上同时 allow 与 deny：deny 优先（§12.2 不变量 2）。物化把 bob 写成
  // deny 行、group:eng 写成 allow 行；因为没有 allow 行，光看「有没有 allow」的
  // 谓词会把 bob 放进来，必须靠 deny 子查询压掉。
  await setDirAcl(acl, owner, `${ROOT}/deny-dir`, [
    entry('group:eng', 1),
    entry('user:bob', 1, 'deny'),
  ]);
  await setDirAcl(acl, owner, `${ROOT}/carol-dir`, [entry('user:carol', 1)]);
}

/**
 * 3) 生产路径在这份 fixture 里写不出来的几格。
 *
 * - level 0 / 2 / 6 / 5 的 allow 行：`isAclLevel` 只认 1 / 3 / 7，物化永远写
 *   `maxLevel()`，所以这些级别只可能来自旧数据或手工 SQL。没有这些行，去掉任一侧
 *   的读位判定都不会改变结果，测试就没有区分力。
 * - 多行 allow：`node_permission` 同一主体只能有一行，构造多行只能换主体。
 * - 物化之后才出现的节点：插在 `materializeAcl()` 之后，保证它真的一行都没有。
 *
 * 先物化再插行：这几行必须在 `alice` 的继承行写完之后落地，否则物化会按目录链
 * 重算、把它们覆盖掉。
 */
async function seedRawStates(): Promise<void> {
  const insert = db.prepare(
    'INSERT INTO node_permission (node_uri, principal, level, effect) VALUES (?, ?, ?, ?)',
  );
  insert.run(LEGACY_ZERO, 'user:bob', 0, 'allow');
  insert.run(LEGACY_LEVEL_TWO, 'user:bob', 2, 'allow');
  insert.run(LEGACY_LEVEL_SIX, 'user:bob', 6, 'allow');
  insert.run(LEGACY_LEVEL_FIVE, 'user:bob', 5, 'allow');
  insert.run(MULTI_READ, 'user:bob', 1, 'allow');
  insert.run(MULTI_READ, 'group:eng', 4, 'allow');
  insert.run(MULTI_NO_READ, 'user:bob', 2, 'allow');
  insert.run(MULTI_NO_READ, 'group:eng', 4, 'allow');
  await index.upsert([record(LATE, 'document', 'L2')]);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-permission-visible-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  permissions = new PermissionRepository({ db, logger });
  index = new SqliteFtsIndex({ db, logger });
  await seedIndex();
  await materializeAcl();
  await seedRawStates();
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * 对拍的口径：`node` 表里根的子节点（「节点自身那一行」），再加一条域外 URI。
 *
 * 根自己不在口径里：`glob` 的 `**` 匹配的是「根之下」，而 `readableUris` 只要在
 * 入参里就会回答。把根放进来比较，两边差的是路径范围，不是权限谓词。
 */
function universe(): string[] {
  return [
    ...db
      .prepare(`SELECT uri FROM node WHERE uri GLOB ? AND ${nodeSelfRowSql()} ORDER BY uri`)
      .all(globPrefixPattern(ROOT))
      .map((row) => String(row['uri'])),
    OUTSIDE,
  ];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** 路径 A：批量 `IN (...)` 过滤（`grep` 候选、技能列表、`list` / `tree` 用）。 */
function readableVisible(principals: readonly string[]): string[] {
  return sorted(permissions.readableUris(universe(), principals));
}

/** 路径 B：`permissionPredicate` 折进 SQL 的 `glob`（外部可观察的那条）。 */
async function globVisible(principals: readonly string[]): Promise<string[]> {
  return sorted(
    await index.glob({ pattern: '**', scopes: [ROOT], principals, limit: 100 }),
  );
}

/** bob：只有三条 allow 子树的节点可读，加上多行 allow 里并集含读位的那个。 */
const BOB_VISIBLE = [
  `${ROOT}/legacy-level-5.md`,
  `${ROOT}/manage-dir`,
  `${ROOT}/manage-dir/note.md`,
  `${ROOT}/multi-read.md`,
  `${ROOT}/read-dir`,
  `${ROOT}/read-dir/note.md`,
  `${ROOT}/write-dir`,
  `${ROOT}/write-dir/note.md`,
];

/** carol：只有自己那条授权可读。 */
const CAROL_VISIBLE = [`${ROOT}/carol-dir`, `${ROOT}/carol-dir/note.md`];

/** alice：owner 恒 manage，所以物化过的节点全部可读；`LATE` 没有行，owner 也查不到。 */
const ALICE_VISIBLE = sorted(NODES.map((node) => node.uri));

describe('ACL 可读谓词：readableUris 与 glob', () => {
  it('同一份 node_permission：三个主体的可见集合完全相同', async () => {
    expect(universe()).toEqual(sorted([...NODES.map((node) => node.uri), LATE, OUTSIDE]));

    for (const subject of SUBJECTS) {
      const viaBatch = readableVisible(subject.principals);
      const viaGlob = await globVisible(subject.principals);

      expect(viaGlob, `${subject.name}：glob 与 readableUris 的可见集合`).toEqual(viaBatch);
    }
  });

  it('矩阵：read / write / manage、继承、无行、level 0、域外都按节点上的行判定', () => {
    expect(readableVisible(SUBJECTS[0].principals)).toEqual(BOB_VISIBLE);
    expect(readableVisible(SUBJECTS[1].principals)).toEqual(CAROL_VISIBLE);
    expect(readableVisible(SUBJECTS[2].principals)).toEqual(ALICE_VISIBLE);

    // 不是「都返回全集」：两个非 owner 主体的集合不同，也都不等于 owner 的集合。
    expect(BOB_VISIBLE).not.toEqual(CAROL_VISIBLE);
    expect(BOB_VISIBLE).not.toEqual(ALICE_VISIBLE);
    expect(CAROL_VISIBLE).not.toEqual(ALICE_VISIBLE);
  });

  it('deny 优先：allow group:eng 与 deny bob 并存时 bob 不可见，子文件同样', async () => {
    const denied = `${ROOT}/deny-dir`;
    const inherited = `${ROOT}/deny-dir/blocked.md`;

    for (const visible of [
      readableVisible(SUBJECTS[0].principals),
      await globVisible(SUBJECTS[0].principals),
    ]) {
      expect(visible).not.toContain(denied);
      expect(visible).not.toContain(inherited);
    }
    // 同一张表里 group:eng 的 allow 是存在的：deny 挡住的是「同请求主体集合里的
    // 某个人被拒」，不是「这条 grant 不存在」。
    expect(
      db
        .prepare(
          `SELECT principal, level, effect FROM node_permission
            WHERE node_uri = ? ORDER BY principal ASC`,
        )
        .all(denied)
        .map((row) => [String(row['principal']), Number(row['level']), String(row['effect'])]),
    ).toEqual([
      ['group:eng', 1, 'allow'],
      ['user:alice', 7, 'allow'],
      ['user:bob', 1, 'deny'],
    ]);
  });

  it('level 0 的 allow 行不算 read：两条路径都不返回', async () => {
    for (const visible of [
      readableVisible(SUBJECTS[0].principals),
      await globVisible(SUBJECTS[0].principals),
    ]) {
      expect(visible).not.toContain(LEGACY_ZERO);
    }
    expect(
      db
        .prepare('SELECT level, effect FROM node_permission WHERE node_uri = ? AND principal = ?')
        .get(LEGACY_ZERO, 'user:bob'),
    ).toMatchObject({ level: 0, effect: 'allow' });
  });

  it('非规范级别：level 2 / 6 三处都不可读，level 5 三处都可读', async () => {
    const bob = SUBJECTS[0].principals;
    expect(
      [LEGACY_LEVEL_TWO, LEGACY_LEVEL_SIX, LEGACY_LEVEL_FIVE].map((uri) =>
        Number(
          db
            .prepare('SELECT level FROM node_permission WHERE node_uri = ? AND principal = ?')
            .get(uri, 'user:bob')?.['level'],
        ),
      ),
    ).toEqual([2, 6, 5]);

    const viaBatch = readableVisible(bob);
    const viaGlob = await globVisible(bob);

    // 2 / 6 带高位但不带读位：`p.level >= 1` 会把它们判成可读，位测试判不可读。
    for (const uri of [LEGACY_LEVEL_TWO, LEGACY_LEVEL_SIX]) {
      expect(viaBatch, `readableUris 返回了 ${uri}`).not.toContain(uri);
      expect(viaGlob, `glob 返回了 ${uri}`).not.toContain(uri);
      expect(await acl.check(Uri.parse(uri), READ, bob), `单节点读允许了 ${uri}`).toBe(false);
    }

    // 5 同时带读位与 manage 位：判定必须是「读位为真」，不是 `level = 1`。
    expect(viaBatch).toContain(LEGACY_LEVEL_FIVE);
    expect(viaGlob).toContain(LEGACY_LEVEL_FIVE);
    expect(await acl.check(Uri.parse(LEGACY_LEVEL_FIVE), READ, bob)).toBe(true);
  });

  it('多行 allow：级别并集的读位与 readableUris 同结论', async () => {
    const bob = SUBJECTS[0].principals;

    // 同一节点两条 allow 行，分别来自 user:bob 与 group:eng（主键是
    // `(node_uri, principal)`，同一主体只能有一行）。1 与 4 的 max 是 4、并集是 5：
    // 只有并集保留了 user:bob 那行的读位。
    expect(
      db
        .prepare(
          `SELECT principal, level FROM node_permission
            WHERE node_uri = ? AND effect = 'allow' ORDER BY principal ASC`,
        )
        .all(MULTI_READ)
        .map((row) => [String(row['principal']), Number(row['level'])]),
    ).toEqual([
      ['group:eng', 4],
      ['user:alice', 7],
      ['user:bob', 1],
    ]);

    const viaBatch = readableVisible(bob);
    const viaGlob = await globVisible(bob);
    expect(viaBatch).toContain(MULTI_READ);
    expect(viaGlob).toContain(MULTI_READ);
    // 单节点读路径：`maxLevel` + `levelSatisfies(level, READ)`。
    expect(await acl.check(Uri.parse(MULTI_READ), READ, bob)).toBe(true);

    // 反向：2 与 4 的并集是 6，读位为 0；两条路径都不能放行，证明上面的断言不是
    // 「多行一律可读」。
    expect(viaBatch).not.toContain(MULTI_NO_READ);
    expect(viaGlob).not.toContain(MULTI_NO_READ);
    expect(await acl.check(Uri.parse(MULTI_NO_READ), READ, bob)).toBe(false);
  });
});
