/**
 * 「节点自身那一行」谓词的一致性（架构文档 §8.1、§8.5）。
 *
 * 这个不变量有两份实现：`adapters/sqlite/node-repository.ts` 的 `nodeSelfRowSql()`
 * 与 `services/observability.ts` 的 `NODE_SELF_ROW`。分开是分层约束的结果
 * （`services/` 只能用 `import type` 引用适配层，§4.2），与 `domain/identity.ts` 与
 * `adapters/fs/path.ts` 各存一份 `RESERVED_NAMES` 同一模式。
 *
 * 两份一旦漂移，`health()` / `/metrics` 的节点数会把目录的 L1 概览行算进去，而按 URI
 * 读节点的路径不会。这里用内存 SQLite 建出覆盖全部 `kind × level` 组合的行，断言两份
 * 谓词筛出的 URI 集合完全相同。**比较行为，不比较字符串**：谓词换个写法（`NOT (A AND
 * B)` → `A IS NOT...`）不该让测试变红，判定结果变了才该红。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider } from '../../../src/adapters/llm/fake-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { nodeSelfRowSql } from '../../../src/adapters/sqlite/node-repository.js';
import { RequestLogRepository } from '../../../src/adapters/sqlite/request-log-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { NodeKind, NodeStatus } from '../../../src/domain/node.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { segmentCjk } from '../../../src/domain/text.js';
import { LlmService } from '../../../src/services/llm.js';
import { NODE_SELF_ROW, ObservabilityService } from '../../../src/services/observability.js';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const ROOT = 'comem://user/alice';
const CASE_DIR = `${ROOT}/case`;

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let service: ObservabilityService;

interface MatrixEntry {
  readonly kind: NodeKind;
  readonly level: Level;
}

/**
 * 全部 `kind × level` 组合，每个组合一条独立 URI，这样「某个组合被多算/少算」在
 * 集合比较里能直接看出来。
 *
 * 前三条是当前会出现的形态（目录 L0、目录 L1、文件 L2）；后三条当前不该出现，
 * 放进矩阵是为了确认将来真出现时两份谓词不会一真一假——附加行的定义是「目录的
 * L1」，不是「任何 L1」，也不是「任何 L0」。
 */
const MATRIX: readonly MatrixEntry[] = [
  { kind: 'directory', level: 'L0' },
  { kind: 'directory', level: 'L1' },
  { kind: 'document', level: 'L2' },
  { kind: 'document', level: 'L0' },
  { kind: 'document', level: 'L1' },
  { kind: 'directory', level: 'L2' },
];

function uriOf(entry: MatrixEntry): string {
  return `${CASE_DIR}/${entry.kind}-${entry.level}`;
}

interface NodeSeed {
  readonly uri: string;
  readonly kind: NodeKind;
  readonly level: Level;
  readonly status?: NodeStatus;
  readonly summaryPending?: number;
  readonly updatedAt?: string;
}

function insertNode(seed: NodeSeed): void {
  const parent = seed.uri.slice(0, seed.uri.lastIndexOf('/'));
  db.prepare(
    `INSERT INTO node
       (uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
        body_digest, size, updated_at, status, summary_pending)
     VALUES (?, ?, 'user', ?, 'memory', NULL, ?, NULL, 'digest', 1, ?, ?, ?)`,
  ).run(
    seed.uri,
    parent,
    seed.kind,
    seed.level,
    seed.updatedAt ?? NOW.toISOString(),
    seed.status ?? 'active',
    seed.summaryPending ?? 0,
  );
}

function seedMatrix(): void {
  for (const entry of MATRIX) {
    insertNode({ uri: uriOf(entry), kind: entry.kind, level: entry.level });
  }
}

/** 用给定谓词筛 `node`，返回按 URI 升序的列表。 */
function urisMatching(predicate: string): string[] {
  return db
    .prepare(`SELECT uri FROM node WHERE ${predicate} ORDER BY uri`)
    .all()
    .map((row) => String(row['uri']));
}

