/**
 * 本机 Agent 对话导入的领域形状（架构文档 §11.9）。
 *
 * 这里只有数据形状，没有 IO。游标与「幂等」的语义在 `services/ingest.ts`，
 * 各宿主的日志格式在 `src/ingest/sources/`。
 *
 * ## 为什么游标是领域概念
 *
 * 源日志是**追加式**的：今天导了一半，明天又多了 500 条。游标记住「读到哪」，
 * 导入才能既幂等又可续跑。它属于「怎么描述一次导入」，不属于某个适配器。
 */

/** 支持导入的宿主。新增一个宿主 = 新增一个 `LogSource` 实现 + 一个联合成员。 */
export type IngestHarness = 'claude-code' | 'codex' | 'deepseek' | 'qwen';

/**
 * 游标类型。
 *
 * - `byte_offset`：追加式 JSONL 的字节偏移。值是「最后消费完的那一行结束之后」的
 *   字节位置，从 0 开始。
 * - `tree_node`：树形导出（DeepSeek / Qwen 的 `mapping` / `history`）里最后消费
 *   完的节点 ID。空串表示「还没读过任何节点」。
 */
export type CursorKind = 'byte_offset' | 'tree_node';

/** 一条 harness 无关的对话轮。 */
export interface NormalizedMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** 消息在源日志里的时间。ISO-8601；解析不出来就是 null */
  readonly createdAt: string | null;
  /** 模型标识（assistant 轮才有） */
  readonly model: string | null;
  /** 工作目录（Claude Code / Codex 有） */
  readonly cwd: string | null;
}

/** 源日志里可发现的一个会话。 */
export interface SessionRef {
  readonly harness: IngestHarness;
  /** 源系统里的原生会话 ID。**幂等键** */
  readonly nativeSessionId: string;
  /** 源文件路径（用于报告与排查） */
  readonly locator: string;
  /** 会话标题（源系统给的，可能没有） */
  readonly title: string | null;
  /** 首条消息时间，用于排序与文件名 */
  readonly startedAt: string | null;
}

export interface IngestCursor {
  readonly kind: CursorKind;
  readonly value: string;
}
