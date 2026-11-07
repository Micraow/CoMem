/**
 * 结构化日志接口（架构文档 §17.8）。
 *
 * 日志每行一个 JSON，`requestId` 贯穿到后台任务与模型调用。实现放在
 * `adapters/log/`：`ConsoleLogger` / `FileLogger` 走生产，`NullLogger` 给测试。
 */

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 派生一个带固定字段的子 logger，例如 `child({ requestId })`。不改变父 logger。 */
  child(bindings: LogFields): Logger;
}
