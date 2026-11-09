/**
 * `reindex` 与索引观察者的 `context_type` 对拍（架构文档 §6.5、§7、§8.1）。
 *
 * 两条链路各自把「URI → context_type」写进 `node` 表：写路径由 `IndexObserver`
 * 算，重建由 `reindex` 算。这条判断原先在三处各写一份，`reindex` 会按自己那份重写
 * 整张 `context_type` 列——漂移时「写进去的」与「重建出来的」不一致，而
 * `contextTypes` 过滤结果要等到有人跑重建才会变。
 *
 * 这里在同一棵磁盘树上分别跑两条链路，比较 `node` 表里每个 URI 的 `context_type`。
 * **比较的是两条链路写出的行，不是「有没有 import 同一个函数」**：观察者用内存
 * SQLite（只看它写了什么），`reindex` 用 `--data-dir` 指向的数据根，各自独立计算。
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
import { NullLogger } from '../../../src/adapters/log/null.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { ContextType } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

import { runReindex } from '../../../src/commands/reindex.js';

const ROOT = 'comem://user/alice';

interface TreeNode {
  readonly uri: string;
  readonly contextType: ContextType;
}

/** 目录自身也要进索引（`node` 表的 L0 行），因此逐个显式建出来并通知观察者。 */
const DIRECTORY_NODES: readonly TreeNode[] = [
  { uri: `${ROOT}/memories`, contextType: 'memory' },
  { uri: `${ROOT}/memories/preferences`, contextType: 'memory' },
  { uri: `${ROOT}/resources`, contextType: 'resource' },
  { uri: `${ROOT}/skills`, contextType: 'skill' },
  { uri: `${ROOT}/sessions`, contextType: 'session' },
  { uri: `${ROOT}/projects/comem`, contextType: 'resource' },
  { uri: `${ROOT}/projects/comem/memories`, contextType: 'memory' },
  { uri: `${ROOT}/projects/comem/resources`, contextType: 'resource' },
  { uri: `${ROOT}/projects/comem/skills`, contextType: 'skill' },
  { uri: `${ROOT}/projects/comem/sessions`, contextType: 'session' },
  { uri: `${ROOT}/projects/comem/misc`, contextType: 'resource' },
  { uri: `${ROOT}/notes`, contextType: 'resource' },
];

const FILE_NODES: readonly TreeNode[] = [
  { uri: `${ROOT}/memories/profile.md`, contextType: 'memory' },
  { uri: `${ROOT}/memories/preferences/code-style.md`, contextType: 'memory' },
  { uri: `${ROOT}/resources/paper.md`, contextType: 'resource' },
  { uri: `${ROOT}/skills/review.md`, contextType: 'skill' },
  { uri: `${ROOT}/sessions/2026-11-09.md`, contextType: 'session' },
  { uri: `${ROOT}/projects/comem/memories/note.md`, contextType: 'memory' },
  { uri: `${ROOT}/projects/comem/resources/spec.md`, contextType: 'resource' },
  { uri: `${ROOT}/projects/comem/skills/style.md`, contextType: 'skill' },
  { uri: `${ROOT}/projects/comem/sessions/2026-11-08.md`, contextType: 'session' },
  { uri: `${ROOT}/projects/comem/misc/other.md`, contextType: 'resource' },
  { uri: `${ROOT}/notes/idea.md`, contextType: 'resource' },
];

const NODES: readonly TreeNode[] = [...DIRECTORY_NODES, ...FILE_NODES];

interface ObserverHarness {
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly observer: IndexObserver;
}

async function createObserver(dataDir: string): Promise<ObserverHarness> {
  const db = openDatabase(':memory:');
  runMigrations(db);

  const logger = new NullLogger();
  const store = new ContentStore({ dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const aclFile = new AclFileStore({ dataDir, logger });
  const permissions = new PermissionRepository({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  const index = new SqliteFtsIndex({ db, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });

  const acl = new AclService({ dataDir, db, aclFile, permissions, nodes, logger, locks });
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
  const observer = new IndexObserver({ store, index, acl, summary, nodes, permissions, logger });

  return { db, store, observer };
}

/** 按磁盘上的真实布局建出整棵树，逐个节点通知观察者（与写路径同一次调用）。 */
async function populate(harness: ObserverHarness): Promise<void> {
  for (const node of DIRECTORY_NODES) {
    const uri = Uri.parse(node.uri);
    await harness.store.mkdir(uri, { recursive: true });
    await harness.observer.onNodeWritten(uri, 'directory');
  }
  for (const node of FILE_NODES) {
    const uri = Uri.parse(node.uri);
    await harness.store.writeText(uri, `正文：${uri.name}`);
    await harness.observer.onNodeWritten(uri, 'file');
  }
  await harness.observer.drain();
}

function snapshot(db: DatabaseSync): Map<string, ContextType> {
  const rows = db.prepare('SELECT uri, context_type FROM node ORDER BY uri, level').all();
  const entries = new Map<string, ContextType>();
  for (const row of rows) {
    const uri = String(row['uri']);
    const contextType = String(row['context_type']) as ContextType;
    const existing = entries.get(uri);
    if (existing !== undefined) {
      // 目录的 L0 / L1 两行必须同类；不同类说明同一 URI 在一个库里自相矛盾。
      expect(contextType).toBe(existing);
      continue;
    }
    entries.set(uri, contextType);
  }
  return entries;
}

let dataDir: string;
let configPath: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-context-type-'));
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

describe('reindex 与索引观察者的归类一致', () => {
  it('同一棵树上两条链路写出的 context_type 逐 URI 相同', async () => {
    const observerHarness = await createObserver(dataDir);
    await populate(observerHarness);
    const observed = snapshot(observerHarness.db);
    observerHarness.db.close();

    const result = await runReindex({ dataDir, configPath, only: 'index' });
    expect(result.failed).toBe(0);

    const reindexDb = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
    const reindexed = snapshot(reindexDb);
    reindexDb.close();

    // 1) 两条链路各自都要符合 §6.5 的矩阵，不是「互相一致但一起错」。
    for (const node of NODES) {
      expect(observed.get(node.uri), `观察者：${node.uri}`).toBe(node.contextType);
      expect(reindexed.get(node.uri), `reindex：${node.uri}`).toBe(node.contextType);
    }

    // 2) 对拍：两条链路共同产出的每个 URI 分类相同。观察者会顺带为祖先目录
    //    （`projects/`、scope 根）生成摘要行，`reindex` 遍历磁盘时同样索引它们，
    //    所以比较集合比写入的节点多；这类额外节点也一并纳入对拍。
    const shared = [...observed.keys()].filter((uri) => reindexed.has(uri)).sort();
    for (const node of NODES) {
      expect(shared, `两条链路没有同时索引：${node.uri}`).toContain(node.uri);
    }
    for (const uri of shared) {
      expect(reindexed.get(uri), `归类漂移：${uri}`).toBe(observed.get(uri));
    }

    // 3) scope 根没有上下文段，兜底 resource。
    expect(reindexed.get(ROOT)).toBe('resource');
  });
});
