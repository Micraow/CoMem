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
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { EmbeddingProvider, EmbeddingResult } from '../../../src/domain/embedding.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import { AclService } from '../../../src/services/acl.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { EmbeddingService } from '../../../src/services/embedding.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const ROOT = 'comem://user/alice';
const SUBJECT = 'user:alice';
const PRINCIPALS = [SUBJECT, 'user:*'];

interface Harness {
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly acl: AclService;
  readonly filesystem: FileSystemService;
  readonly index: SqliteFtsIndex;
  readonly observer: IndexObserver;
  readonly summary: SummaryService;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  close(): Promise<void>;
}

interface HarnessOptions {
  /**
   * 注入一个**没有建表**的向量仓储，复现默认配置
   * （`providers.embedding.type === 'disabled'`，`ensureSchema` 不跑）。
   */
  readonly embeddings?: boolean;
  /**
   * 注入一个真实的 `EmbeddingService`，外面套一个记录调用的假 provider。
   *
   * 用真服务而不是假服务：`embed()` 内部还按 `maxBatchSize` 切一次，只有让
   * provider 的调用次数直接等于 HTTP 请求次数，「N 条记录 → ceil(N/maxBatchSize)
   * 次请求」才是被测的契约本身。
   */
  readonly embedding?: {
    readonly provider: EmbeddingProvider;
    readonly maxBatchSize: number;
  };
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

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
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
    locks,
  });
  await acl.ensureRootPreset(Uri.parse(ROOT));

  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
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
    ...(options.embeddings === true ? { embeddings: new EmbeddingRepository({ db, logger }) } : {}),
    ...(options.embedding === undefined
      ? {}
      : {
          embedding: new EmbeddingService({
            provider: options.embedding.provider,
            logger,
            cache: null,
            config: {
              dimension: options.embedding.provider.dimension,
              maxBatchSize: options.embedding.maxBatchSize,
              timeoutMs: 30_000,
            },
          }),
        }),
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
    acl,
    filesystem,
    index,
    observer,
    summary,
    permissions,
    nodes,
    logger,
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
    await harness.filesystem.write(file, '用户偏好 TypeScript 严格模式。', PRINCIPALS, {
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
      ['---', 'memory_type: experiences', 'status: pending', '---', '', '迁移到 monorepo。'].join('\n'), PRINCIPALS,
    );
    await harness.observer.drain();

    const row = harness.nodes.get(file.toString());
    expect(row?.memoryType).toBe('experiences');
    expect(row?.status).toBe('pending');
  });

  it('物化权限：新节点继承根预置的 manage', async () => {
    const file = Uri.parse(`${ROOT}/memories/note.md`);
    await harness.filesystem.write(file, '正文。', PRINCIPALS);

    expect(permissionRowsOf(file.toString())).toEqual([
      { node_uri: file.toString(), principal: SUBJECT, level: 7, effect: 'allow' },
    ]);
  });

  it('自动建出来的祖先目录也有物化权限行，目录树不会断', async () => {
    // `ContentStore.writeText` 会 `mkdir -p` 出 `memories/` 和 `preferences/`，
    // 但观察者只收到文件 URI。不补物化的话这两个目录在 `list` / `tree` 里整个消失
    // ——用户看到「写成功了，但树里什么都没有」。
    const file = Uri.parse(`${ROOT}/memories/preferences/code-style.md`);
    await harness.filesystem.write(file, '正文。', PRINCIPALS);

    const listed = await harness.filesystem.list(Uri.parse(ROOT), PRINCIPALS);
    expect(listed.map((entry) => entry.uri.name)).toContain('memories');

    const nested = await harness.filesystem.list(Uri.parse(`${ROOT}/memories`), PRINCIPALS);
    expect(nested.map((entry) => entry.uri.name)).toContain('preferences');

    for (const directory of [`${ROOT}/memories`, `${ROOT}/memories/preferences`]) {
      expect(permissionRowsOf(directory).map((row) => row.level)).toEqual([7]);
    }
  });

  it('摘要失效投递给父目录，并生成父目录摘要', async () => {
    const directory = Uri.parse(`${ROOT}/memories`);
    const file = directory.child('note.md');
    const stale = vi.spyOn(harness.summary, 'markStale');

    await harness.filesystem.write(file, '正文。', PRINCIPALS);
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
    await harness.filesystem.write(file, '第一版。', PRINCIPALS);
    const before = harness.nodes.get(file.toString())?.bodyDigest;

    await harness.filesystem.write(file, '第二版。', PRINCIPALS);
    const after = harness.nodes.get(file.toString())?.bodyDigest;

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('建目录写 L0 行，且目录可被 stat', async () => {
    const directory = Uri.parse(`${ROOT}/resources/docs`);
    await harness.filesystem.mkdir(directory, PRINCIPALS);
    await harness.observer.drain();

    const row = harness.nodes.get(directory.toString());
    expect(row?.kind).toBe('directory');
    expect(row?.level).toBe('L0');
    expect(row?.contextType).toBe('resource');
    // 目录的物化行也要有，否则它对自己不可见。
    expect(permissionRowsOf(directory.toString()).length).toBeGreaterThan(0);
  });
});

