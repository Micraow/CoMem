/**
 * 日志适配器入口（架构文档 §17.8）。
 *
 * 三个实现各有用途：`ConsoleLogger` 走生产（JSON Lines 到 stdout），`FileLogger`
 * 装饰前者、额外落 `error.log`，`NullLogger` 给不需要断言日志的测试。
 * `services/` 只依赖 `domain/log.ts` 的 `Logger` 接口，由 `bootstrap/` 决定用哪个。
 */

export { ConsoleLogger, type ConsoleLoggerOptions, type LogLevel } from './console.js';
export { FileLogger, type FileLoggerOptions } from './file.js';
export { NullLogger } from './null.js';
