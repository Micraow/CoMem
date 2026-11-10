/**
 * 向量回填循环：候选 URI → 读盘 → 解析正文 → 嵌入 → 写 `node_embedding`。
 *
 * 两处调用方共用它：`reindex` 的向量段（`--only=embeddings` 与 `--only=all`），
 * 以及启动后的后台回填（`bootstrap/main.ts`）。
 */

import { parseDocument } from '../../adapters/fs/frontmatter.js';
import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { EmbeddingRepository, EmbeddingRow } from '../../adapters/sqlite/embedding-repository.js';
import { ComemError, errorMessage } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { stableDigest } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';
import type { EmbeddingService } from '../../services/embedding.js';


/** 一批回填结束时的进度。`remaining` 是还没处理的候选数（不含本批）。 */
export interface EmbedMissingNodesProgress {
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly remaining: number;
}

export interface EmbedMissingNodesResult {
  /** 本次写了向量的 URI（升序）。调用方用它算「有东西被写回的节点数」。 */
  readonly embeddedUris: readonly string[];
  /** 磁盘正文摘要与库里那一行一致的节点数（没打供应商）。 */
  readonly skipped: number;
  /** 读盘 / 解析 / 嵌入 / 写入失败的 URI，同一个节点只出现一次。 */
  readonly failedUris: readonly string[];
  /** 是否被 `signal` 中止。已写入的批次不回滚。 */
  readonly aborted: boolean;
}

export interface EmbedMissingNodesDeps {
  readonly embeddings: EmbeddingRepository;
  readonly embedding: EmbeddingService;
  readonly store: ContentStore;
  readonly logger: Logger;
  /**
   * 每批的节点数。
   *
   * 它同时决定一次 `embedding.embed()` 里最多几条正文（服务内部还会按供应商的
   * `maxBatchSize` 再切片）。CLI 传 1：与抽取前的「一个节点一次调用」逐条一致，
   * 降级只影响当前节点、断点续跑的进度也是按节点计的；启动回填传供应商的批大小。
   */
  readonly batchSize: number;
  /** 中止信号。只在批与批之间检查，并透传给在途的供应商调用。 */
  readonly signal?: AbortSignal;
  /** 每批结束回调（启动回填用它记进度；CLI 用它打进度行）。 */
  readonly onBatch?: (progress: EmbedMissingNodesProgress) => void;
}

/**
 * 给一批节点补齐向量：**候选 URI → 读盘 → 解析正文 → 嵌入 → 写 `node_embedding`**。
 *
 * 两处调用方共用它：
 * - `runReindex --only=embeddings`（以及 `--only=all` 的向量那一段）：候选集是磁盘
 *   遍历出来的文件——`reindex` 的输入永远是磁盘，不能因为索引里没有这一行就漏掉；
 * - 启动回填（`bootstrap/main.ts`）：候选集是 `documentsMissingVectors`。
 *
 * **摘要与正文都从磁盘读，不拿 `node.body_digest` 当输入。** `node` 行可能落后于
 * 磁盘，用它的摘要配上刚读出的正文，会写出「digest 对得上索引、向量来自另一份正文」
 * 的行——这种行最难查：检索命中的是旧内容，而启动探测与下一次 reindex 都认为它是最新的。
 *
 * 每个节点先拿刚算出的摘要与库里那一行比，一致就跳过（不打供应商）；不一致才嵌。
 * 失败只记 warn 并继续：一个读不出来的文件、一次供应商抖动都不该让剩下的记忆永远
 * 没有向量（`EmbeddingService` 的熔断会在连续失败后短路，继续下一批不会猛打供应商）。
 */
export async function embedMissingNodes(
  uris: readonly string[],
  deps: EmbedMissingNodesDeps,
): Promise<EmbedMissingNodesResult> {
  const { embeddings, embedding, store, logger, batchSize, signal } = deps;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new ComemError('INVALID_ARGUMENT', '回填向量的批大小必须是正整数。', { batchSize });
  }
  const model = embedding.model;
  if (model === null) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '回填向量需要配置 providers.embedding（当前是 disabled）。',
    );
  }
  const aborted = (): boolean => signal?.aborted === true;

  const embeddedUris: string[] = [];
  let skipped = 0;
  const failed = new Set<string>();

  for (let start = 0; start < uris.length; start += batchSize) {
    if (aborted()) {
      return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
    }
    const batch = uris.slice(start, start + batchSize);

    // 1) 读盘 + 跳过判定。摘要从磁盘正文算，与库里那一行比——不与 `node.body_digest`
    // 比，也不拿它当写入的摘要（见文件头与上面的说明）。
    const pending: { readonly uri: string; readonly body: string; readonly digest: string }[] =
      [];
    for (const uri of batch) {
      try {
        const bytes = await store.readBytes(Uri.parse(uri));
        const document = parseDocument(Buffer.from(bytes).toString('utf8'));
        if (document.body === '') {
          continue;
        }
        const digest = stableDigest(document.body);
        const current = embeddings.get(uri);
        if (current !== null && current.model === model && current.contentDigest === digest) {
          skipped += 1;
          continue;
        }
        pending.push({ uri, body: document.body, digest });
      } catch (error) {
        failed.add(uri);
        logger.warn('读取正文失败，跳过该节点的向量。', { uri, error: errorMessage(error) });
      }
    }

    // 收到退出信号时不要再打供应商：已经补好的写入保留，剩下的下次启动再来。
    if (aborted()) {
      return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
    }

    // 2) 一次调用嵌一批，再一次事务写一批。
    if (pending.length > 0) {
      const outcome = await embedding.embed(
        pending.map((candidate) => candidate.body),
        signal === undefined ? {} : { signal },
      );
      if (outcome.degraded) {
        // 关闭信号打断的调用不算节点失败：它没有「失败」，只是下次再做。
        if (aborted()) {
          return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
        }
        for (const candidate of pending) {
          failed.add(candidate.uri);
        }
        logger.warn('嵌入降级，跳过这一批的向量写入。', {
          count: pending.length,
          reason: outcome.reason ?? '没有返回向量。',
        });
      } else {
        const rows: EmbeddingRow[] = [];
        for (const [index, candidate] of pending.entries()) {
          const vector = outcome.vectors[index];
          if (vector === undefined) {
            failed.add(candidate.uri);
            continue;
          }
          rows.push({
            uri: candidate.uri,
            model,
            contentDigest: candidate.digest,
            vector,
          });
        }
        if (rows.length > 0) {
          try {
            embeddings.upsert(rows);
            for (const row of rows) {
              embeddedUris.push(row.uri);
            }
          } catch (error) {
            for (const row of rows) {
              failed.add(row.uri);
            }
            logger.warn('向量写入失败，跳过这一批。', {
              count: rows.length,
              error: errorMessage(error),
            });
          }
        }
      }
    }

    deps.onBatch?.({
      embedded: embeddedUris.length,
      skipped,
      failed: failed.size,
      remaining: uris.length - (start + batch.length),
    });
  }

  return { embeddedUris, skipped, failedUris: [...failed], aborted: aborted() };
}
