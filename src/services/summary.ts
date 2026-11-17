/**
 * 摘要服务：生成与失效（架构文档 §9.1–§9.3、§7）。
 *
 * 三层摘要里 L0 / L1 是**目录级**的：目录的 `.abstract.md` / `.overview.md` 由这一层
 * 生成，目录的正文就是它的 L0 摘要（`Directory.digest()`）。文件级摘要跟着文件自己的
 * frontmatter 走（§6.7），由 `ContentStore` 维护，本服务只在生成父目录 L1 时把索引里的
 * `abstract` 读出来（§9.1「文件摘要存在索引记录的 abstract 字段里，作为生成父目录 L1
 * 的输入」）。
 *
 * ## 生成（§9.2）
 *
 * 自底向上：叶子目录 → 父目录 → … → `rootUri`。一个目录的 L1 输入是「直接子文件的
 * 摘要」+「直接子目录的 L0 正文」。**L0 从 L1 提取**（`extractAbstract`），不让模型
 * 分别生成两层——两层各写一遍必然互相矛盾。
 *
 * `SummaryGenerator` 是 Strategy：`LlmSummarizer` 调模型，`RuleSummarizer` 断网降级，
 * 由装配方按 `summary.generator` 配置选择（§18）。降级不是静默的：`degraded` 写进
 * `.abstract.md` / `.overview.md` 的 frontmatter，控制台的「监控」页与 `health` 工具
 * 读它（§9.2、§17.9）。
 *
 * ## 失效（§9.3）
 *
 * 只增量失效，不全量重算。写节点 N 之后：算 N 的正文 digest，与索引里记录的
 * `body_digest` 比较——**一致就到此为止**，正文没变不传播。变化了才给
 * `P = parent(N)` 的计数器加一，再按四个条件判定「立刻重算」还是「只记脏」。
 * 重算 P 之后如果 P 的 L0 也变了，对 `parent(P)` 重复。到达 scope 根停止。
 *
 * 「事件计数」而不是「脏标记」：同一个文件反复改，脏标记只算一次，永远到不了阈值。
 * 消费时**减**而不是清零：生成期间可能又有新改动进来（`consumeFreshness`）。
 *
 * 判定与传播在 `summary/invalidate.ts`；观察者对摘要失效只做投递
 * （`services/observer/summary.ts`），两处分工不要合并。
 *
 * ## 写盘顺序与崩溃恢复
 *
 * 先写摘要文件（真相），再在一个事务里写索引行与新鲜度列（缓存）。理由与 §7 一致：
 * 索引永远能从文件重建，反过来不成立。窗口期（文件 rename 成功、事务提交之前进程
 * 挂掉）的后果是 `summary_baseline` 落后于摘要文件：该目录会被判定为「摘要基于旧
 * 正文」，下一次 `invalidate` / `regenerate` 重算即可修复，不丢数据。细节见
 * `summary/persist.ts` 文件头。
 *
 * ## 并发
 *
 * 每个目录一把 `EXACT` 锁（`PathLockManager`）：`rm -r` 拿的是 `TREE` 锁，两边
 * 互斥，否则后台写摘要与递归删除会同时改同一个目录。`locks` 省略时不加锁
 * （纯内存测试、单进程一次性重建）；**生产装配必须传**，否则这条互斥不成立。
 *
 * **锁内不得跨越慢操作**（§10.6）：`generator.generate` 是一次 7–9 秒的模型调用，
 * 不能放在 `EXACT` 锁里，否则锁持有时间放大 1000 倍，并发的 `tree` 锁会在 5 秒后
 * `CONFLICT`（W83 实测）。所以 `summary/invalidate.ts` 的 `invalidateDirectory` 拆成
 * 「锁内判定 → 锁外生成 → 锁内写回」三段，中间只留下「摘要可能比内容旧一拍」这一
 * 可接受竞态（见该函数注释）。
 *
 * 实现按职责放在 `services/summary/` 下；对外导出面与 import 路径不变。
 * 写盘顺序与事务端口见 `summary/persist.ts` 文件头，失效判定见 `summary/invalidate.ts`。
 */

export type {
  InvalidationResult,
  SummaryDatabase,
  SummaryServiceConfig,
  SummaryServiceDeps,
} from './summary/ports.js';
export type { SummarizerOptions } from './summary/generators.js';
export { LlmSummarizer, RuleSummarizer } from './summary/generators.js';
export { SummaryService } from './summary/service.js';
