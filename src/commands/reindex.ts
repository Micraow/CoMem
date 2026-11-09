/**
 * 索引重建命令（架构文档 §7「删库可重建」、§20 的运维链路）。
 *
 * **只从磁盘读，不信任 SQLite。** 索引坏了才是要重建的理由：拿 `node` 表当输入
 * 等于假设「坏掉的东西还能用」。这里遍历真实文件系统，重新解析 frontmatter、重新
 * 计算 digest、重新写 `node` / `node_fts` / `node_embedding`。
 *
 * ## 断点续跑
 *
 * 按 URI 升序处理，每一步都是幂等 upsert。中途失败（供应商抖动、进程被杀）后重跑：
 * 已写入的嵌入按 `content_digest` 判定为「没变」直接跳过，只处理剩下的。游标不必
 * 落盘——**磁盘是真相**，重跑重新遍历一遍就得到同一份候选集。
 *
 * ## 范围
 *
 * 只重建**检索索引**（`node` / `node_fts`）与**向量**（`node_embedding`）。
 * 物化权限（`node_permission`）不在这里重算：它由 `.acl.json` 与所有者推导，
 * 归属 `AclService` 的写路径（§8.2「写时算，读时查」）。索引损坏（表被删、写坏）
 * 而权限表完好是常态；整库丢失时权限要另走 ACL 重建，不在本命令的职责里。
 *
 * ## 输出约定
 *
 * 进度写 stderr（`ConsoleLogger` 与 `progress()` 都走 stderr），stdout 只留最终
 * 一行「成功了」。这样 `reindex > report.json` 拿到的是一份干净结果，而不是几万
 * 行进度。
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { ContentStore } from '../adapters/fs/content-store.js';
import { parseDocument } from '../adapters/fs/frontmatter.js';
import { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { AiSdkEmbeddingProvider } from '../adapters/llm/embedding-provider.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { EmbeddingCacheRepository } from '../adapters/sqlite/embedding-cache.js';
import {
  EmbeddingRepository,
  createEmbeddingTable,
} from '../adapters/sqlite/embedding-repository.js';
import { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { NodeRow } from '../adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../adapters/sqlite/retrieval-index.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { ContextType, NodeStatus } from '../domain/node.js';
import { stableDigest } from '../domain/node.js';
import type { IndexRecord } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';
import { EmbeddingService } from '../services/embedding.js';

import { loadCommandConfig } from './config.js';

export interface ReindexOptions {
  /** 数据根（测试注入用）；命令行传 `--data-dir` */
  readonly dataDir?: string;
  /** 配置文件路径（测试注入用）；命令行传 `--config` */
  readonly configPath?: string;
  /** 环境变量（测试注入用）；缺省 `process.env` */
  readonly env?: NodeJS.ProcessEnv;
  /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` / `--data-dir` 靠它生效 */
  readonly argv?: readonly string[];
  /** `--only=embeddings|index|all`，默认 all */
  readonly only?: 'embeddings' | 'index' | 'all';
  readonly dryRun?: boolean;
}

export interface ReindexResult {
  /** 磁盘上的节点数（文件 + 目录）。`dryRun` 时是「会被处理」的数量 */
  readonly scanned: number;
  /** 实际写入的检索索引 / 向量条数 */
  readonly rewritten: number;
  /** 嵌入没变而跳过的文件数 */
  readonly skipped: number;
  /** 解析失败或嵌入降级的节点数 */
  readonly failed: number;
}

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/**
 * 维度变化时的备份表名。
 *
 * 普通表，不是虚拟表：`vec0` 的 shadow 表（`node_embedding_info` / `_chunks` …）
 * 不跟着 `ALTER TABLE ... RENAME` 改名，建同名新表会撞
 * `table "node_embedding_info" already exists`。复制成普通表是唯一能保留旧向量的做法。
 */
const EMBEDDING_BACKUP_TABLE = 'node_embedding_backup';

/**
 * 进度输出间隔。
 *
 * 100 是经验值：再密会把 stderr 刷成噪声（大库几十万行），再疏就看不到「卡在
 * 哪一段」。只在 stderr 输出，不影响 stdout 的结果行。
 */
const PROGRESS_INTERVAL = 100;

/** 秒 → 毫秒。`providers.embedding.timeoutSeconds` 是秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/** §6.5 的四个上下文目录名（复数）→ §8.1 的 `context_type`（单数）。 */
const CONTEXT_TYPE_BY_DIRECTORY: Readonly<Record<string, ContextType>> = {
  memories: 'memory',
  resources: 'resource',
  skills: 'skill',
  sessions: 'session',
};

/**
 * 认不出的目录按 `resource` 处理，与 `IndexObserver` / `SummaryService` 的兜底
 * 一致：把普通目录当记忆比当资料更危险。
 */
const DEFAULT_CONTEXT_TYPE: ContextType = 'resource';

/** 文件是 L2 原文；目录自身是 L0 摘要（§8.5）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';
/** 目录概览行的层级（§8.5）：概览正文作为一条独立的检索行重建。 */
const OVERVIEW_LEVEL = 'L1';
const ACTIVE_STATUS: NodeStatus = 'active';

interface DiskNode {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
}

interface FrontmatterFields {
  readonly memoryType: string | null;
  readonly status: NodeStatus | null;
}

function isNodeStatus(value: unknown): value is NodeStatus {
  return value === 'active' || value === 'pending' || value === 'archived';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/** §6.3：`projects/{pid}/` 先剥一层，再按段名推 `context_type`。 */
function contextTypeOf(uri: Uri): ContextType {
  const segments = uri.segments[0] === 'projects' ? uri.segments.slice(2) : uri.segments;
  const head = segments[0];
  if (head === undefined) {
    return DEFAULT_CONTEXT_TYPE;
  }
  return CONTEXT_TYPE_BY_DIRECTORY[head] ?? DEFAULT_CONTEXT_TYPE;
}

/** 记忆文件的 `memory_type` / `status`（`IndexObserver` 的同一份映射）。 */
function readFrontmatterFields(data: Readonly<Record<string, unknown>>): FrontmatterFields {
  const memoryType = data['memory_type'];
  const status = data['status'];
  return {
    memoryType: typeof memoryType === 'string' && memoryType !== '' ? memoryType : null,
    status: isNodeStatus(status) ? status : null,
  };
}

/** 数据根下的两个 scope 目录（`user` / `group`）。不存在不是错误。 */
async function listRoots(dataDir: string): Promise<readonly Uri[]> {
  const roots: Uri[] = [];
  for (const scope of ['user', 'group'] as const) {
    let names: readonly string[];
    try {
      names = await readdir(join(dataDir, scope));
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const name of names) {
      try {
        roots.push(Uri.parse(`comem://${scope}/${name}`));
      } catch {
        // 不是合法根标识的目录（`_meta` 之外的临时产物）：`Uri` 表示不了，跳过。
      }
    }
  }
  return roots;
}

