/**
 * 检索服务编排（架构文档 §8.3–§8.8、§12.4）。
 *
 * 四个检索面，各自解决一个访问路径：
 *
 * | 面 | 输入 | 返回 | 走索引 |
 * |---|---|---|---|
 * | `find` | 单条 query | 命中列表（uri / level / abstract / score） | 是（FTS5） |
 * | `search` | query + sessionId | 同上，**先做意图分析得到 0–5 条 TypedQuery** | 是（每条一次） |
 * | `grep` | 正则 + 路径范围 | 行级命中，带行号与前后文 | 否（读文件） |
 * | `glob` | 路径通配 | 文件 URI 列表 | 是（GLOB） |
 * | `context` | 单条 query | 可直接注入模型的文本 | 是 + 组装 |
 *
 * ## 为什么 `grep` 不走索引
 *
 * FTS5 索引的是**词**（而且写进去的是 `segmentCjk` 切分后的文本），`grep` 匹配的是
 * **任意正则**。两者是不同的访问路径：索引没有原文，也没有行号，让它实现 `grep`
 * 等于让索引去读文件。做法是先用 `index.glob` 拿权限过滤后的候选 URI 集合，再逐个
 * `filesystem.read` 做行匹配。
 *
 * 代价是「一个 `.*` 会读穿整个库」，所以候选文件数必须有上限（`GREP_CANDIDATE_LIMIT`）。
 *
 * ## 权限是两遍
 *
 * 索引侧已经在 SQL 里按 `node_permission` 过滤过（§8.2），服务层仍然再过一遍
 * `authorizer.filterReadable` / `glob` 的二次过滤：§12.4 的出口清单是按出口数的，
 * 不是按「索引实现看起来已经做了」。这是纵深防御，不是重复劳动。
 *
 * ## 实现位置
 *
 * 本文件只是对外门面：类与类型按能力拆在 `services/retrieval/`，这里只把原本对外的
 * 符号 re-export 出去，调用方（`api/**`、`bootstrap/container.ts`、测试）的 import
 * 路径不变。
 */

export type { RetrievalSettings } from './retrieval/types.js';
export type { RerankFailureReason } from './retrieval/types.js';
export type { RerankFailure } from './retrieval/types.js';
export type { RerankHealth } from './retrieval/types.js';
export type { SearchServiceDeps } from './retrieval/types.js';
export type { FindOptions } from './retrieval/types.js';
export type { SearchUpstream } from './retrieval/types.js';
export type { SearchOptions } from './retrieval/types.js';
export type { ContextOptions } from './retrieval/types.js';
export type { ScoredHit } from './retrieval/types.js';
export type { RankedScoredHit } from './retrieval/types.js';
export type { ScoredSearchHit } from './retrieval/types.js';
export type { ScoredSearchResult } from './retrieval/types.js';
export type { FindDiagnostics } from './retrieval/types.js';
export type { ContextAssembly } from './retrieval/types.js';
export { SearchService } from './retrieval/service.js';