function repositoryUris(): string[] {
  return urisMatching(nodeSelfRowSql());
}

function observabilityUris(): string[] {
  return urisMatching(NODE_SELF_ROW);
}

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-node-self-row-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  service = new ObservabilityService({
    requestLog: new RequestLogRepository({ db, logger }),
    db,
    metadata: new MetadataFileStore({ dataDir, logger }),
    llm: new LlmService({ provider: new FakeLlmProvider([{ text: 'ok' }]), logger }),
    // 画像正文与「节点自身那一行」无关，`health()` 只会在有记忆行时读它。
    profileBodies: { readContent: async () => null },
    logger,
    now: () => NOW,
  });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('两份「节点自身那一行」谓词', () => {
  it('对全部 kind × level 组合筛出的 URI 集合相同', () => {
    seedMatrix();

    expect(observabilityUris()).toEqual(repositoryUris());
  });

  it('只排除目录的 L1 概览行', () => {
    seedMatrix();

    const expected = [
      `${CASE_DIR}/directory-L0`,
      `${CASE_DIR}/directory-L2`,
      `${CASE_DIR}/document-L0`,
      `${CASE_DIR}/document-L1`,
      `${CASE_DIR}/document-L2`,
    ];
    expect(repositoryUris()).toEqual(expected);
    expect(observabilityUris()).toEqual(expected);
  });

  it('带表别名的仓储谓词与不带别名判定相同', () => {
    seedMatrix();

    // `nodeSelfRowSql('n')` 是 embedding / retrieval / bootstrap 里的写法。
    const aliased = db
      .prepare(`SELECT n.uri FROM node n WHERE ${nodeSelfRowSql('n')} ORDER BY n.uri`)
      .all()
      .map((row) => String(row['uri']));

    expect(aliased).toEqual(repositoryUris());
  });
});

describe('ObservabilityService.health() 与仓储谓词', () => {
  it('节点数与仓储筛出的节点数一致（含防御性组合）', async () => {
    seedMatrix();

    const health = await service.health();

    expect(health.indexNodes).toBe(repositoryUris().length);
    expect(health.indexNodes).toBe(5);
  });

  it('目录的 L0 与 L1 两行只算一个节点、一次待复核', async () => {
    const directory = `${ROOT}/memories`;
    const updatedAt = '2026-11-08T00:00:00.000Z';
    // 一个目录的两行：L0 是节点自身，L1 是概览。status / summary_pending 由
    // SummaryService 在同一个事务里写到两行上（§8.1 的「归档、过期是按 URI 的」）。
    insertNode({
      uri: directory,
      kind: 'directory',
      level: 'L0',
      status: 'pending',
      summaryPending: 1,
      updatedAt,
    });
    insertNode({
      uri: directory,
      kind: 'directory',
      level: 'L1',
      status: 'pending',
      summaryPending: 1,
      updatedAt,
    });

    const health = await service.health();

    expect(health.indexNodes).toBe(1);
    expect(health.pendingReview).toBe(1);
    expect(health.oldestPendingAgeSeconds).toBe(86_400);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM node WHERE NOT (kind = 'directory' AND level = 'L1')",
        )
        .get(),
    ).toMatchObject({ total: 1 });
  });
});

