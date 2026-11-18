/**
 * 记忆服务的门面（架构文档 §11）。
 *
 * 实现在 `services/memory/`；这里只做 re-export，对外导出面与 import 路径不变。
 * 改实现不要加在这里，读代码从 `services/memory/service.ts` 进。
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
export type { MemoryApprovalEdit, MemoryRejectResult } from './memory/review.js';
export type { MemoryServicePorts } from './memory/ports.js';
export { listCurrentMemories } from './memory/query.js';
export { appendSources, renderMemoryUri, assertMemoryIdentity } from './memory/document.js';
export { MemoryService } from './memory/service.js';
