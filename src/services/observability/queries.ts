/**
 * 健康度与 `/metrics` 共用的只读聚合。
 *
 * 两条读路径都只跑「一条 SELECT + 取 `total`」，放在这里让两边用同一份谓词与同一个
 * 取值口径；写入路径仍然走仓储（写要事务与列映射，读不要，见 `../observability.ts`
 * 文件头第 5 节）。
 */

import type { ObservabilityDatabase } from './contracts.js';

/**
 * 「节点自身那一行」的谓词，与 `adapters/sqlite/node-repository.ts` 的
 * `nodeSelfRowSql()` 是同一个不变量：目录的 L1 概览行是附加检索行，不是独立节点。
 *
 * 不复用那个函数：`services/` 只能 `import type` 引用适配层（§4.2），而这个文件
 * 本来就直接对 `node` 表写 SQL（读端口是 `ObservabilityDatabase`）。两处的含义由
 * `0004_node_level_rows.sql` 与 `SummaryService.#persistSummary` 共同约束。
 *
 * 导出是给一致性测试用的（`tests/integration/sqlite/node-self-row-consistency.test.ts`）：
 * 两份谓词必须对同一批 `kind × level` 行判定相同，否则 `health()` / `/metrics` 的
 * 节点数会把目录的 L1 概览行算进去。导出常量不改变运行期语义。
 */
export const NODE_SELF_ROW = "NOT (kind = 'directory' AND level = 'L1')";

/** 单行聚合查询。列名固定 `total`，与 `node-repository` / `task-repository` 一致。 */
export function countRows(
  db: ObservabilityDatabase,
  sql: string,
  ...params: readonly unknown[]
): number {
  const row = db.prepare(sql).get(...params);
  const total = row?.['total'];
  return typeof total === 'number' ? total : 0;
}
