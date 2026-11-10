/**
 * 会话服务的公开入口（架构文档 §10.1 的两阶段、§10.2 的归档边界、§6.5–6.6 的
 * 目录形状）。
 *
 * 实现按职责拆在 `services/session/`：
 *
 * - `service.ts`：`SessionService` 编排与公开 API
 * - `lifecycle.ts`：创建 / 复用 / 空闲归档 / 删除
 * - `append.ts`：追加消息与幂等判据
 * - `archive.ts` / `archive-index.ts`：阶段一六步与归档消息索引
 * - `messages.ts` / `storage.ts`：JSONL 序列化、解析与路径
 * - `hooks.ts`：权限物化与索引观察者通知
 * - `ports.ts`：选项与跨文件端口类型
 *
 * 导出面不变：`stableMessageId`、`SessionService` 与四个类型。调用方的既有
 * import 路径（`services/session.js`）不需要改。
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
