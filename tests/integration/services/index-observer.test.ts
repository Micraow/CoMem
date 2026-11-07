import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import { AclService } from '../../../src/services/acl.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const ROOT = 'comem://user/alice';
const SUBJECT = 'user:alice';
const PRINCIPALS = [SUBJECT, 'user:*'];

interface Harness {
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly filesystem: FileSystemService;
  readonly index: SqliteFtsIndex;
  readonly observer: IndexObserver;
  readonly summary: SummaryService;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  close(): Promise<void>;
}

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

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-index-observer-'));
  const db = openDatabase(':memory:');
  runMigrations(db);

  const logger = createLogger();
  const store = new ContentStore({ dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const aclFile = new AclFileStore({ dataDir, logger });
  const permissions = new PermissionRepository({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  const index = new SqliteFtsIndex({ db, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });

  const acl = new AclService({
    dataDir,
    db,
    aclFile,
    permissions,
    nodes,
    logger,
    subject: SUBJECT,
  });
  await acl.ensureRootPreset(Uri.parse(ROOT));

  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    generator: new RuleSummarizer(),
    logger,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
    locks,
  });

  const observer = new IndexObserver({
    store,
    index,
    acl,
    summary,
    nodes,
    permissions,
    logger,
  });
  const filesystem = new FileSystemService({
    store,
    locks,
    // 与生产装配同一份：写路径在物化表缺行时先物化再求权（见 `InheritingAuthorizer`）。
    authorizer: new InheritingAuthorizer(acl, store),
    logger,
    observers: [observer],
  });

  return {
    dataDir,
    db,
    store,
    filesystem,
    index,
    observer,
    summary,
    permissions,
    nodes,
    close: async () => {
      await observer.drain();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

function permissionRowsOf(uri: string): readonly Record<string, unknown>[] {
  return harness.db
    .prepare('SELECT node_uri, principal, level, effect FROM node_permission WHERE node_uri = ?')
    .all(uri);
}

describe('IndexObserver.onNodeWritten', () => {
  it('写文件后索引能命中，contextType / memoryType / abstract 从磁盘读回', async () => {
    const file = Uri.parse(`${ROOT}/memories/preferences/code-style.md`);
    await harness.filesystem.write(file, '用户偏好 TypeScript 严格模式。', {
      frontmatter: { summary: '偏好 TypeScript 严格模式' },
    });
    await harness.observer.drain();

    const hits = await harness.index.search({
      text: 'TypeScript',
      scopes: [ROOT],
      principals: PRINCIPALS,
      limit: 10,
    });
    const hit = hits.find((candidate) => candidate.uri === file.toString());
    expect(hit).toBeDefined();
    expect(hit?.contextType).toBe('memory');
    // 写入用的是通用 frontmatter（没有 memory_type），memoryType 保持 null。
    expect(hit?.memoryType).toBeNull();
    expect(hit?.abstract).toBe('偏好 TypeScript 严格模式');

    const row = harness.nodes.get(file.toString());
    expect(row?.kind).toBe('document');
    expect(row?.level).toBe('L2');
    expect(row?.bodyDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('记忆文件的 memoryType / status 从 frontmatter 推出', async () => {
    const file = Uri.parse(`${ROOT}/memories/experiences/monorepo.md`);
    // 复核闸门（§11.6）：experiences 写入时是 pending。
    await harness.filesystem.write(
      file,
      ['---', 'memory_type: experiences', 'status: pending', '---', '', '迁移到 monorepo。'].join('\n'),
    );
    await harness.observer.drain();

    const row = harness.nodes.get(file.toString());
    expect(row?.memoryType).toBe('experiences');
    expect(row?.status).toBe('pending');
  });

  it('物化权限：新节点继承根预置的 manage', async () => {
    const file = Uri.parse(`${ROOT}/memories/note.md`);
    await harness.filesystem.write(file, '正文。');

    expect(permissionRowsOf(file.toString())).toEqual([
      { node_uri: file.toString(), principal: SUBJECT, level: 7, effect: 'allow' },
    ]);
  });

  it('自动建出来的祖先目录也有物化权限行，目录树不会断', async () => {
    // `ContentStore.writeText` 会 `mkdir -p` 出 `memories/` 和 `preferences/`，
    // 但观察者只收到文件 URI。不补物化的话这两个目录在 `list` / `tree` 里整个消失
    // ——用户看到「写成功了，但树里什么都没有」。
    const file = Uri.parse(`${ROOT}/memories/preferences/code-style.md`);
    await harness.filesystem.write(file, '正文。');

    const listed = await harness.filesystem.list(Uri.parse(ROOT));
    expect(listed.map((entry) => entry.uri.name)).toContain('memories');

    const nested = await harness.filesystem.list(Uri.parse(`${ROOT}/memories`));
    expect(nested.map((entry) => entry.uri.name)).toContain('preferences');

    for (const directory of [`${ROOT}/memories`, `${ROOT}/memories/preferences`]) {
      expect(permissionRowsOf(directory).map((row) => row.level)).toEqual([7]);
    }
  });

  it('摘要失效投递给父目录，并生成父目录摘要', async () => {
    const directory = Uri.parse(`${ROOT}/memories`);
    const file = directory.child('note.md');
    const stale = vi.spyOn(harness.summary, 'markStale');

    await harness.filesystem.write(file, '正文。');
    await harness.observer.drain();

    expect(stale).toHaveBeenCalledWith(directory);
    const summary = await harness.summary.read(directory);
    expect(summary).not.toBeNull();
    expect(summary?.abstract).toContain('note.md');
    // 摘要生成会写父目录自己的索引行（L0）。
    expect(harness.nodes.get(directory.toString())?.level).toBe('L0');
  });

  it('重写正文后 bodyDigest 跟着变', async () => {
    const file = Uri.parse(`${ROOT}/memories/note.md`);
    await harness.filesystem.write(file, '第一版。');
    const before = harness.nodes.get(file.toString())?.bodyDigest;

    await harness.filesystem.write(file, '第二版。');
    const after = harness.nodes.get(file.toString())?.bodyDigest;

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('建目录写 L0 行，且目录可被 stat', async () => {
    const directory = Uri.parse(`${ROOT}/resources/docs`);
    await harness.filesystem.mkdir(directory);
    await harness.observer.drain();

    const row = harness.nodes.get(directory.toString());
    expect(row?.kind).toBe('directory');
    expect(row?.level).toBe('L0');
    expect(row?.contextType).toBe('resource');
    // 目录的物化行也要有，否则它对自己不可见。
    expect(permissionRowsOf(directory.toString()).length).toBeGreaterThan(0);
  });
});

describe('IndexObserver.onNodeRemoved', () => {
  it('删文件后索引无残留、权限行被清、父目录摘要重算', async () => {
    const directory = Uri.parse(`${ROOT}/memories`);
    const file = directory.child('note.md');
    await harness.filesystem.write(file, '正文。');
    await harness.observer.drain();
    expect(harness.nodes.get(file.toString())).not.toBeNull();
    expect(permissionRowsOf(file.toString()).length).toBeGreaterThan(0);

    const stale = vi.spyOn(harness.summary, 'markStale');
    await harness.filesystem.remove(file);
    await harness.observer.drain();

    expect(harness.nodes.get(file.toString())).toBeNull();
    expect(permissionRowsOf(file.toString())).toEqual([]);
    expect(stale).toHaveBeenCalledWith(directory);

    const hits = await harness.index.search({
      text: '正文',
      scopes: [ROOT],
      principals: PRINCIPALS,
      limit: 10,
    });
    expect(hits.some((hit) => hit.uri === file.toString())).toBe(false);
  });

  it('删目录清掉整棵子树的索引行与权限行', async () => {
    const directory = Uri.parse(`${ROOT}/resources/docs`);
    const nested = directory.child('guides', 'intro.md');
    await harness.filesystem.write(nested, '入门。');
    await harness.observer.drain();
    expect(harness.nodes.get(nested.toString())).not.toBeNull();
    expect(permissionRowsOf(nested.toString()).length).toBeGreaterThan(0);

    await harness.filesystem.remove(directory);
    await harness.observer.drain();

    expect(harness.nodes.get(nested.toString())).toBeNull();
    expect(permissionRowsOf(nested.toString())).toEqual([]);
  });
});

describe('IndexObserver 的错误隔离', () => {
  it('索引写失败只记 error 日志，不让写操作失败', async () => {
    const file = Uri.parse(`${ROOT}/memories/note.md`);
    vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    await expect(harness.filesystem.write(file, '正文。')).resolves.toBeDefined();
    // 文件已经落盘（写操作成功），索引是派生数据。`store.stat` 不求权，
    // 因为这次失败发生在物化之前，`filesystem.stat` 会以 PERMISSION_DENIED 拒绝。
    expect(await harness.store.stat(file)).not.toBeNull();
  });
});
