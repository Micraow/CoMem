/**
 * 目录在 `node.level` 上的两个取值（§8.1、§8.5）。
 *
 * 同一个目录在索引里有两行：L0 行（一句话摘要）与 L1 行（`overviewMaxChars` 的概览
 * 正文）。两行的文本长度与信噪比不同，`bm25 × levelWeight` 才有意义——在此之前
 * `levelWeights.l1` 没有任何行可乘（§8.5）。
 *
 * 新鲜度三列只在 L0 行上有意义（`0004_node_level_rows.sql`），所以
 * `freshness.ts` 的 `FRESHNESS_ROW_SQL` 也从这里取 `DIRECTORY_LEVEL`：两处同时
 * 引用同一个常量，改层级不会留下一条只改了一半的 `WHERE`。
 */

/** 目录自身那一行在 `node.level` 上存的值：目录的可检索正文是它的 L0 摘要。 */
export const DIRECTORY_LEVEL = 'L0';

/** 目录概览行在 `node.level` 上存的值（§8.5）。 */
export const OVERVIEW_LEVEL = 'L1';