/**
 * `node_fts.abstract` 的 blank 规则（`adapters/sqlite/retrieval-index.ts` 的
 * `ftsAbstract`）是「节点自身那一行」的**第三份**实现。
 *
 * 前两份谓词（`nodeSelfRowSql()` 与 `services/observability.ts` 的
 * `NODE_SELF_ROW`）回答「按 URI 读节点 / 计数时哪一行是节点自身」。第三份回答
 * 「哪一行的 `abstract` 不写摘要」：目录的 L1 概览行与 L0 行的摘要重复（L0 是从
 * L1 正文里提取的，`domain/summary.ts` 的 `extractAbstract`），两行都写摘要会让
 * FTS5 把同一处匹配的词频算两遍（`bm25()` 按列累加），概览行仅凭「摘要里出现过」
 * 就能压过真正的原文命中，层级权重（§8.5 的 1.05）也就失去作用对象。
 *
 * 第三份漂移的后果是**静默的**：概览摘要被算两遍词频，排名被概览行压过，而
 * `tests/integration/sqlite/retrieval-index.test.ts` 发现不了——它只断言 L0 / L1
 * 都能命中，`abstract` 被 blank 了也照样命中（`content` 才是概览正文）。
 *
 * 这里按 `kind × level × 有无摘要` 写入 `node_fts`，读回 `node_fts.abstract`，
 * 断言「被 blank 的行」与「被 `nodeSelfRowSql()` 排除的行」是同一批。
 * **比较行为，不比较字符串**：不导出 `ftsAbstract` 的常量，也不断言它的写法；
 * 判定结果变了才该红。
 */
interface FtsMatrixEntry {
  readonly kind: NodeKind;
  readonly level: Level;
  readonly abstract: string | null;
}

const MATRIX_ABSTRACT = '团队约定';
const FTS_DIR = `${CASE_DIR}/fts`;

/**
 * 全部 `kind × level × 有无摘要` 组合。每格一条独立 URI，这样「某一格被 blank 或
 * 被保留」在集合比较里能直接看出来。
 *
 * `document × L1` 当前不该出现（文件只有 L2），放进矩阵是因为它是最容易漂的一格：
 * 把 blank 条件放宽成「所有 L1」会正好落在这里。
 */
const FTS_MATRIX: readonly FtsMatrixEntry[] = (['document', 'directory'] as const).flatMap(
  (kind) =>
    (['L0', 'L1', 'L2'] as const).flatMap((level) =>
      [MATRIX_ABSTRACT, null].map((abstract) => ({ kind, level, abstract })),
    ),
);

function ftsUri(entry: FtsMatrixEntry): string {
  const suffix = entry.abstract === null ? 'no-abstract' : 'abstract';
  return `${FTS_DIR}/${entry.kind}-${entry.level}-${suffix}`;
}

function ftsRecord(uri: string, entry: FtsMatrixEntry): IndexRecord {
  return {
    uri,
    parentUri: FTS_DIR,
    scope: 'user',
    kind: entry.kind,
    contextType: entry.kind === 'directory' ? 'resource' : 'memory',
    memoryType: entry.kind === 'document' ? 'preferences' : null,
    level: entry.level,
    abstract: entry.abstract,
    content: '正文内容',
    bodyDigest: 'digest',
    size: 4,
    updatedAt: NOW.toISOString(),
    status: 'active',
  };
}

interface FtsRow {
  readonly uri: string;
  readonly level: string;
  readonly abstract: string;
}

function ftsRows(): FtsRow[] {
  return db
    .prepare('SELECT uri, level, abstract FROM node_fts ORDER BY uri, level')
    .all()
    .map((row) => ({
      uri: String(row['uri']),
      level: String(row['level']),
      abstract: row['abstract'] === null ? '' : String(row['abstract']),
    }));
}

