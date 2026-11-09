/**
 * 写后钩子的规则测试（架构文档 §10.6、§12.4）。
 *
 * 这个文件钉住的是一条**不会报错**的规则：批量写完之后父目录摘要必须 `markStale`，
 * 不能 `invalidate`。用错时没有异常、没有失败返回值，只有「目录摘要永远停在旧内容」。
 * 所以两组断言并存：
 *
 * 1. 调用形状：假 `summary` 同时提供 `markStale` 与 `invalidate`，断言被调的是前者。
 * 2. 真实症状：真 `SummaryService`，断言第二次写入之后目录摘要真的换成了新内容——
 *    换成 `invalidate` 时这条会红，因为它比较的正文在批量路径里已经是新的。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import { stableDigest } from '../../../src/domain/node.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import type { Authorizer } from '../../../src/services/authorizer.js';
import { RuleSummarizer, SummaryService, type InvalidationResult } from '../../../src/services/summary.js';
import {
  invalidateParentSummaries,
  materializeAncestorPermissions,
} from '../../../src/services/write-through.js';

const SCOPE = 'comem://user/alice';
const PARENT = `${SCOPE}/resources`;
const DOCS = `${PARENT}/docs`;
const SPEC = `${DOCS}/spec.md`;

let dataDir: string;
let db: DatabaseSync;
let store: ContentStore;
let locks: PathLockManager;
let index: SqliteFtsIndex;
let summary: SummaryService;
let logger: RecordingLogger;

interface RecordingLogger extends Logger {
  readonly errors: readonly { readonly message: string; readonly details: unknown }[];
}

function createLogger(): RecordingLogger {
  const errors: { message: string; details: unknown }[] = [];
  const logger: RecordingLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((message: string, details: unknown) => {
      errors.push({ message, details });
    }),
    child: () => logger,
    errors,
  };
  return logger;
}

function uri(value: string): Uri {
  return Uri.parse(value);
}

/** 只关心 `assert` 的 `Authorizer` 替身；另外两个方法按「全部放行」实现。 */
function stubAuthorizer(assert: (target: Uri) => Promise<void>): Authorizer {
  return {
    assert,
    check: async () => true,
    filterReadable: async (uris: readonly Uri[]) =>
      new Set(uris.map((entry) => entry.toString())),
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-write-through-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  store = new ContentStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 5, defaultTimeoutMs: 2000 });
  index = new SqliteFtsIndex({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  const acl = new AclService({
    dataDir,
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions: new PermissionRepository({ db, logger }),
    nodes,
    logger,
    locks,
  });
  summary = new SummaryService({
    nodes,
    index,
    metadata: new MetadataFileStore({ dataDir, logger }),
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger,
    locks,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
  });
  await acl.ensureRootPreset(uri(SCOPE));
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * 走一遍批量路径的前三步：写文件 → 一次 `index.upsert` → 摘要失效投递。
 *
 * 顺序是关键：索引先拿到新 digest，之后才标脏。`invalidate` 正是在这个顺序下失效。
 */
async function writeThenInvalidate(name: string, content: string): Promise<void> {
  const target = uri(`${DOCS}/${name}`);
  const stat = await store.writeText(target, content);
  const record: IndexRecord = {
    uri: target.toString(),
    parentUri: DOCS,
    scope: target.scope,
    kind: 'document',
    contextType: 'resource',
    memoryType: null,
    level: 'L2',
    abstract: content,
    content,
    bodyDigest: stableDigest(content),
    size: content.length,
    updatedAt: stat.updatedAt,
    status: 'active',
  };
  await index.upsert([record]);
  await invalidateParentSummaries({ summary, logger }, [target]);
}

describe('invalidateParentSummaries', () => {
  it('每个直接父目录只标一次 stale，且绝不调 invalidate', async () => {
    const calls: string[] = [];
    const stale: InvalidationResult = { recomputed: [], markedStale: [], stoppedAt: '' };
    const recording = {
      async markStale(directory: Uri): Promise<InvalidationResult> {
        calls.push(`markStale:${directory.toString()}`);
        return stale;
      },
      async invalidate(node: Uri): Promise<InvalidationResult> {
        calls.push(`invalidate:${node.toString()}`);
        return stale;
      },
    };

    await invalidateParentSummaries({ summary: recording, logger }, [
      uri(SPEC),
      uri(`${DOCS}/other.md`),
      uri(`${DOCS}/api/spec.md`),
    ]);

    // 去重口径是直接父目录：同目录的多个文件只标一次；顺序是写入顺序里首次出现的顺序。
    expect(calls).toEqual([`markStale:${DOCS}`, `markStale:${DOCS}/api`]);
  });

  it('投递失败只记 error，剩下的目录继续标', async () => {
    const attempted: string[] = [];
    const recording = {
      async markStale(directory: Uri): Promise<InvalidationResult> {
        attempted.push(directory.toString());
        if (directory.toString() === DOCS) {
          throw new Error('摘要服务坏了');
        }
        return { recomputed: [], markedStale: [], stoppedAt: directory.toString() };
      },
    };

    await invalidateParentSummaries({ summary: recording, logger }, [
      uri(SPEC),
      uri(`${DOCS}/api/spec.md`),
    ]);

    expect(attempted).toEqual([DOCS, `${DOCS}/api`]);
    expect(logger.errors).toEqual([
      {
        message: '摘要失效投递失败，已忽略。',
        details: { directory: DOCS, error: '摘要服务坏了' },
      },
    ]);
  });

  it('第二次写入之后父目录摘要换成新内容（用 invalidate 会停在旧内容）', async () => {
    await writeThenInvalidate('a.md', '# A');
    const first = await summary.read(uri(DOCS));
    expect(first?.overview).toContain('a.md');
    expect(first?.overview).not.toContain('b.md');

    // 第二个文件：索引里已经是新 digest。`invalidate` 在这里比较正文必然相等，
    // 整条传播链被静默跳过——摘要停在只有 a.md 的版本。
    await writeThenInvalidate('b.md', '# B');

    const second = await summary.read(uri(DOCS));
    expect(second?.overview).toContain('b.md');
  });
});

describe('materializeAncestorPermissions', () => {
  it('收集自身与全部祖先，从子到根，重复祖先只算一次', async () => {
    const calls: string[] = [];
    const authorizer = stubAuthorizer(async (target) => {
      calls.push(target.toString());
    });

    await materializeAncestorPermissions(
      { authorizer, logger, nodeLabel: '技能节点' },
      [uri(`${DOCS}/api/spec.md`), uri(`${DOCS}/api/other.md`)],
      ['user:alice'],
    );

    // 第一条链一直走到 scope 根；第二条链先收自身，到 `api` 就断（祖先已经收过）。
    expect(calls).toEqual([
      `${DOCS}/api/spec.md`,
      `${DOCS}/api`,
      DOCS,
      PARENT,
      SCOPE,
      `${DOCS}/api/other.md`,
    ]);
  });

  it('物化失败记日志并继续处理剩余 URI，onFailure 保住对账行为', async () => {
    const calls: string[] = [];
    const failures: { uri: string; reason: string }[] = [];
    const authorizer = stubAuthorizer(async (target) => {
      calls.push(target.toString());
      if (target.toString() === SPEC) {
        throw new Error('权限表写不进去');
      }
    });

    await materializeAncestorPermissions(
      {
        authorizer,
        logger,
        nodeLabel: '资源节点',
        onFailure: async (failed, reason) => {
          failures.push({ uri: failed, reason });
        },
      },
      [uri(SPEC)],
      ['user:alice'],
    );

    expect(calls).toEqual([SPEC, DOCS, PARENT, SCOPE]);
    expect(logger.errors).toEqual([
      {
        message: '资源节点权限物化失败，已忽略。',
        details: { uri: SPEC, reason: '权限表写不进去' },
      },
    ]);
    expect(failures).toEqual([{ uri: SPEC, reason: '权限表写不进去' }]);
  });

  it('日志文案的主语由调用方传入', async () => {
    const authorizer = stubAuthorizer(async () => {
      throw new Error('未授权');
    });

    await materializeAncestorPermissions(
      { authorizer, logger, nodeLabel: '技能节点' },
      [uri(`${SCOPE}/skills/code-review`)],
      ['user:alice'],
    );

    // 自身 → skills → scope 根，三个节点全部失败。
    expect(logger.errors.map((entry) => entry.message)).toEqual([
      '技能节点权限物化失败，已忽略。',
      '技能节点权限物化失败，已忽略。',
      '技能节点权限物化失败，已忽略。',
    ]);
  });
});