describe('IndexObserver.onNodeMoved', () => {
  const RESOURCES = `${ROOT}/resources`;

  it('移动目录后整棵子树的索引与物化权限都跟着搬过去', async () => {
    const from = Uri.parse(`${RESOURCES}/spec`);
    const to = Uri.parse(`${RESOURCES}/spec-v2`);
    await harness.filesystem.mkdir(from, PRINCIPALS);
    for (const name of ['one.md', 'two.md', 'three.md']) {
      await harness.filesystem.write(from.child(name), `${name} 的正文。`, PRINCIPALS);
    }
    await harness.observer.drain();

    await harness.filesystem.move(from, to, PRINCIPALS);
    await harness.observer.drain();

    // 源路径一条不剩。
    expect(harness.nodes.get(from.toString())).toBeNull();
    expect(permissionRowsOf(from.toString())).toEqual([]);

    // 目标路径每一层都有索引行与物化权限行。
    expect(harness.nodes.get(to.toString())?.kind).toBe('directory');
    for (const name of ['one.md', 'two.md', 'three.md']) {
      const child = to.child(name).toString();
      expect(harness.nodes.get(child)?.kind).toBe('document');
      expect(permissionRowsOf(child).length).toBeGreaterThan(0);
    }

    // `list` / `tree` / `find` 都能看到子项。
    const listed = await harness.filesystem.list(to, PRINCIPALS);
    expect(listed.map((entry) => entry.uri.name)).toEqual(['one.md', 'three.md', 'two.md']);

    const tree = await harness.filesystem.tree(Uri.parse(RESOURCES), PRINCIPALS);
    expect(tree.entries.map((entry) => entry.uri.toString())).toEqual(
      expect.arrayContaining(['one.md', 'two.md', 'three.md'].map((name) => to.child(name).toString())),
    );

    const hits = await harness.index.search({
      text: '正文',
      scopes: [ROOT],
      principals: PRINCIPALS,
      limit: 10,
    });
    expect(hits.filter((hit) => hit.uri.startsWith(`${to.toString()}/`))).toHaveLength(3);
  });

  it('摘要失效只投给源与目标的父目录各一次，不给每个子项失效', async () => {
    const from = Uri.parse(`${RESOURCES}/spec`);
    const to = Uri.parse(`${ROOT}/memories/spec`);
    await harness.filesystem.mkdir(from, PRINCIPALS);
    for (const name of ['one.md', 'two.md', 'three.md']) {
      await harness.filesystem.write(from.child(name), `${name} 的正文。`, PRINCIPALS);
    }
    await harness.observer.drain();

    const stale = vi.spyOn(harness.summary, 'markStale');
    await harness.filesystem.move(from, to, PRINCIPALS);
    await harness.observer.drain();

    // 源与目标各一个父目录；三个子项不再各投一次（那会把整条祖先链打穿）。
    expect(stale).toHaveBeenCalledTimes(2);
    expect(
      stale.mock.calls.map(([directory]) => directory.toString()).sort(),
    ).toEqual(
      [Uri.parse(RESOURCES).toString(), Uri.parse(`${ROOT}/memories`).toString()].sort(),
    );
  });

  it('同一个父目录内改名只投递一次摘要失效', async () => {
    const from = Uri.parse(`${RESOURCES}/spec`);
    await harness.filesystem.mkdir(from, PRINCIPALS);
    await harness.filesystem.write(from.child('one.md'), '正文。', PRINCIPALS);
    await harness.observer.drain();

    const stale = vi.spyOn(harness.summary, 'markStale');
    await harness.filesystem.move(from, Uri.parse(`${RESOURCES}/spec-v2`), PRINCIPALS);
    await harness.observer.drain();

    expect(stale).toHaveBeenCalledTimes(1);
    expect(stale).toHaveBeenCalledWith(Uri.parse(RESOURCES));
  });

  it('移动目录后 acl_entry 按新 URI 重建（删账号能撤掉文件里的授权）', async () => {
    const from = Uri.parse(`${RESOURCES}/spec`);
    const to = Uri.parse(`${RESOURCES}/spec-v2`);
    await harness.filesystem.mkdir(from, PRINCIPALS);
    await harness.acl.setAcl(
      from,
      {
        mode: 'inherit',
        entries: [{ principal: 'user:bob', level: 3, effect: 'allow' }],
      },
      SUBJECT,
      PRINCIPALS,
    );

    await harness.filesystem.move(from, to, PRINCIPALS);
    await harness.observer.drain();

    // 源前缀的反查行被删掉，目标前缀按 `.acl.json` 写回。
    expect(
      harness.permissions.entriesByPrincipal('user:bob').map((row) => row.uri),
    ).not.toContain(from.toString());
    expect(
      harness.permissions.entriesByPrincipal('user:bob').map((row) => row.uri),
    ).toContain(to.toString());
  });

  it('移动单个文件：源行清掉、目标行建出来', async () => {
    const from = Uri.parse(`${RESOURCES}/one.md`);
    const to = Uri.parse(`${RESOURCES}/renamed.md`);
    await harness.filesystem.write(from, '正文。', PRINCIPALS);
    await harness.observer.drain();

    await harness.filesystem.move(from, to, PRINCIPALS);
    await harness.observer.drain();

    expect(harness.nodes.get(from.toString())).toBeNull();
    expect(permissionRowsOf(from.toString())).toEqual([]);
    expect(harness.nodes.get(to.toString())?.kind).toBe('document');
    expect(permissionRowsOf(to.toString()).length).toBeGreaterThan(0);
  });

  it('向量按新 URI 重新挂上，不重新调模型', async () => {
    const local = await createHarness({ embeddings: true });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, 'test-model');

      const from = Uri.parse(`${RESOURCES}/one.md`);
      const to = Uri.parse(`${RESOURCES}/renamed.md`);
      await local.filesystem.write(from, '正文。', PRINCIPALS);
      await local.observer.drain();
      embeddings.upsert([
        { uri: from.toString(), model: 'test-model', contentDigest: 'digest', vector: [0.1, 0.2, 0.3] },
      ]);

      await local.filesystem.move(from, to, PRINCIPALS);
      await local.observer.drain();

      expect(embeddings.get(from.toString())).toBeNull();
      const moved = embeddings.get(to.toString());
      expect(moved?.model).toBe('test-model');
      expect(moved?.contentDigest).toBe('digest');
      expect(moved?.vector).toHaveLength(3);
    } finally {
      await local.close();
    }
  });
});