describe('node_fts 的 blank 规则与「节点自身那一行」谓词', () => {
  it('矩阵下被 blank 的摘要行集合与被 nodeSelfRowSql() 排除的行集合相同', async () => {
    const index = new SqliteFtsIndex({ db, logger });
    await index.upsert(FTS_MATRIX.map((entry) => ftsRecord(ftsUri(entry), entry)));

    const rows = ftsRows();
    expect(rows).toHaveLength(FTS_MATRIX.length);

    const entryByUri = new Map(FTS_MATRIX.map((entry) => [ftsUri(entry), entry]));
    const withAbstract = new Set(
      FTS_MATRIX.filter((entry) => entry.abstract !== null).map((entry) => ftsUri(entry)),
    );
    const excluded = db
      .prepare(`SELECT uri FROM node WHERE NOT (${nodeSelfRowSql()}) ORDER BY uri`)
      .all()
      .map((row) => String(row['uri']));

    // 「被谓词排除」= 目录的 L1 概览行：矩阵里两条（有摘要 / 无摘要）都在里面。
    expect(excluded).toEqual([
      ftsUri({ kind: 'directory', level: 'L1', abstract: MATRIX_ABSTRACT }),
      ftsUri({ kind: 'directory', level: 'L1', abstract: null }),
    ]);

    // 没有摘要的行输出本来就是空串，判定不了 blank 规则（它证明不了什么，也不能
    // 当成「被 blank」）。集合比较只看输入带摘要的那一半。
    const excludedWithAbstract = excluded.filter((uri) => withAbstract.has(uri));
    const blankedWithAbstract = rows
      .filter((row) => withAbstract.has(row.uri) && row.abstract === '')
      .map((row) => row.uri)
      .sort();
    expect(excludedWithAbstract).toEqual([
      ftsUri({ kind: 'directory', level: 'L1', abstract: MATRIX_ABSTRACT }),
    ]);
    expect(blankedWithAbstract).toEqual(excludedWithAbstract);

    // 完整口径：一行是空串，要么输入本来就没有摘要，要么它被谓词排除了。这条把
    // 「哪些行被 blank」说全，也挡住「额外的行被 blank」（比如文件行的 L1）。
    const noAbstractUris = FTS_MATRIX.filter((entry) => entry.abstract === null).map(ftsUri);
    const blanked = rows.filter((row) => row.abstract === '').map((row) => row.uri);
    expect(blanked.sort()).toEqual([...new Set([...excluded, ...noAbstractUris])].sort());

    // 保留摘要的行写的是切分后的摘要本身，不是空串，也不是别的列。
    for (const row of rows) {
      const entry = entryByUri.get(row.uri);
      if (entry === undefined || entry.abstract === null || row.abstract === '') {
        continue;
      }
      expect(row.abstract, `${entry.kind}-${entry.level}`).toBe(segmentCjk(entry.abstract));
    }

    // 最容易漂的一格：文件行的 L1 摘要必须保留。现有用例矩阵里没有这一行，
    // 而「blank 所有 L1」这种放宽会正好在这里变红。
    const documentL1 = ftsUri({ kind: 'document', level: 'L1', abstract: MATRIX_ABSTRACT });
    expect(rows.find((row) => row.uri === documentL1)?.abstract).toBe(
      segmentCjk(MATRIX_ABSTRACT),
    );
  });

  it('同一目录的 L0 / L1 两行：只 blank 概览行', async () => {
    const directory = `${CASE_DIR}/memories`;
    const overview = '团队约定的详细说明：提交前跑完整测试';
    const index = new SqliteFtsIndex({ db, logger });
    await index.upsert([
      ftsRecord(directory, { kind: 'directory', level: 'L0', abstract: MATRIX_ABSTRACT }),
      {
        ...ftsRecord(directory, { kind: 'directory', level: 'L1', abstract: MATRIX_ABSTRACT }),
        content: overview,
      },
    ]);

    const rows = ftsRows();
    expect(rows.map((row) => row.level)).toEqual(['L0', 'L1']);
    // L0 摘要留着（它是这一层的检索文本），概览行的摘要清空（正文已经包含它）。
    expect(rows[0]?.abstract).toBe(segmentCjk(MATRIX_ABSTRACT));
    expect(rows[1]?.abstract).toBe('');

    const blankedLevels = rows.filter((row) => row.abstract === '').map((row) => row.level);
    const excludedLevels = db
      .prepare(`SELECT level FROM node WHERE uri = ? AND NOT (${nodeSelfRowSql()}) ORDER BY level`)
      .all(directory)
      .map((row) => String(row['level']));
    expect(blankedLevels).toEqual(excludedLevels);
    expect(excludedLevels).toEqual(['L1']);
  });
});
