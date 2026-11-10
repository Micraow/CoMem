/**
 * 重建索引的编排（架构文档 §7「删库可重建」、§20 的运维链路）。
 *
 * 总体说明见门面 `../reindex.ts` 的文件头：只从磁盘读、不信任 SQLite。
 *
 * ## 断点续跑
 *
 * 按 URI 升序处理，每一步都是幂等 upsert。中途失败（供应商抖动、进程被杀）后重跑：
 * 已写入的嵌入按 `content_digest` 判定为「没变」直接跳过，只处理剩下的。游标不必
 * 落盘——**磁盘是真相**，重跑重新遍历一遍就得到同一份候选集。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDocument } from '../../adapters/fs/frontmatter.js';
import { ConsoleLogger } from '../../adapters/log/console.js';
import { openDatabase, runMigrations } from '../../adapters/sqlite/database.js';
import { ComemError } from '../../domain/errors.js';
import { loadCommandConfig } from '../config.js';
import {
  EMBEDDING_BACKUP_TABLE,
  createReindexServices,
  prepareEmbeddingTable,
  restoreEmbeddings,
} from './context.js';
import type { EmbeddingBackup } from './context.js';
import { collectDerivedEdges } from './derived.js';
import type { DerivedEdge } from './edge-key.js';
import type { ReindexOptions, ReindexResult } from './options.js';
import { buildRecords } from './records.js';
import { errorMessage, progress, progressVectors } from './report.js';
import { embedMissingNodes } from './vectors.js';
import { walkDataDir } from './walk.js';

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/**
 * 进度输出间隔。
 *
 * 100 是经验值：再密会把 stderr 刷成噪声（大库几十万行），再疏就看不到「卡在
 * 哪一段」。只在 stderr 输出，不影响 stdout 的结果行。
 */
const PROGRESS_INTERVAL = 100;

/** 记忆 frontmatter 的保留键 `sources`（§11.10）：每一条是一个归档 URI。 */
const SOURCES_KEY = 'sources';

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
    return { scanned: nodes.length, rewritten: 0, vectors: 0, links: 0, skipped: 0, failed: 0 };
  }

  const embeddingConfig = config.providers.embedding;
  const needsEmbeddings = only === 'embeddings' || only === 'all';
  const needsIndex = only === 'index' || only === 'all';
  const needsLinks = only === 'links' || only === 'all';
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

    const { store, metadata, index, nodeRepository, embeddings, memoryLink, embedding } =
      createReindexServices(db, config, logger, embeddingConfig);

    const model = embedding.model;
    let vectors = 0;
    let links = 0;
    let skipped = 0;
    /** 有东西被写回的节点（索引行或向量）。`rewritten` 是它的大小，一个节点算一次。 */
    const rewrittenUris = new Set<string>();
    /** 失败的节点。索引与向量两条路径可能都失败，同一个节点仍只算一次。 */
    const failedUris = new Set<string>();
    /** 按 `sources` 收集到的 `derived_from` 边；循环结束后一次整批替换。 */
    const derivedEdges: DerivedEdge[] = [];
    const seenEdges = new Set<string>();

    // 维度变了要整表重建：`vec0` 的维度固定在 `CREATE VIRTUAL TABLE` 时，旧表里的
    // 向量一条都用不了。先备份，回填成功后再删；中途抛错就回滚到旧维度。
    if (needsEmbeddings) {
      backup = prepareEmbeddingTable(db, embeddings, embeddingConfig, logger);
    }

    // 检索索引与关联边共用一次读盘：两条重建路径都要正文与 frontmatter。
    // 向量走 `embedMissingNodes`（它自己读盘，见下面的调用），不复用这里的解析结果：
    // 回填要独立成一个函数给启动路径用，先读一份再传进去会把两边的批处理边界缠在一起。
    if (needsIndex || needsLinks) {
      for (const [indexInBatch, node] of nodes.entries()) {
        const uri = node.uri.toString();
        const existing = nodeRepository.get(uri);

        try {
          const document =
            node.kind === 'file'
              ? parseDocument(Buffer.from(await store.readBytes(node.uri)).toString('utf8'))
              : null;

          // 1) 检索索引：按磁盘内容重建 `node` + `node_fts`。
          if (needsIndex) {
            await index.upsert(await buildRecords(store, metadata, logger, node, existing, document));
            rewrittenUris.add(uri);
          }

          // 2) 关联边：只收集，结束前一次整批替换（见循环后的 `rebuildDerived`）。
          if (needsLinks && document !== null) {
            collectDerivedEdges(node.uri, document.data[SOURCES_KEY], derivedEdges, seenEdges, logger);
          }
        } catch (error) {
          // 坏文件（frontmatter 不合法、读盘失败）只影响自己：整批中断会让「一个
          // 坏文件卡住全库重建」，而 reindex 的用途恰恰是修复。
          failedUris.add(uri);
          logger.warn('重建索引跳过节点', { uri, error: errorMessage(error) });
        }

        if ((indexInBatch + 1) % PROGRESS_INTERVAL === 0) {
          progress(indexInBatch + 1, nodes.length, rewrittenUris.size, skipped, failedUris.size);
        }
      }
    }

    // 3) 向量：候选集是磁盘上的文件。不从 `node` 表拿——`reindex` 的输入永远是磁盘，
    // 「索引里没有这一行」正是它要修的状态之一（断点续跑用例覆盖了这种库）。
    if (needsEmbeddings && model !== null) {
      const candidates = nodes
        .filter((node) => node.kind === 'file')
        .map((node) => node.uri.toString());
      const embedded = await embedMissingNodes(candidates, {
        store,
        embeddings,
        embedding,
        logger,
        // 逐条：一次供应商调用只对应一个节点，降级只影响它；断点续跑按节点计。
        batchSize: 1,
        onBatch: ({ remaining, embedded: done, skipped: skippedCount, failed }) => {
          const processed = candidates.length - remaining;
          if (processed % PROGRESS_INTERVAL === 0) {
            progressVectors(processed, candidates.length, done, skippedCount, failed);
          }
        },
      });
      vectors = embedded.embeddedUris.length;
      skipped = embedded.skipped;
      for (const uri of embedded.embeddedUris) {
        rewrittenUris.add(uri);
      }
      for (const uri of embedded.failedUris) {
        failedUris.add(uri);
      }
    }

    // `sources` 是真相：整批替换 `derived_from`，把表里多出来的旧边一起清掉。
    // 放在循环之后、一个短事务里：读盘与嵌入都不在事务内，重启后重跑得到同一份边。
    // 读不出来的文件（frontmatter 坏了）不贡献边，它在表里的旧边会被这次替换清掉；
    // 修好文件再跑一次就恢复——重建的输入永远只有磁盘，不拿旧边当兜底。
    if (needsLinks) {
      links = memoryLink.rebuildDerived(derivedEdges).inserted;
      logger.info('记忆关联边已重建。', { edges: links, memories: nodes.length });
    }

    progress(nodes.length, nodes.length, rewrittenUris.size, skipped, failedUris.size);
    if (backup !== null) {
      db.exec(`DROP TABLE IF EXISTS ${EMBEDDING_BACKUP_TABLE}`);
    }
    return {
      scanned: nodes.length,
      rewritten: rewrittenUris.size,
      vectors,
      links,
      skipped,
      failed: failedUris.size,
    };
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