/**
 * 遍历磁盘上的全部节点。
 *
 * 用 `ContentStore.list` 而不是 `node:fs` 裸遍历：它已经处理了 NFC 规范化、
 * 保留名、临时文件过滤与「URI 表示不了的条目」——重写一遍这些规则只会让两处
 * 慢慢漂移。排序放在最后，保证重跑时处理顺序稳定（断点续跑的依据）。
 */
async function walkDataDir(dataDir: string, logger: Logger): Promise<readonly DiskNode[]> {
  const store = new ContentStore({ dataDir, logger });
  const nodes: DiskNode[] = [];

  for (const root of await listRoots(dataDir)) {
    const stat = await store.stat(root);
    if (stat === null) {
      continue;
    }
    nodes.push({ uri: root, kind: stat.kind });

    const stack: Uri[] = stat.kind === 'directory' ? [root] : [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      let children;
      try {
        children = await store.list(current);
      } catch (error) {
        if (error instanceof ComemError && error.code === 'NOT_FOUND') {
          continue;
        }
        throw error;
      }
      for (const child of children) {
        nodes.push({ uri: child.uri, kind: child.kind });
        if (child.kind === 'directory') {
          stack.push(child.uri);
        }
      }
    }
  }

  return nodes.sort((left, right) => {
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri === rightUri) {
      return 0;
    }
    return leftUri < rightUri ? -1 : 1;
  });
}