describe('IndexObserver.onNodeRemoved', () => {
  it('向量清理失败不跳过物化权限与父目录摘要（默认配置下表不存在）', async () => {
    // 默认 `providers.embedding.type === 'disabled'`：`ensureSchema` 不跑，
    // `node_embedding` 表不存在。删除时的向量清理必然抛 `no such table`。
    const local = await createHarness({ embeddings: true });
    try {
      const directory = Uri.parse(`${ROOT}/memories`);
      const file = directory.child('note.md');
      await local.filesystem.write(file, '正文。', PRINCIPALS);
      await local.observer.drain();
      expect(local.db.prepare('SELECT 1 FROM node_permission WHERE node_uri = ?').all(file.toString())).toHaveLength(1);

      const stale = vi.spyOn(local.summary, 'markStale');
      await local.filesystem.remove(file, PRINCIPALS);
      await local.observer.drain();

      // 向量那一步确实失败了（日志里有一条），但权限与摘要照常完成。
      expect(local.logger.error).toHaveBeenCalledWith(
        '节点删除后清理向量失败，已忽略。',
        expect.objectContaining({ uri: file.toString() }),
      );
      expect(
        local.db.prepare('SELECT 1 FROM node_permission WHERE node_uri = ?').all(file.toString()),
      ).toEqual([]);
      expect(stale).toHaveBeenCalledWith(directory);
    } finally {
      await local.close();
    }
  });

  it('删文件后索引无残留、权限行被清、父目录摘要重算', async () => {
    const directory = Uri.parse(`${ROOT}/memories`);
    const file = directory.child('note.md');
    await harness.filesystem.write(file, '正文。', PRINCIPALS);
    await harness.observer.drain();
    expect(harness.nodes.get(file.toString())).not.toBeNull();
    expect(permissionRowsOf(file.toString()).length).toBeGreaterThan(0);

    const stale = vi.spyOn(harness.summary, 'markStale');
    await harness.filesystem.remove(file, PRINCIPALS);
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
    await harness.filesystem.write(nested, '入门。', PRINCIPALS);
    await harness.observer.drain();
    expect(harness.nodes.get(nested.toString())).not.toBeNull();
    expect(permissionRowsOf(nested.toString()).length).toBeGreaterThan(0);

    await harness.filesystem.remove(directory, PRINCIPALS);
    await harness.observer.drain();

    expect(harness.nodes.get(nested.toString())).toBeNull();
    expect(permissionRowsOf(nested.toString())).toEqual([]);
  });
});

