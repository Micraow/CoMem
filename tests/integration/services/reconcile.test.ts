/**
 * 对账重放（架构文档 §10.6「索引双写补偿」）。
 *
 * 这里测的是**恢复结果**，不是「函数被调用了」：真实 `ResourceService` 在索引写失败
 * 之后留下文件与一条 `reconcile.log`，重放跑完必须能从 `SearchService.find` 搜到那条
 * 文件。其余用例覆盖失败保留、坏记录跳过、目标已删、日志重写与并发追加。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { ReconcileLog } from '../../../src/adapters/fs/reconcile-log.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { FileResourceStorage, InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ReconcileEntry } from '../../../src/domain/reconcile.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { ReconcileService } from '../../../src/services/reconcile.js';
import { ResourceService } from '../../../src/services/resource.js';
import { SkillService } from '../../../src/services/skill.js';
import { SearchService, type RetrievalSettings } from '../../../src/services/search.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const SCOPE = 'comem://user/alice';
const PARENT = `${SCOPE}/resources`;
const DOCS = `${PARENT}/docs`;
const SKILLS = `${SCOPE}/skills`;
const SKILL = `${SKILLS}/code-review`;
const SKILL_MD = `---
name: code-review
description: 代码审查清单
---

# Code Review
`;
const PRINCIPALS: readonly string[] = ['user:alice'];

const RETRIEVAL: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

const FIND_OPTIONS = {
  scopes: [PARENT],
  subject: 'user:alice',
  principals: PRINCIPALS,
};

let dataDir: string;
let db: DatabaseSync;
let store: ContentStore;
let metadata: MetadataFileStore;
let locks: PathLockManager;
let index: SqliteFtsIndex;
let nodes: NodeRepository;
let acl: AclService;
let authorizer: InheritingAuthorizer;
let summary: SummaryService;
let logger: RecordingLogger;
let log: ReconcileLog;
let resource: ResourceService;
let skill: SkillService;
let search: SearchService;
let reconcile: ReconcileService;

interface RecordingLogger extends Logger {
  readonly warnings: string[];
  readonly errors: string[];
}

function createLogger(): RecordingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: RecordingLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warnings.push(message);
    }),
    error: vi.fn((message: string) => {
      errors.push(message);
    }),
    child: () => logger,
    warnings,
    errors,
  };
  return logger;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-reconcile-'));
  await mkdir(join(dataDir, '_meta'), { recursive: true });
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 5, defaultTimeoutMs: 2000 });
  index = new SqliteFtsIndex({ db, logger });
  nodes = new NodeRepository({ db, logger });
  const permissions = new PermissionRepository({ db, logger });
  acl = new AclService({
    dataDir,
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions,
    nodes,
    logger,
    locks,
  });
  await acl.ensureRootPreset(Uri.parse(SCOPE));
  authorizer = new InheritingAuthorizer(acl, store);
  summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger,
    locks,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
  });
  log = new ReconcileLog({ dataDir, logger });
  resource = new ResourceService({
    store,
    locks,
    index,
    summary,
    storage: new FileResourceStorage(dataDir, log),
    logger,
    authorizer,
  });
  const filesystem = new FileSystemService({ store, locks, authorizer, logger });
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
    estimateTokens: (text) => text.length,
  });
  search = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL,
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });
  reconcile = new ReconcileService({ store, index, acl, nodes, log, logger });
  skill = new SkillService({
    store,
    locks,
    index,
    summary,
    reconcile: log,
    permissions,
    logger,
    authorizer,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function addResource(path: string, content: string, summary?: string): Promise<void> {
  await resource.addResource({
    parentUri: Uri.parse(PARENT),
    files: [{ path, content, summary }],
    subject: 'user:alice',
    principals: PRINCIPALS,
  });
}

function entry(uri: string, op: 'index' | 'permission' = 'index', at = '2026-11-09T00:00:00.000Z'): ReconcileEntry {
  return { op, uri, error: '写失败', at };
}

async function readLog(): Promise<string> {
  try {
    return await readFile(join(dataDir, '_meta/reconcile.log'), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

describe('真实失败链路', () => {
  it('索引写失败 → 重放 → find 能搜到那条文件；再重放一次是空操作', async () => {
    // 让这一次批量 upsert 真的失败：文件已经写盘，索引一条都没有。
    const upsert = vi.spyOn(index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    await addResource(
      'docs/orbital.md',
      '# 轨道茶壶\n\norbital-teapot 是一段只出现在这里的话。',
      '轨道茶壶规格',
    );

    const uri = `${DOCS}/orbital.md`;
    expect(await readLog()).toContain(uri);
    expect(await readLog()).toContain('"op":"index"');
    // 失败链路里文件在、索引不在：这是「静默不可见」的原始状态。
    expect(await search.find('orbital-teapot', FIND_OPTIONS)).toEqual([]);

    upsert.mockRestore();
    const replayed = await reconcile.replay();
    expect(replayed).toMatchObject({
      scanned: 1,
      resolved: 1,
      failed: 0,
      remaining: 0,
      compacted: true,
    });

    const hits = await search.find('orbital-teapot', FIND_OPTIONS);
    expect(hits.map((hit) => hit.uri)).toContain(uri);
    expect(await readLog()).toBe('');

    // 幂等：同一 URI 再重放一次，索引行与检索命中都不增加。
    await log.append(entry(uri));
    await expect(reconcile.replay()).resolves.toMatchObject({ scanned: 1, resolved: 1 });
    const rows = db.prepare('SELECT COUNT(*) AS total FROM node WHERE uri = ?').get(uri);
    expect(Number(rows?.['total'])).toBe(1);
    const again = await search.find('orbital-teapot', FIND_OPTIONS);
    expect(again.filter((hit) => hit.uri === uri)).toHaveLength(1);
    expect(await readLog()).toBe('');

    // 再跑一次没有可做的事；索引还在。
    await expect(reconcile.replay()).resolves.toMatchObject({ scanned: 0, resolved: 0 });
    expect((await search.find('orbital-teapot', FIND_OPTIONS)).map((hit) => hit.uri)).toContain(uri);
  });
});

describe('技能的真实失败链路', () => {
  it('索引写失败 → 对账记录 → 重放 → find 能搜到技能入口', async () => {
    const upsert = vi.spyOn(index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    const result = await skill.addSkill({
      parentUri: Uri.parse(SKILLS),
      name: 'code-review',
      files: [{ path: 'SKILL.md', content: new Uint8Array(Buffer.from(SKILL_MD, 'utf8')) }],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });

    const uri = `${SKILL}/SKILL.md`;
    expect(result.fileCount).toBe(1);
    // 文件落盘了、索引没写成；没有这条记录时重放器完全看不见这次失败。
    expect(await readLog()).toContain(uri);
    expect(await readLog()).toContain('"op":"index"');
    expect(
      await search.find('Code Review', {
        scopes: [SCOPE],
        subject: 'user:alice',
        principals: PRINCIPALS,
      }),
    ).toEqual([]);

    upsert.mockRestore();
    await expect(reconcile.replay()).resolves.toMatchObject({
      scanned: 1,
      resolved: 1,
      failed: 0,
      remaining: 0,
      compacted: true,
    });

    const hits = await search.find('Code Review', {
      scopes: [SCOPE],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toContain(uri);
    expect(await readLog()).toBe('');

    // 重放的定义是「恢复到原本该有的样子」：索引行必须与写路径逐字段一致，
    // 不是「非空」或「大致能用」。同一份 SKILL.md 正常安装一次作为对照。
    await skill.addSkill({
      parentUri: Uri.parse(SKILLS),
      name: 'replay-control',
      files: [{ path: 'SKILL.md', content: new Uint8Array(Buffer.from(SKILL_MD, 'utf8')) }],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });
    const rowOf = (target: string): Record<string, unknown> | undefined =>
      db
        .prepare(
          `SELECT n.abstract, n.body_digest, n.size, f.content
             FROM node n JOIN node_fts f ON f.uri = n.uri AND f.level = n.level
            WHERE n.uri = ?`,
        )
        .get(target) as Record<string, unknown> | undefined;
    const replayed = rowOf(uri);
    const written = rowOf(`${SKILLS}/replay-control/SKILL.md`);
    // 具体值：技能写路径把 frontmatter 的 description 当可检索摘要。
    expect(replayed).toMatchObject({
      abstract: '代码审查清单',
      size: Buffer.byteLength(SKILL_MD, 'utf8'),
    });
    // 正文是**整个文件原文**（含 frontmatter）：这是写路径的口径，重放必须复现它，
    // 而不是按资源文件的「去掉 frontmatter」重建。
    expect(String(replayed?.['content'])).toContain('code-review');
    // 不是「非空就行」：逐字段与同内容正常安装一次的对照行相同。
    expect(replayed).toEqual(written);
  });

  it('权限物化失败 → 对账记录 → 重放 → 技能节点出现 node_permission 行', async () => {
    // 持续失败（而不是只失败一次）：`addSkill` 之后的摘要失效会再物化一遍目录链，
    // 一次性失败会被那条路径顺手修好，测不到「失败留痕 + 重放修复」。
    const materialize = vi
      .spyOn(acl, 'materializeNode')
      .mockRejectedValue(new Error('权限表坏了'));

    await skill.addSkill({
      parentUri: Uri.parse(SKILLS),
      name: 'code-review',
      files: [{ path: 'SKILL.md', content: new Uint8Array(Buffer.from(SKILL_MD, 'utf8')) }],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });
    materialize.mockRestore();

    // 与资源路径同一形状：技能权限物化失败也要留下 `op: 'permission'` 的补偿线索，
    // 否则重放器不知道这次失败，技能装了却一直不在列表里。
    const logText = await readLog();
    expect(logText).toContain('"op":"permission"');
    expect(logText).toContain(SKILL);
    const before = db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(SKILL);
    expect(Number(before?.['total'])).toBe(0);

    await expect(reconcile.replay()).resolves.toMatchObject({
      failed: 0,
      remaining: 0,
    });

    const after = db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(SKILL);
    expect(Number(after?.['total'])).toBeGreaterThan(0);
    expect(await readLog()).toBe('');
  });
});

describe('失败与边界', () => {
  it('重放失败保留原记录，不删日志', async () => {
    await addResource('docs/keep.md', '保留正文');
    const uri = `${DOCS}/keep.md`;
    await log.append(entry(uri));

    vi.spyOn(index, 'upsert').mockRejectedValue(new Error('还是坏的'));
    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 1, resolved: 0, failed: 1, remaining: 1 });
    expect(await readLog()).toContain(uri);
  });

  it('坏记录只记 warn 并跳过，不影响后面的有效记录', async () => {
    await addResource('docs/good.md', '好文件正文');
    const goodUri = `${DOCS}/good.md`;
    // 手工制造两种坏行：不是 JSON、缺 uri。
    await writeFile(
      join(dataDir, '_meta/reconcile.log'),
      `${JSON.stringify(entry(goodUri))}\n`,
      'utf8',
    );
    const good = await readLog();
    await writeFile(
      join(dataDir, '_meta/reconcile.log'),
      `这不是 JSON\n{"op":"index","error":"缺 uri","at":"2026-11-09T00:00:00.000Z"}\n${good}`,
      'utf8',
    );

    const result = await reconcile.replay();

    expect(result).toMatchObject({
      scanned: 1,
      resolved: 1,
      failed: 0,
      corrupt: 2,
      remaining: 0,
    });
    expect(logger.warnings).toContain('对账日志记录已损坏，跳过。');
    expect(await index.stat(goodUri)).not.toBeNull();
    expect(await readLog()).toBe('');
  });

  it('URI 已被删除视为已解决，不算失败', async () => {
    const gone = `${DOCS}/gone.md`;
    await log.append(entry(gone));

    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 1, resolved: 1, failed: 0, remaining: 0 });
    expect(await readLog()).toBe('');
  });

  it('无法重放的 write / attachment 记录保留待人工处理', async () => {
    const writeUri = 'docs/relative-path.md';
    await writeFile(
      join(dataDir, '_meta/reconcile.log'),
      `${JSON.stringify({ op: 'write', uri: writeUri, error: '写失败', at: '2026-11-09T00:00:00.000Z' })}\n`,
      'utf8',
    );

    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 1, resolved: 0, failed: 0, unsupported: 1, remaining: 1 });
    expect(await readLog()).toContain(writeUri);
    expect(logger.warnings).toContain('对账日志里有无法重放的记录，已保留待人工处理。');
  });

  it('重写后只留未解决条目', async () => {
    await addResource('docs/a.md', 'A 正文');
    await addResource('docs/b.md', 'B 正文');
    const uriA = `${DOCS}/a.md`;
    const uriB = `${DOCS}/b.md`;
    // A 能重放成功，B 的 upsert 继续失败；重写后只该留下 B。
    await writeFile(
      join(dataDir, '_meta/reconcile.log'),
      `${JSON.stringify(entry(uriA, 'index', '2026-11-09T00:00:01.000Z'))}\n${JSON.stringify(entry(uriB, 'index', '2026-11-09T00:00:02.000Z'))}\n`,
      'utf8',
    );

    const realUpsert = index.upsert.bind(index);
    vi.spyOn(index, 'upsert').mockImplementation(async (records) => {
      if (records.some((record) => record.uri === uriB)) {
        throw new Error('B 还是坏的');
      }
      await realUpsert(records);
    });

    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 2, resolved: 1, failed: 1, remaining: 1 });
    const left = await readLog();
    expect(left).toContain(uriB);
    expect(left).not.toContain(uriA);
  });

  it('重放期间新追加的记录不会被重写覆盖', async () => {
    await addResource('docs/a.md', 'A 正文');
    await addResource('docs/c.md', 'C 正文');
    const uriA = `${DOCS}/a.md`;
    const uriC = `${DOCS}/c.md`;
    // 清空 add 留下的日志，只放 A；C 的记录会在重放的 upsert 里追加进来。
    await writeFile(join(dataDir, '_meta/reconcile.log'), '', 'utf8');
    await log.append(entry(uriA));

    const realUpsert = index.upsert.bind(index);
    vi.spyOn(index, 'upsert').mockImplementationOnce(async (records) => {
      await log.append(entry(uriC, 'index', '2026-11-09T00:00:03.000Z'));
      await realUpsert(records);
    });

    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 1, resolved: 1, failed: 0, remaining: 1 });
    const left = await readLog();
    expect(left).toContain(uriC);
    expect(left).not.toContain(uriA);
  });

  it('权限物化失败 → 重放后该节点有 node_permission 行', async () => {
    const materialize = vi.spyOn(acl, 'materializeNode').mockRejectedValueOnce(new Error('权限表坏了'));

    await addResource('docs/perm.md', '权限正文');
    materialize.mockRestore();

    const uri = `${DOCS}/perm.md`;
    expect(await readLog()).toContain('"op":"permission"');
    const before = db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(uri);
    expect(Number(before?.['total'])).toBe(0);

    const result = await reconcile.replay();

    expect(result).toMatchObject({ scanned: 1, resolved: 1, failed: 0, remaining: 0 });
    const after = db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(uri);
    expect(Number(after?.['total'])).toBeGreaterThan(0);

    // 权限物化也是幂等：再重放一次，行数不变。
    await log.append(entry(uri, 'permission'));
    await reconcile.replay();
    const repeated = db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(uri);
    expect(Number(repeated?.['total'])).toBe(Number(after?.['total']));
  });
});
