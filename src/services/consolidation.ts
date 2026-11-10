/**
 * 记忆合并（架构文档 §11.8）。
 *
 * ## 为什么是 agentic 循环
 *
 * 合并要判断「两条记忆里是不是有一条已经被取代」。这个判断需要**读正文**：
 * 摘要只说明「这条讲什么」，说明不了「这条与那条哪条仍然有效」。相似度阈值在这里
 * 没有用——两条互相矛盾的约定同样相似，按阈值合并只会得到「都留下」或「不分青红
 * 地删一条」。
 *
 * 所以决策交给模型，但模型不是一次输出：它先看清单、再按需读正文、最后给操作。
 * 这是一次**有界**的探索。
 *
 * ## 为什么用多轮 `completeJson` 而不是 function calling
 *
 * `LlmProvider` 只有 `complete` / `completeJson`（§4.4），没有 tool calling。
 * 每一轮的输出是一个 JSON 对象：`{"action": "read", "uris": [...]}` 表示「再给我
 * 这些文件的正文」，`{"action": "finish", "operations": [...]}` 表示结束。这等价于
 * 两个工具（`read` / `finish`），且不需要供应商支持函数调用。
 *
 * ## 轮次上限
 *
 * 默认 10 轮（`DEFAULT_MAX_ITERATIONS`，来源见常量注释）。到上限还没 `finish` 就
 * 抛 `RESOURCE_EXHAUSTED`，**不做部分应用**：一个只合并了一半的记忆库比没合并更难
 * 解释。
 *
 * ## 破坏性与隔离
 *
 * `delete` 是删除操作，所以：
 *
 * - 调用方必须先确认（HTTP 端点的 `dryRun` 默认 `true`，见路由）；
 * - 只允许操作显式给出的 scope 下的记忆——**不展开组**：`comem://group/eng/` 的
 *   记忆不会因为调用者有 `group:eng` 就被合并。合并是写操作，scope 必须显式指定
 *   （`validateOperations` 的 `allowedScopes` 保证）；
 * - 清单与正文的读取用**调用方自己的 principals**（`consolidate` 的 `subject` /
 *   `principals`）：用 scope 根主体的身份去读会把 `restricted` 切断的节点也读出来，
 *   然后删掉一条调用方本来无权看到的记忆。
 *
 * ## 回滚语义
 *
 * `MemoryService` 没有事务（它是「一个文件一条记忆」），`filesystem` 端口也拿不回
 * 逐字节的前像（`created_at`、`status` 都会在重写时被重新计算）。所以这里**不做
 * 假回滚**：写盘前的全部校验（URI 合法、类型可还原、identity 与路径一致、
 * `addOnly` 类型不能 update、被删记录的 `sources` 全是合法 URI、写回字段的类型与
 * identity 齐备）都在任何写入之前完成，把「中途失败」压到只剩 I/O 与加锁失败；
 * 真的中途失败时，错误 `details` 里带上已经应用过的 `adds` / `updates` /
 * `deletes`，由运维按这份清单收尾。
 *
 * 其中字段类型与 identity 的校验和 `upsertMemory` 锁内那份是**同一实现**
 * （`domain/memory-type.ts`）：锁内那次不能省，它挡的是「计划与写入之间文件被别的
 * 写者改过」；这里这次挡的是「删除已应用、写回才失败」。解析结果也一样——被删
 * 记录的 `sources` 在这里解析成 `Uri`，写盘阶段直接用，不解析第二遍。
 *
 * ## 并发
 *
 * 锁在 `MemoryService` 里，一条记忆一把 `exact` 锁（§18「并发控制」）。这里**不再
 * 自己持锁**：`PathLockManager` 不可重入，外层再拿一把同 URI 的锁会等自己，5 秒后
 * 抛 `CONFLICT`；而外层的锁本来也盖不住读——`plan.ts` 的正文读取发生在它之前。
 *
 * 代价是「锁拿不到时整批不应用」不再成立：中途 `CONFLICT` 时前面几条已经写盘。
 * 这与其它写盘失败同一条出口——错误 `details` 里带上已应用的清单，由运维收尾。
 *
 * 写盘按 URI 升序**执行**（不是为了加锁）：`adds` / `updates` / `deletes` 的
 * 顺序因此是确定的，报告与日志可以直接比对。
 */

/**
 * 实现按职责拆在 `services/consolidation/`：
 *
 * - `service.ts`：`ConsolidationService` 的编排与有界探索循环
 * - `inventory.ts`：合并候选的枚举与清单条目（URI + 类型 + 摘要，不带正文）
 * - `prompt.ts`：清单 / 已读正文 / 轮次拼成一轮的提示词
 * - `output.ts`：模型输出的结构校验、归一化与意图摘要
 * - `plan.ts`：操作 → 写盘计划（类型还原、identity 与路径一致、来源校验）
 * - `apply.ts`：预览与按 URI 升序写盘（add / update / delete）
 * - `types.ts`：依赖、选项、结果、端口与写盘计划的类型
 *
 * 这个文件只做 re-export：改实现不要加在这里，读代码从 `service.ts` 进。导出面与
 * 拆分前逐字相同，调用方的 import 路径（`services/consolidation.js`）不动。
 */

export type {
  ConsolidateOptions,
  ConsolidationResult,
  ConsolidationServiceDeps,
  ConsolidationTraceEntry,
} from './consolidation/types.js';
export { ConsolidationService } from './consolidation/service.js';
