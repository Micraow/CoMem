/**
 * 「哪些节点缺向量」的判定：一份 SQL 谓词 + 两个查询。
 *
 * 启动提醒（`bootstrap/main.ts` 的 `warnIfVectorsMissing`）、启动回填的候选集
 * （`bootstrap/main.ts` 的 `backfillMissingVectors`）与 `reindex` 共用这一份口径。
 */

import type { DatabaseSync } from 'node:sqlite';

import { stableDigest } from '../../domain/node.js';

/**
 * 「这个节点缺向量」的 SQL 谓词，**唯一一处**。
 *
 * 别名约定：`node` 表是 `n`，`node_embedding` 表是 `e`；绑定参数依次是
 * 「空正文的摘要」与「当前模型」。两处生产调用方（启动提醒、启动回填的候选集）必须拼
 * 同一份子句——分两处写，迟早分叉成「启动说没缺、回填还在干活」或者「启动永远在报、
 * 回填却无事可做」。
 *
 * 三条子句各挡一类行：
 * - `kind = 'document'`：目录行（含 L1 概览行，它的 `body_digest` 非空）不参与语义检索；
 * - `body_digest <> 空正文摘要`：空文件没有可嵌的正文，嵌了也搜不出东西；
 * - `NOT EXISTS`：同 `model` 且同摘要的向量已经存在，说明这一条是最新的。
 *
 * **基准是索引里的 `node.body_digest`，不是磁盘正文。** 这是有意的：这条判定要能
 * 在启动时一次 SQL 扫完（1 万行实测约 90 毫秒），读盘做不了。索引落后于磁盘时它
 * 会漏报（`tests/integration/sqlite/embedding-freshness-consistency.test.ts` 记着
 * 这个边界），修索引是 `pnpm reindex --only=index` 的职责。
 */
const MISSING_VECTOR_WHERE = `n.kind = 'document'
          AND n.body_digest <> ?
          AND NOT EXISTS (
            SELECT 1 FROM node_embedding e
             WHERE e.uri = n.uri AND e.model = ? AND e.content_digest = n.body_digest
          )`;

/**
 * 「库里有记忆但没有向量」的存在性判断（`LIMIT 1`）。
 *
 * 启动提醒（`bootstrap/main.ts` 的 `warnIfVectorsMissing`）用它，与启动回填的候选集
 * （`documentsMissingVectors`）共用 `MISSING_VECTOR_WHERE`。
 *
 * 只回答有没有，不回答多少条：条数是 `runReindex` 输出里的「补齐向量 N 条」。
 * 有缺失时第一条就返回；没有缺失时最坏扫一遍 `node`。
 */
export function hasDocumentsMissingVectors(db: DatabaseSync, model: string): boolean {
  const missing = db
    .prepare(`SELECT 1 AS missing FROM node n WHERE ${MISSING_VECTOR_WHERE} LIMIT 1`)
    .get(stableDigest(''), model);
  return missing !== undefined;
}

/**
 * 缺向量的文档 URI，按 URI 升序（`reindex` 的断点续跑顺序）。
 *
 * 启动回填（`bootstrap/main.ts` 的 `backfillMissingVectors`）用它拿候选集。它不读盘，
 * 所以只认 `node` 行——磁盘上有文件而索引里没有行的节点不在这里，那是对账 / 重建
 * 索引的职责（`reindex --only=index`）。
 */
export function documentsMissingVectors(db: DatabaseSync, model: string): readonly string[] {
  const rows = db
    .prepare(`SELECT n.uri AS uri FROM node n WHERE ${MISSING_VECTOR_WHERE} ORDER BY n.uri`)
    .all(stableDigest(''), model);
  return rows.map((row) => String(row['uri']));
}
