/**
 * 结构化日志接口（架构文档 §17.8）。
 *
 * 日志每行一个 JSON，`requestId` 贯穿到后台任务与模型调用。实现放在
 * `adapters/log/`：`ConsoleLogger` / `FileLogger` 走生产，`NullLogger` 在 `tests/helpers/`。
 */

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * 等已排队的日志写入落盘（优雅退出用）。
   *
   * **可选**：`ConsoleLogger` 同步写、`NullLogger` 丢弃，都不需要无意义的空实现；
   * 带写队列的实现（`FileLogger`）提供它。关闭序列统一调 `logger.flush?.()`。
   */
  flush?(): Promise<void>;
}
