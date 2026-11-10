/**
 * 嵌入批次的规划与供应商调用（§8.1 的 `node_embedding`、§17.2 的异步阶段）。
 *
 * 这一层只处理「一批记录」：去重、切片、失败隔离。队列、合并窗口与 `#embedFlush`
 * 这些可变状态留在 `observer.ts` 的类里，因为 `drain()` 要与摘要失效任务一起汇合。
 *
 * ## 合并窗口（`EMBED_COALESCE_MS`）为什么必要
 *
 * 排期的目的有两个：把嵌入推到 `withLock` 的 `finally` 之后（不能在路径锁里打网络），
 * 以及**把同一段时间里产生的记录合成一批**。`setImmediate` 只做到第一个——一次导入
 * 是「写一条 → await → 写一条」，每次 `await` 都会让出事件循环，`setImmediate` 的
 * 回调在两次写之间就跑掉了，队列里永远只有一条，「按 `maxBatchSize` 分批」退化成
 * 「每条一次请求」。
 *
 * **批量收益的主要来源不是窗口，是 `observer.ts` 里「攒满一批立刻发」那一条。** 窗口只
 * 负责两件事：把并发写入（`Promise.all` 批量提交）攒成一批，以及在导入的尾巴上把
 * 不满一批的余数送出去。窗口调大能让余数等得更久，但**不会**让稳态的请求数更优——
 * 稳态由「攒满即发」决定。
 *
 * 50 毫秒的来源：本机一次写入（`writeText` + 索引 upsert + 物化权限）实测约
 * 12 毫秒（`local/bench/embedding-stage.ts` 的缓存重跑：64 条 788 毫秒），
 * 50 毫秒覆盖约 4 条并发写入的突发。再大只会让「空闲之后的第一条」多等，而嵌入
 * 本来就在写操作的异步阶段（§17.2），不在用户的阻塞路径上。`drain()` 会**提前**
 * 触发它，所以测试与 `close()` 不必等满 50 毫秒。
 */

import type { EmbeddingRow } from '../../adapters/sqlite/embedding-repository.js';

import type { IndexObserverDeps } from './ports.js';

export type EmbeddingPorts = Pick<IndexObserverDeps, 'embedding' | 'embeddings' | 'logger'>;

/**
 * 队列里的一条待嵌入记录。
 *
 * `digest` 是 `stableDigest(text)`，进队列时就算好：它既用来「正文没变就跳过」，
 * 也用来把「同一段正文挂在两个 URI 下」合并成一个供应商输入。
 */
export interface PendingEmbedding {
  readonly uri: string;
  readonly text: string;
  readonly digest: string;
}

/** 同一份正文对应的所有 URI（一次嵌入写回多行）。 */
interface EmbeddingGroup {
  readonly text: string;
  readonly uris: readonly string[];
}

/** 一批里实际涉及多少个节点（去重后的输入数不等于 URI 数）。 */
function countUris(entries: readonly (readonly [string, EmbeddingGroup])[]): number {
  let total = 0;
  for (const [, group] of entries) {
    total += group.uris.length;
  }
  return total;
}

/**
 * 把一批记录按 `maxBatchSize` 切片交给供应商。
 *
 * 两步去重，各解决一件事：
 *
 * 1. **按 URI 去重**：`node_embedding` 里已经是同一个 `(model, contentDigest)`
 *    的节点不用重嵌——重复写同一份正文不该重复调模型。
 * 2. **按 digest 去重**：同一段正文挂在两个 URI 下时只占一个输入位，结果写回
 *    两行。这是「两个 URI 共享正文」从「嵌两次」变成「嵌一次」的地方。
 *
 * 去重之后才切片：切的是**供应商真正要看的输入数**，不是记录数。
 */