describe('IndexObserver 的错误隔离', () => {
  it('索引写失败只记 error 日志，不让写操作失败', async () => {
    const file = Uri.parse(`${ROOT}/memories/note.md`);
    vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    await expect(harness.filesystem.write(file, '正文。', PRINCIPALS)).resolves.toBeDefined();
    // 文件已经落盘（写操作成功），索引是派生数据。`store.stat` 不求权，
    // 因为这次失败发生在物化之前，`filesystem.stat` 会以 PERMISSION_DENIED 拒绝。
    expect(await harness.store.stat(file)).not.toBeNull();
  });
});

/**
 * 批量嵌入（架构文档 §8.1 的 `node_embedding`、§17.2 的异步阶段）。
 *
 * 这一组钉住的是「写路径真的用了批量」：`embedding.maxBatchSize` 从「没人读的
 * 配置项」变成「一次 `drain()` 里 N 条记录 → `ceil(N / maxBatchSize)` 次请求」。
 * 用真实的 `EmbeddingService` 套一个记录调用的假 provider，provider 的调用次数
 * 就是 HTTP 请求次数，中间没有第二层切分可以虚增或虚减这个数。
 */
describe('IndexObserver 批量嵌入', () => {
  const MODEL = 'test-embedding';
  const RESOURCES = `${ROOT}/resources`;

  /** 每条输入返回同一个单位向量；记录每次调用的条数。 */
  function createProvider(
    implementation?: (texts: readonly string[]) => Promise<EmbeddingResult>,
  ): EmbeddingProvider & { readonly embed: ReturnType<typeof vi.fn> } {
    return {
      model: MODEL,
      dimension: 3,
      embed: vi.fn(
        implementation ??
          ((texts: readonly string[]) =>
            Promise.resolve({
              vectors: texts.map(() => [1, 0, 0]),
              usage: { promptTokens: texts.length, totalTokens: texts.length },
            })),
      ),
    };
  }

  /** 建 N 个文件（不经过观察者），再让观察者逐个通知——这样 N 条都在同一个窗口里。 */
  async function writeFiles(local: Harness, count: number): Promise<readonly Uri[]> {
    const uris: Uri[] = [];
    for (let index = 0; index < count; index += 1) {
      const uri = Uri.parse(`${RESOURCES}/note-${String(index)}.md`);
      await local.store.writeText(uri, `正文 ${String(index)}`);
      uris.push(uri);
    }
    return uris;
  }

  it('N 条记录 → ceil(N / maxBatchSize) 次请求，不是 N 次', async () => {
    const provider = createProvider();
    const local = await createHarness({ embeddings: true, embedding: { provider, maxBatchSize: 4 } });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, MODEL);
      const uris = await writeFiles(local, 10);

      await Promise.all(uris.map((uri) => local.observer.onNodeWritten(uri, 'file')));
      await local.observer.drain();

      // 10 条 / 每批 4 条 = 3 次请求（4 + 4 + 2）。
      expect(provider.embed).toHaveBeenCalledTimes(3);
      expect(provider.embed.mock.calls.map(([texts]) => (texts as string[]).length)).toEqual([
        4, 4, 2,
      ]);
      // 每条记录都写回了向量，一条不少。
      expect(embeddings.count()).toBe(10);
    } finally {
      await local.close();
    }
  });

  it('顺序对回：供应商返回的向量按下标写回各自的 URI', async () => {
    // 每条输入返回 `[序号 + 1, 1, 0]`。归一化会统一缩放两个分量，但比值
    // `x / y = 序号 + 1` 不变——顺序错位时这个比值就对不上。
    const provider = createProvider(async (texts) => ({
      vectors: texts.map((text) => [Number(text.replace('正文 ', '')) + 1, 1, 0]),
      usage: { promptTokens: texts.length, totalTokens: texts.length },
    }));
    const local = await createHarness({ embeddings: true, embedding: { provider, maxBatchSize: 8 } });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, MODEL);
      const uris = await writeFiles(local, 5);

      await Promise.all(uris.map((uri) => local.observer.onNodeWritten(uri, 'file')));
      await local.observer.drain();

      // 一次请求拿回 5 条，按输入下标拆开写回。
      expect(provider.embed).toHaveBeenCalledTimes(1);
      for (const [index, uri] of uris.entries()) {
        const vector = embeddings.get(uri.toString())?.vector;
        expect(vector).toBeDefined();
        const x = vector?.[0] ?? 0;
        const y = vector?.[1] ?? 1;
        expect(x / y).toBeCloseTo(index + 1, 5);
      }
      expect(new Set(uris.map((uri) => embeddings.get(uri.toString())?.contentDigest)).size).toBe(5);
    } finally {
      await local.close();
    }
  });

  it('一条坏输入不让整批丢：二分重试把失败收敛到它自己', async () => {
    const provider = createProvider(async (texts) => {
      if (texts.includes('正文 1')) {
        throw new ComemError('INVALID_ARGUMENT', '输入过长。', {});
      }
      return {
        vectors: texts.map(() => [1, 0, 0]),
        usage: { promptTokens: texts.length, totalTokens: texts.length },
      };
    });
    const local = await createHarness({ embeddings: true, embedding: { provider, maxBatchSize: 4 } });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, MODEL);
      const uris = await writeFiles(local, 6);

      await Promise.all(uris.map((uri) => local.observer.onNodeWritten(uri, 'file')));
      await local.observer.drain();

      // 只有坏记录没写进去，其余 5 条都在。
      expect(embeddings.count()).toBe(5);
      expect(embeddings.get(uris[1]?.toString() ?? '')).toBeNull();
      expect(local.logger.warn).toHaveBeenCalledWith(
        '嵌入降级，跳过写入',
        expect.objectContaining({ uris: [uris[1]?.toString()] }),
      );
    } finally {
      await local.close();
    }
  });

  it('同一段正文挂在两个 URI 下只占一个输入位', async () => {
    const provider = createProvider();
    const local = await createHarness({ embeddings: true, embedding: { provider, maxBatchSize: 8 } });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, MODEL);
      const first = Uri.parse(`${RESOURCES}/copy-a.md`);
      const second = Uri.parse(`${RESOURCES}/copy-b.md`);
      await local.store.writeText(first, '同一段正文。');
      await local.store.writeText(second, '同一段正文。');

      await Promise.all([
        local.observer.onNodeWritten(first, 'file'),
        local.observer.onNodeWritten(second, 'file'),
      ]);
      await local.observer.drain();

      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(provider.embed.mock.calls[0]?.[0]).toEqual(['同一段正文。']);
      // 两个 URI 各写一行，向量相同。
      expect(embeddings.count()).toBe(2);
      expect(embeddings.get(first.toString())?.contentDigest).toBe(
        embeddings.get(second.toString())?.contentDigest,
      );
    } finally {
      await local.close();
    }
  });

  it('正文没变不重新嵌入', async () => {
    const provider = createProvider();
    const local = await createHarness({ embeddings: true, embedding: { provider, maxBatchSize: 8 } });
    try {
      const embeddings = new EmbeddingRepository({ db: local.db, logger: local.logger });
      embeddings.ensureSchema(3, MODEL);
      const [uri] = await writeFiles(local, 1);
      if (uri === undefined) {
        throw new Error('没有建出文件。');
      }

      await local.observer.onNodeWritten(uri, 'file');
      await local.observer.drain();
      expect(provider.embed).toHaveBeenCalledTimes(1);

      // 同一份正文再通知一次：`content_digest` 相同，不需要重嵌。
      await local.observer.onNodeWritten(uri, 'file');
      await local.observer.drain();
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(embeddings.count()).toBe(1);
    } finally {
      await local.close();
    }
  });
});