/**
 * 从磁盘重建一个节点的 `IndexRecord`（目录可能两条）。失败抛 `ComemError`
 * （坏 frontmatter 等）。
 *
 * 目录有摘要文件时返回两行：L0（`abstract` = L0 摘要）与 L1（`content` = 概览正文）。
 * 与写路径一致——概览正文是目录最丰富的那段可检索文本，重建索引时它同样从
 * `.overview.md` 里读出来，不能让 `reindex` 之后只有写路径生成过的目录才搜得到概览。
 *
 * 没有摘要文件时只返回 L0 行。此时磁盘上就没有概览可索引，残留的 L1 行会在下一次
 * 摘要生成时被覆盖（`SummaryService.#persistSummary` 两行一起写）。
 */
async function buildRecords(
  store: ContentStore,
  metadata: MetadataFileStore,
  node: DiskNode,
  existing: NodeRow | null,
): Promise<readonly IndexRecord[]> {
  const stat = await store.stat(node.uri);
  if (stat === null) {
    throw new ComemError('NOT_FOUND', `磁盘上的节点已不可寻址：${node.uri.toString()}`, {
      uri: node.uri.toString(),
    });
  }

  const contextType = contextTypeOf(node.uri);
  const parentUri = node.uri.parent()?.toString() ?? '';

  if (node.kind === 'directory') {
    const summary = await metadata.readSummary(node.uri);
    const base: IndexRecord = {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextType,
      memoryType: existing?.memoryType ?? null,
      level: DIRECTORY_LEVEL,
      abstract: summary.abstract === '' ? null : summary.abstract,
      content: '',
      bodyDigest: stableDigest(''),
      size: stat.size,
      updatedAt: stat.updatedAt,
      status: existing?.status ?? ACTIVE_STATUS,
    };
    if (summary.overview === '') {
      return [base];
    }
    return [
      base,
      {
        ...base,
        level: OVERVIEW_LEVEL,
        content: summary.overview,
        bodyDigest: stableDigest(summary.overview),
      },
    ];
  }

  const raw = Buffer.from(await store.readBytes(node.uri)).toString('utf8');
  const document = parseDocument(raw);
  const fields = readFrontmatterFields(document.data);
  const summary = document.data['summary'];

  return [
    {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'document',
      contextType,
      // frontmatter 是记忆类型的唯一真相；读不出来时保留索引里的旧值。
      memoryType: fields.memoryType ?? existing?.memoryType ?? null,
      level: DOCUMENT_LEVEL,
      abstract: typeof summary === 'string' && summary !== '' ? summary : null,
      content: document.body,
      bodyDigest: stableDigest(document.body),
      size: stat.size,
      updatedAt: stat.updatedAt,
      status: fields.status ?? existing?.status ?? ACTIVE_STATUS,
    },
  ];
}

function progress(
  scanned: number,
  total: number,
  rewritten: number,
  skipped: number,
  failed: number,
): void {
  process.stderr.write(
    `reindex: ${scanned}/${total} 已扫描，重写 ${rewritten}，跳过 ${skipped}，失败 ${failed}\n`,
  );
}

interface EmbeddingBackup {
  readonly model: string;
  readonly dimension: number;
}

