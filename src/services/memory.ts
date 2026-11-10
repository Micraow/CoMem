/**
 * 记忆服务的门面（架构文档 §6.6、§11.1、§11.3、§11.6、§11.11）。
 *
 * 实现在 `services/memory/` 下按职责分开，对外的符号与签名保持不变，调用方的
 * import 路径（`services/memory.js`）不动：
 *
 * - `document.ts`：frontmatter ↔ 结构、保留键、正文边界、identity → URI 渲染
 * - `errors.ts`：`INVALID_ARGUMENT` 的唯一构造
 * - `yaml.ts`：记忆文件用到的 YAML 子集（标量与块序列的读写）
 * - `versioning.ts`：版本快照、`MAX_VERSIONS` 截断、`supersedes` 回退
 * - `review.ts`：复核通过 / 拒绝的判定与写回
 * - `query.ts`：`read` 的投影、待复核列表、抽取预取
 * - `ports.ts`：端口定义与文件级原语（读原样文档、列目录）
 * - `service.ts`：`MemoryService` 的编排与对外方法
 *
 * 这个文件只做 re-export：改实现不要加在这里，读代码从 `service.ts` 进。
 */

export type { MemoryStatus } from './memory/document.js';
export type { MemoryRecord } from './memory/query.js';
export type {
  MemoryWriteResult,
  MemoryFields,
  MemoryUpdate,
  MemoryUpdateInput,
  MemoryWrite,
} from './memory/service.js';
export type { MemoryRejectResult } from './memory/review.js';
export type { MemoryServicePorts } from './memory/ports.js';
export { appendSources, renderMemoryUri, assertMemoryIdentity } from './memory/document.js';
export { MemoryService } from './memory/service.js';
