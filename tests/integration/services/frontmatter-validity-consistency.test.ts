/**
 * 记忆有效期的三处 frontmatter 解析对拍（W98 数据基座）。
 *
 * 记忆文件的 frontmatter 有三个解析点，各自服务一条链路：
 *
 * | 解析点 | 链路 | 消费方 |
 * |---|---|---|
 * | `services/memory.ts` 的 `parseMemoryDocument` | 读写记忆 | `MemoryService.read` / 抽取预取 |
 * | `services/index-observer.ts` 的 `parseFrontmatterFields` | 写路径的索引 | `node.valid_from` / `valid_until` |
 * | `commands/reindex.ts` 的 `readFrontmatterFields` | 从磁盘重建索引 | 同样两列 |
 *
 * 三处必须对同一份文件给出同样两个值，有两个理由：
 *
 * 1. **索引与磁盘要一致。** 同一份文件在写路径与 `read` 之间给出两个有效期，用户
 *    从 `read` 看到「已失效」、从 `search` 却能命中；反过来更糟：`read` 说仍然有效，
 *    检索却把它藏起来，看起来像“记忆丢了”。
 * 2. **`reindex` 会覆盖整列。** 重建从磁盘重新解析，第二条与第三条链路结果不同时，
 *    漂移要等到有人跑重建才暴露——而那时整库的有效期已经按重建的口径重写了一遍。
 *
 * 还有一条现在**不在这里**、下一步必须补的读点：`services/reconcile.ts` 的
 * `#reindex` 重放。它从磁盘重建文件的索引行，但只复用索引里的旧
 * `context_type` / `memory_type` / `status`，不解析 frontmatter 的任何字段——三处
 * 解析器一个都不经过。这一阶段它无害（写入侧还没有任何 `valid_*` 可选），但写入
 * 语义落地后，一次重放会把已失效版本的 `valid_*` 写成 NULL，**历史版本会在重放后
 * 重新变成「有效」**。补法只能是让重放也读同一份解析结果，不是在这里再抄一份。
 *
 * 所以这里**比较行为，不比较实现**：同一棵磁盘树上跑三条链路，逐文件比对两列，
 * 并且要求三条都等于期望表——否则「三处一致但一起错」也能通过。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { ReconcileLog } from '../../../src/adapters/fs/reconcile-log.js';
import { NullLogger } from '../../helpers/null-logger.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { MemoryService, type MemoryServicePorts } from '../../../src/services/memory.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

import { runReindex } from '../../../src/commands/reindex.js';

const ROOT = 'comem://user/alice';
const DIRECTORY = `${ROOT}/memories/preferences`;

/** 一份文件的两列期望值；三处解析器都必须落到这里。 */
interface ValidityCase {
  /** 文件名，也是用例标识 */
  readonly name: string;
  /** 追加在公共 frontmatter 之后的 `valid_*` 行（可以一行都没有） */
  readonly lines: readonly string[];
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

/**
 * 五种输入形态。`null` 表示「读作无界」——缺键、值不是字符串、值不是时间串都归这里，
 * 区别只在于为什么读不出来。
 */
const CASES: readonly ValidityCase[] = [
  {
    name: 'both',
    lines: ['valid_from: 2026-11-01T00:00:00.000Z', 'valid_until: 2026-11-05T12:00:00.000Z'],
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: '2026-11-05T12:00:00.000Z',
  },
  {
    // 缺键：旧文件与「一直有效」是同一个状态。
    name: 'neither',
    lines: [],
    validFrom: null,
    validUntil: null,
  },
  {
    // 只有终点：起点无界。
    name: 'until-only',
    lines: ['valid_until: 2026-12-01T00:00:00.000Z'],
    validFrom: null,
    validUntil: '2026-12-01T00:00:00.000Z',
  },
  {
    // 值写成数字（手改的）。YAML 把它读成 number，三个解析器都必须读作无界：
    // `2026` 在 V8 里能 `Date.parse` 成 2026-01-01，不显式拒绝就会变成「从 2026 年
    // 开始有效」，而另外两处是数字类型、读作无界。
    name: 'numbers',
    lines: ['valid_from: 2026', 'valid_until: 123'],
    validFrom: null,
    validUntil: null,
  },
  {
    // 带时区偏移：归一化成 UTC。索引列与过滤边界按 TEXT 比较，不归一化会把
    // 「09:00+08:00」当成比「02:00Z」更晚的时刻。
    name: 'offset',
    lines: ['valid_from: 2026-11-10T09:00:00+08:00'],
    validFrom: '2026-11-10T01:00:00.000Z',
    validUntil: null,
  },
];

function uriOf(entry: ValidityCase): string {
  return `${DIRECTORY}/${entry.name}.md`;
}

/** 记忆文件的原始字节：`memory.ts` 的 `serializeMemoryDocument` 写出来的形态。 */
function documentOf(entry: ValidityCase): string {
  return [
    '---',
    'memory_type: preferences',
    'status: active',
    'created_at: 2026-11-01T00:00:00.000Z',
    'updated_at: 2026-11-01T00:00:00.000Z',
    ...entry.lines,
    '---',
    '',
    '## content',
    '',
    `正文：${entry.name}`,
  ].join('\n');
}

/** 两列的观测结果（`null` = 无界）。 */
interface Validity {
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

let dataDir: string;
let configPath: string;
let logger: NullLogger;

beforeEach(async () => {
  logger = new NullLogger();
  dataDir = await mkdtemp(join(tmpdir(), 'comem-validity-consistency-'));
  configPath = join(dataDir, 'config.yaml');
  await writeFile(
    configPath,
    [
      'dataDir: ""',
      'logging:',
      '  level: error',
      'retrieval:',
      '  engine: fts5',
      'providers:',
      '  embedding:',
      '    type: disabled',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** 把同一份字节写到磁盘，三条链路都从这份字节读。 */
async function writeDocuments(store: ContentStore): Promise<void> {
  await store.mkdir(Uri.parse(DIRECTORY), { recursive: true });
  for (const entry of CASES) {
    await store.writeBytes(Uri.parse(uriOf(entry)), Uint8Array.from(Buffer.from(documentOf(entry), 'utf8')));
  }
}

/**
 * 链路一：`services/memory.ts` 的 `parseMemoryDocument`（经 `MemoryService.read`）。
 *
 * 端口语义是「原样文档」（含 frontmatter），所以用 `readBytes` / `writeBytes` 包一层，
 * 与 `tests/integration/services/memory.test.ts` 的 `createRawFilesystem` 同一个理由。
 */
function rawFilesystem(store: ContentStore): MemoryServicePorts['filesystem'] {
  return {
    read: async (uri) => ({ text: Buffer.from(await store.readBytes(uri)).toString('utf8') }),
    write: (uri, text) => store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8'))),
    stat: (uri) => store.stat(uri),
    remove: (uri) => store.remove(uri),
    list: (uri) => store.list(uri),
  };
}

async function readByMemoryService(store: ContentStore): Promise<Map<string, Validity>> {
  const memory = new MemoryService({
    filesystem: rawFilesystem(store),
    locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
    search: {
      find: async () => [],
    },
    logger,
  });
  const result = new Map<string, Validity>();
  for (const entry of CASES) {
    const record = await memory.read(Uri.parse(uriOf(entry)));
    expect(record, `memory.read 读不出 ${entry.name}`).not.toBeNull();
    result.set(uriOf(entry), {
      validFrom: record?.validFrom ?? null,
      validUntil: record?.validUntil ?? null,
    });
  }
  return result;
}

/** 链路二：`services/index-observer.ts` 的 `parseFrontmatterFields`（经真实写路径的索引行）。 */
async function readByObserver(store: ContentStore): Promise<{
  readonly observed: Map<string, Validity>;
  readonly db: DatabaseSync;
}> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const metadata = new MetadataFileStore({ dataDir, logger });
  const permissions = new PermissionRepository({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  const index = new SqliteFtsIndex({ db, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
  const acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
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
    reconcile: new ReconcileLog({ dataDir, logger }),
  });

  for (const entry of CASES) {
    await observer.onNodeWritten(Uri.parse(uriOf(entry)), 'file');
  }
  await observer.drain();

  return { observed: snapshot(db), db };
}

/** 链路三：`commands/reindex.ts` 的 `readFrontmatterFields`（经完整重建）。 */
async function readByReindex(): Promise<Map<string, Validity>> {
  const result = await runReindex({ dataDir, configPath, only: 'index' });
  expect(result.failed).toBe(0);
  const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
  try {
    return snapshot(db);
  } finally {
    db.close();
  }
}

/** 逐文件的文档行两列。目录行不参与：它们没有有效期。 */
function snapshot(db: DatabaseSync): Map<string, Validity> {
  const rows = db
    .prepare("SELECT uri, valid_from, valid_until FROM node WHERE kind = 'document' ORDER BY uri")
    .all();
  const result = new Map<string, Validity>();
  for (const row of rows) {
    const from = row['valid_from'];
    const until = row['valid_until'];
    result.set(String(row['uri']), {
      validFrom: from === null || from === undefined ? null : String(from),
      validUntil: until === null || until === undefined ? null : String(until),
    });
  }
  return result;
}

describe('记忆有效期的三处 frontmatter 解析一致', () => {
  it('同一份文件在 memory / index-observer / reindex 三条链路上给出同样的两列', async () => {
    const store = new ContentStore({ dataDir, logger });
    await writeDocuments(store);

    const byMemory = await readByMemoryService(store);
    const { observed, db } = await readByObserver(store);
    db.close();
    const byReindex = await readByReindex();

    for (const entry of CASES) {
      const uri = uriOf(entry);
      const expected: Validity = { validFrom: entry.validFrom, validUntil: entry.validUntil };

      // 1) 三条链路各自都要符合期望表——不是「一致但一起错」。
      expect(byMemory.get(uri), `memory：${entry.name}`).toEqual(expected);
      expect(observed.get(uri), `index-observer：${entry.name}`).toEqual(expected);
      expect(byReindex.get(uri), `reindex：${entry.name}`).toEqual(expected);

      // 2) 对拍：三条链路两两相同。
      expect(observed.get(uri), `observer 与 memory 漂移：${entry.name}`).toEqual(byMemory.get(uri));
      expect(byReindex.get(uri), `reindex 与 observer 漂移：${entry.name}`).toEqual(
        observed.get(uri),
      );
    }
  });
});