/**
 * 把当前向量表复制到备份表，返回它的模型与维度。
 *
 * `vec0` 的向量列能直接 `SELECT` 出来（BLOB），也能原样写回同维度的新表，所以备份
 * 是一次 `CREATE TABLE ... AS SELECT`，不需要逐行读向量。
 */
function backupEmbeddings(db: DatabaseSync): EmbeddingBackup {
  const row = db.prepare('SELECT model, dimension FROM embedding_model WHERE id = 1').get();
  const dimension = Number(row?.['dimension']);
  const model = String(row?.['model'] ?? '');
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new ComemError('INTERNAL', '向量表缺少维度元数据，无法备份重建。', { dimension });
  }
  db.exec(`DROP TABLE IF EXISTS ${EMBEDDING_BACKUP_TABLE}`);
  db.exec(`CREATE TABLE ${EMBEDDING_BACKUP_TABLE} AS
    SELECT uri, model, content_digest, embedding FROM node_embedding`);
  return { model, dimension };
}

/**
 * 回滚：删掉按新维度建的表，按备份的维度重建，再把行写回去。
 *
 * 元数据行也要改回旧维度——否则下次启动时 `ensureSchema` 会认为「库里的维度与
 * 配置一致」，而实际表是旧维度，写入时报一句没有上下文的 SQL 错误。
 */
function restoreEmbeddings(db: DatabaseSync, backup: EmbeddingBackup, logger: Logger): void {
  db.exec('DROP TABLE IF EXISTS node_embedding');
  db.exec('DELETE FROM embedding_model WHERE id = 1');
  createEmbeddingTable(db, backup.dimension);
  db.exec(`INSERT INTO node_embedding (uri, model, content_digest, embedding)
    SELECT uri, model, content_digest, embedding FROM ${EMBEDDING_BACKUP_TABLE}`);
  db.prepare(
    'INSERT INTO embedding_model (id, model, dimension, created_at) VALUES (1, ?, ?, ?)',
  ).run(backup.model, backup.dimension, new Date().toISOString());
  logger.warn('向量表重建失败，已回滚到旧维度。', { dimension: backup.dimension });
}

/**
 * 重建索引。
 *
 * `dryRun` 不打开数据库：`openDatabase` 会创建文件、`runMigrations` 会写
 * `schema_version`，那就不是「只报数不改」了。dry-run 只遍历磁盘并报告
 * `scanned`，其余计数保持 0——它们描述的是「实际写入了什么」。
 */
