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
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { NodeKind, NodeStatus } from '../../../src/domain/node.js';
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
