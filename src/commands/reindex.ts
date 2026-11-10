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
 * 重建**检索索引**（`node` / `node_fts`）、**向量**（`node_embedding`）与**记忆关联边**
 * （`memory_link` 的 `derived_from` 部分，从每份记忆文件的 `sources` 重算，§11.10）。
 * 物化权限（`node_permission`）不在这里重算：它由 `.acl.json` 与所有者推导，
 * 归属 `AclService` 的写路径（§8.2「写时算，读时查」）。索引损坏（表被删、写坏）
 * 而权限表完好是常态；整库丢失时权限要另走 ACL 重建，不在本命令的职责里。
 *
 * ## 输出约定
 *
 * 进度写 stderr（`ConsoleLogger` 与 `progress()` 都走 stderr），stdout 只留最终
 * 一行「成功了」。这样 `reindex > report.json` 拿到的是一份干净结果，而不是几万
 * 行进度。
 *
 * ## 模块划分
 *
 * 本文件只是门面：`reindex/command.ts` 编排，`walk.ts` 磁盘遍历，`records.ts`
 * frontmatter → 索引记录，`context.ts` 装配与向量表，`vectors.ts` 回填循环，
 * `missing-vectors.ts` 缺向量判定，`derived.ts` / `edge-key.ts` 关联边，
 * `report.ts` 输出，`options.ts` 契约与参数解析。
 */

import { pathToFileURL } from 'node:url';

import { runReindex } from './reindex/command.js';
import { parseArgs } from './reindex/options.js';
import { errorMessage } from '../domain/errors.js';

import { formatReindexSummary } from './reindex/report.js';

export type { ReindexOptions, ReindexResult } from './reindex/options.js';
export type {
  EmbedMissingNodesDeps,
  EmbedMissingNodesProgress,
  EmbedMissingNodesResult,
} from './reindex/vectors.js';
export { derivedEdgeKey } from './reindex/edge-key.js';
export { documentsMissingVectors, hasDocumentsMissingVectors } from './reindex/missing-vectors.js';
export { embedMissingNodes } from './reindex/vectors.js';
export { runReindex };

/** 只有直接执行（`tsx src/commands/reindex.ts`）时才跑 CLI 入口，测试 import 不触发。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  runReindex({ ...parseArgs(argv), argv }).then(
    (result) => {
      process.stdout.write(formatReindexSummary(result));
    },
    (error: unknown) => {
      process.stderr.write(`reindex 失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