export async function runReindex(options: ReindexOptions = {}): Promise<ReindexResult> {
  // 统一入口：`configPath` / `dataDir` 是测试注入用的显式覆盖，真实 `--config` /
  // `--data-dir` 从 `options.argv` 解析（缺省 `process.argv.slice(2)`）。只合成
  // `--data-dir` 会把真实 `--config` 丢掉，那正是这个入口要消灭的静默失败。
  const config = loadCommandConfig({
    ...(options.configPath === undefined ? {} : { path: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    argv: [
      ...(options.dataDir === undefined ? [] : ['--data-dir', options.dataDir]),
      ...(options.argv ?? process.argv.slice(2)),
    ],
  });
  const only = options.only ?? 'all';
  const dryRun = options.dryRun ?? false;

  // 进度与诊断都走 stderr；stdout 只留最终结果。
  const logger = new ConsoleLogger({
    level: config.logging.level,
    write: (line) => process.stderr.write(line),
  });

  const nodes = await walkDataDir(config.dataDir, logger);
  if (dryRun) {
    progress(0, nodes.length, 0, 0, 0);
    return { scanned: nodes.length, rewritten: 0, skipped: 0, failed: 0 };
  }

  const embeddingConfig = config.providers.embedding;
  const needsEmbeddings = only === 'embeddings' || only === 'all';
  if (needsEmbeddings && embeddingConfig.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '重算嵌入需要配置 providers.embedding（当前是 disabled）。',
      { only },
    );
  }

  // 数据根可能还没建过 `_meta`（全新目录 / 只恢复了内容文件）：`openDatabase`
  // 不会替调用方建父目录。
  await mkdir(join(config.dataDir, META_DIRECTORY), { recursive: true });
  const db = openDatabase(join(config.dataDir, META_DIRECTORY, DATABASE_FILE));
  /** 维度变化时的备份；成功回填之后删掉，抛错时用它回滚。 */
  let backup: EmbeddingBackup | null = null;
  try {
    runMigrations(db);

    const store = new ContentStore({ dataDir: config.dataDir, logger });
    const metadata = new MetadataFileStore({ dataDir: config.dataDir, logger });
    const index = new SqliteFtsIndex({
      db,
      logger,
      candidateMultiplier: config.retrieval.candidateMultiplier,
    });
    const nodeRepository = new NodeRepository({ db, logger });
    const embeddings = new EmbeddingRepository({ db, logger });
    const embedding = new EmbeddingService({
      // 回填同样走缓存：同一份正文在「回填」与「写路径」之间的结果必须一致，
      // 否则第二次重建会重复打供应商。
      cache: embeddingConfig.cache.enabled
        ? new EmbeddingCacheRepository({ db, logger, maxEntries: embeddingConfig.cache.maxEntries })
        : null,
      provider:
        embeddingConfig.type === 'disabled'
          ? null
          : new AiSdkEmbeddingProvider({
              type: embeddingConfig.type,
              ...(embeddingConfig.baseUrl === ''
                ? {}
                : { baseUrl: embeddingConfig.baseUrl }),
              model: embeddingConfig.model,
              apiKey: embeddingConfig.apiKey,
              dimension: embeddingConfig.dimension,
              maxBatchSize: embeddingConfig.maxBatchSize,
              timeoutSeconds: embeddingConfig.timeoutSeconds,
              logger,
            }),
      logger,
      config: {
        dimension: embeddingConfig.dimension,
        maxBatchSize: embeddingConfig.maxBatchSize,
        timeoutMs: embeddingConfig.timeoutSeconds * MILLISECONDS_PER_SECOND,
      },
    });

    const model = embedding.model;
    let rewritten = 0;
    let skipped = 0;
    let failed = 0;

    // 维度变了要整表重建：`vec0` 的维度固定在 `CREATE VIRTUAL TABLE` 时，旧表里的
    // 向量一条都用不了。先备份，回填成功后再删；中途抛错就回滚到旧维度。
    //
    // 「没有元数据行」不是变化：全新库 / 只跑过 `--only=index` 的库由
    // `ensureSchema` 直接建表。
    if (needsEmbeddings) {
      const stored = embeddings.storedDimension();
      if (stored !== null && stored !== embeddingConfig.dimension) {
        backup = backupEmbeddings(db);
        db.exec('DROP TABLE node_embedding');
        db.exec('DELETE FROM embedding_model WHERE id = 1');
        logger.info('向量维度变化，已备份旧表并重建。', {
          stored,
          configured: embeddingConfig.dimension,
          backup: EMBEDDING_BACKUP_TABLE,
        });
      }
      embeddings.ensureSchema(embeddingConfig.dimension, embeddingConfig.model);
    }

    for (const [indexInBatch, node] of nodes.entries()) {
      const uri = node.uri.toString();
      const existing = nodeRepository.get(uri);
      let wrote = false;

      try {
        // 1) 检索索引：按磁盘内容重建 `node` + `node_fts`。
        if (only === 'index' || only === 'all') {
          await index.upsert(await buildRecords(store, metadata, node, existing));
          wrote = true;
        }

        // 2) 向量：只处理有正文的文件。目录的 L0 摘要不参与语义检索。
        if (needsEmbeddings && node.kind === 'file' && model !== null) {
          const raw = Buffer.from(await store.readBytes(node.uri)).toString('utf8');
          const document = parseDocument(raw);
          if (document.body !== '') {
            const digest = stableDigest(document.body);
            const current = embeddings.get(uri);
            if (
              current !== null &&
              current.model === model &&
              current.contentDigest === digest
            ) {
              skipped += 1;
            } else {
              const outcome = await embedding.embed([document.body]);
              const vector = outcome.vectors[0];
              if (outcome.degraded || vector === undefined) {
                failed += 1;
                logger.warn('嵌入降级，跳过写入', {
                  uri,
                  reason: outcome.reason ?? '没有返回向量。',
                });
              } else {
                embeddings.upsert([{ uri, model, contentDigest: digest, vector }]);
                wrote = true;
              }
            }
          }
        }
      } catch (error) {
        // 坏文件（frontmatter 不合法、读盘失败）只影响自己：整批中断会让「一个
        // 坏文件卡住全库重建」，而 reindex 的用途恰恰是修复。
        failed += 1;
        logger.warn('重建索引跳过节点', { uri, error: errorMessage(error) });
        continue;
      }

      if (wrote) {
        rewritten += 1;
      }
      if ((indexInBatch + 1) % PROGRESS_INTERVAL === 0) {
        progress(indexInBatch + 1, nodes.length, rewritten, skipped, failed);
      }
    }

    progress(nodes.length, nodes.length, rewritten, skipped, failed);
    if (backup !== null) {
      db.exec(`DROP TABLE IF EXISTS ${EMBEDDING_BACKUP_TABLE}`);
    }
    return { scanned: nodes.length, rewritten, skipped, failed };
  } catch (error) {
    // 单个节点的失败在循环里已经计入 `failed`，走到这里的只有全局故障（磁盘满、
    // 表结构被外部改坏）。旧表还在备份表里，先还原再往上抛。
    if (backup !== null) {
      try {
        restoreEmbeddings(db, backup, logger);
      } catch (restoreError) {
        // 回滚自己失败时不能盖掉原始错误：那会让「为什么重建失败」变成「为什么
        // 回滚失败」。备份表留在库里，运维还能手工恢复。
        logger.error('回滚向量表失败，旧向量保留在备份表。', {
          backup: EMBEDDING_BACKUP_TABLE,
          reason: errorMessage(restoreError),
        });
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

/** 解析 `--only` 的取值。非法值直接抛 `INVALID_ARGUMENT`，不静默取默认。 */
function parseOnly(raw: string): ReindexOptions['only'] {
  if (raw === 'embeddings' || raw === 'index' || raw === 'all') {
    return raw;
  }
  throw new ComemError('INVALID_ARGUMENT', `--only 只支持 embeddings | index | all：${raw}`, {
    only: raw,
  });
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = `--${name}`;
  for (const [index, arg] of argv.entries()) {
    if (arg === prefixed) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${prefixed}=`)) {
      return arg.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

/**
 * 只解析命令自己的参数。`--config` / `--data-dir` 归 `loadCommandConfig` 解析：
 * 在这里再读一遍就会多一份「哪个 flag 算配置」的实现，漏一个就静默失效。
 */
function parseArgs(argv: readonly string[]): ReindexOptions {
  const only = readFlag(argv, 'only');
  return {
    ...(only === undefined ? {} : { only: parseOnly(only) }),
    ...(argv.includes('--dry-run') ? { dryRun: true } : {}),
  };
}

/** 只有直接执行（`tsx src/commands/reindex.ts`）时才跑 CLI 入口，测试 import 不触发。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  runReindex({ ...parseArgs(argv), argv }).then(
    (result) => {
      process.stdout.write(
        `reindex 完成：扫描 ${result.scanned}，重写 ${result.rewritten}，跳过 ${result.skipped}，失败 ${result.failed}。\n`,
      );
    },
    (error: unknown) => {
      process.stderr.write(`reindex 失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