export async function embedRecords(
  ports: EmbeddingPorts,
  records: readonly PendingEmbedding[],
): Promise<void> {
  const embedding = ports.embedding;
  const embeddings = ports.embeddings;
  const model = embedding?.model;
  if (embedding === undefined || embeddings === undefined || model === null || model === undefined) {
    return;
  }

  const existing = new Map(
    embeddings.getMany(records.map((record) => record.uri)).map((row) => [row.uri, row]),
  );
  const groups = new Map<string, { text: string; uris: string[] }>();
  for (const record of records) {
    const row = existing.get(record.uri);
    if (row !== undefined && row.model === model && row.contentDigest === record.digest) {
      continue;
    }
    const group = groups.get(record.digest);
    if (group === undefined) {
      groups.set(record.digest, { text: record.text, uris: [record.uri] });
    } else {
      group.uris.push(record.uri);
    }
  }

  const entries = [...groups.entries()];
  const batchSize = embedding.maxBatchSize;
  for (let start = 0; start < entries.length; start += batchSize) {
    await embedChunk(ports, entries.slice(start, start + batchSize), model);
  }
}

/**
 * 一次供应商调用。**失败隔离**在这里。
 *
 * 顺序靠 `ports.embedding.embed` 的契约保证：`vectors[i]` 与 `texts[i]` 一一对应
 * （供应商返回的 `data[].index` 由 `adapters/llm/embedding-provider.ts` 的
 * `embedMany` 按 `index` 排好，不假设响应数组顺序）。所以这里按下标写回，
 * 不需要在服务层再对一次。
 *
 * 失败隔离分两种：
 *
 * - **整批降级**（供应商挂了、限流、超时）：这一批的记录跳过，记一条 warn。
 *   其它批不受影响，这与批量之前「一条失败只影响它自己」的语义在**批**这一级
 *   上一致。
 * - **单条坏输入**（超长、非法字符，供应商回 400）：不能让它把同批 64 条一起
 *   丢掉。降级时**二分重试**，把失败收敛到那条记录自己；剩下的一半照常写入。
 *
 * 二分不会放大请求数：供应商整体不可用时 `embedding.available` 会转成 `false`
 * （熔断打开且仍在冷却），下面的前置判断让整棵子树直接跳过，不打网络。所以
 * 「供应商挂了」最多打出 `FAILURE_THRESHOLD` 次（5 次）真实请求，而不是
 * `2N - 1` 次。
 */
async function embedChunk(
  ports: EmbeddingPorts,
  entries: readonly (readonly [string, EmbeddingGroup])[],
  model: string,
): Promise<void> {
  const embedding = ports.embedding;
  const embeddings = ports.embeddings;
  if (embedding === undefined || embeddings === undefined || entries.length === 0) {
    return;
  }

  if (!embedding.available) {
    ports.logger.warn('嵌入不可用，跳过本批记录', {
      records: countUris(entries),
      reason: '熔断打开或未配置供应商。',
    });
    return;
  }

  const outcome = await embedding.embed(entries.map(([, group]) => group.text));
  if (!outcome.degraded) {
    const rows: EmbeddingRow[] = [];
    for (const [offset, entry] of entries.entries()) {
      const [digest, group] = entry;
      const vector = outcome.vectors[offset];
      if (vector === undefined) {
        continue;
      }
      for (const uri of group.uris) {
        rows.push({ uri, model, contentDigest: digest, vector });
      }
    }
    if (rows.length > 0) {
      embeddings.upsert(rows);
      ports.logger.debug('嵌入写入', { records: rows.length });
    }
    return;
  }

  // 一条坏输入不能拖掉整批：二分重试，让失败收敛到它自己。
  if (entries.length > 1) {
    const middle = Math.ceil(entries.length / 2);
    await embedChunk(ports, entries.slice(0, middle), model);
    await embedChunk(ports, entries.slice(middle), model);
    return;
  }

  const only = entries[0];
  ports.logger.warn('嵌入降级，跳过写入', {
    uris: only?.[1].uris ?? [],
    reason: outcome.reason ?? '没有返回向量。',
  });
}
