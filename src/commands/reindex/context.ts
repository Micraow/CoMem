/**
 * 重建的依赖装配与向量表就位。
 *
 * 装配放在这里而不是 `runReindex` 里：编排只关心「先索引、再向量、最后关联边」的
 * 顺序，构造哪几个仓储、用哪份配置构造，是装配的事。
 */

import type { DatabaseSync } from 'node:sqlite';

import { ContentStore } from '../../adapters/fs/content-store.js';
import { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import { AiSdkEmbeddingProvider } from '../../adapters/llm/embedding-provider.js';
import { EmbeddingCacheRepository } from '../../adapters/sqlite/embedding-cache.js';
import {
  EmbeddingRepository,
  createEmbeddingTable,
} from '../../adapters/sqlite/embedding-repository.js';
import { MemoryLinkRepository } from '../../adapters/sqlite/memory-link-repository.js';
import { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../adapters/sqlite/retrieval-index.js';
import type { ComemConfig } from '../../config/index.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { EmbeddingService } from '../../services/embedding.js';
import { MemoryLinkService } from '../../services/memory-link.js';

/**
 * 维度变化时的备份表名。
 *
 * 普通表，不是虚拟表：`vec0` 的 shadow 表（`node_embedding_info` / `_chunks` …）
 * 不跟着 `ALTER TABLE ... RENAME` 改名，建同名新表会撞
 * `table "node_embedding_info" already exists`。复制成普通表是唯一能保留旧向量的做法。
 */
export const EMBEDDING_BACKUP_TABLE = 'node_embedding_backup';

/** 秒 → 毫秒。`providers.embedding.timeoutSeconds` 是秒。 */
const MILLISECONDS_PER_SECOND = 1000;

export interface EmbeddingBackup {
  readonly model: string;
  readonly dimension: number;
}

/** 一次重建要用到的仓储与服务。 */
export interface ReindexServices {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly index: SqliteFtsIndex;
  readonly nodeRepository: NodeRepository;
  readonly embeddings: EmbeddingRepository;
  readonly memoryLink: MemoryLinkService;
  readonly embedding: EmbeddingService;
}

/**
 * 按配置装配一次重建要用的仓储与服务。
 *
 * 与写路径同一组构造参数：重建读的文件、算的摘要、打的供应商都与写路径共用一个。
 */
export function createReindexServices(
  db: DatabaseSync,
  config: ComemConfig,
  logger: Logger,
  embeddingConfig: ComemConfig['providers']['embedding'],
): ReindexServices {
  const store = new ContentStore({ dataDir: config.dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir: config.dataDir, logger });
  const index = new SqliteFtsIndex({
    db,
    logger,
    candidateMultiplier: config.retrieval.candidateMultiplier,
  });
  const nodeRepository = new NodeRepository({ db, logger });
  const embeddings = new EmbeddingRepository({ db, logger });
  const memoryLink = new MemoryLinkService({
    repository: new MemoryLinkRepository({ db, logger }),
    logger,
  });
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
  return { store, metadata, index, nodeRepository, embeddings, memoryLink, embedding };
}

/**
 * 按配置的维度把向量表放到可写状态，返回需要回滚时的备份（无变化时 `null`）。
 *
 * 维度变了要整表重建：`vec0` 的维度固定在 `CREATE VIRTUAL TABLE` 时，旧表里的
 * 向量一条都用不了。先备份，回填成功后再删；中途抛错就回滚到旧维度。
 *
 * 「没有元数据行」不是变化：全新库 / 只跑过 `--only=index` 的库由
 * `ensureSchema` 直接建表。
 */
export function prepareEmbeddingTable(
  db: DatabaseSync,
  embeddings: EmbeddingRepository,
  embeddingConfig: ComemConfig['providers']['embedding'],
  logger: Logger,
): EmbeddingBackup | null {
  let backup: EmbeddingBackup | null = null;
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
  return backup;
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
export function restoreEmbeddings(
  db: DatabaseSync,
  backup: EmbeddingBackup,
  logger: Logger,
): void {
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
