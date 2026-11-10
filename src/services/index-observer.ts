/**
 * 节点写入后的索引维护（Observer 模式，架构文档 §9.3、§12.3）。
 *
 * 实现按职责拆在同目录的 `observer/` 下：
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `observer.ts` | `IndexObserver` 类：事件分发与编排 |
 * | `write.ts` | 写盘后的索引行 upsert / 删除 / 移动后的批量写回 |
 * | `events.ts` | 删除与移动后的派生数据重建（索引、权限、向量） |
 * | `record.ts` | 从磁盘构造节点自身那一行 `IndexRecord` |
 * | `frontmatter.ts` | `memory_type` / `status` / `valid_*` 的解析 |
 * | `summary.ts` | 摘要失效排期（`markStale`，延后到锁释放后） |
 * | `permissions.ts` | 权限物化（单节点与祖先链） |
 * | `replay.ts` | reconcile 日志的追加（失败 → 日志 + 对账记录） |
 * | `embedding.ts` | 嵌入批次去重与供应商调用 |
 * | `ports.ts` | 对外依赖契约 `IndexObserverDeps` 与错误消息格式化 |
 *
 * 这个文件只保留对外符号，`import ... from './index-observer.js'` 的调用方一行不改。
 */

export { IndexObserver } from './observer/observer.js';
export type { IndexObserverDeps } from './observer/ports.js';
export { parseFrontmatterFields } from './observer/frontmatter.js';
export type { FrontmatterFields } from './observer/frontmatter.js';
