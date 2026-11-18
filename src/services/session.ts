/**
 * 会话服务的门面（架构文档 §10）。
 *
 * 实现在 `services/session/`；这里只做 re-export，对外导出面与 import 路径不变。
 * 两阶段与归档边界的说明见 `services/session/archive.ts` 文件头。
 */

export type { ArchiveTaskPayload } from '../domain/archive.js';
export type { SessionMeta } from '../domain/session.js';
export { stableMessageId } from './session/messages.js';
export type {
  CommitPhase1Result,
  SessionRemoval,
  SessionServiceOptions,
} from './session/ports.js';
export { SessionService } from './session/service.js';
