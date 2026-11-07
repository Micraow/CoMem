/**
 * 标准输出日志（架构文档 §17.8 结构化日志）。
 *
 * 每行一个 JSON 对象，`jq` 能直接解析：
 *
 * ```text
 * {"service":"comem","requestId":"req_abc","level":"error","time":"2026-11-07T22:00:00.000Z","msg":"模型返回 503"}
 * ```
 *
 * 三个约定：
 *
 * 1. **固定键在前、保留键在后**：`level` / `time` / `msg` 是日志行的骨架，调用方
 *    传同名字段时以骨架为准——一行日志的级别与时间不能由业务字段改写。
 * 2. **级别过滤不做序列化**（§17.8）。`JSON.stringify` 是热路径的主要成本，级别
 *    不够时连字段合并都不做。测试用 `vi.spyOn(JSON, 'stringify')` 断言这一点。
 * 3. **`child` 合并而不是覆盖**：`parent.child({a}).child({b})` 得到
 *    `{...parentBindings, a, b}`，父 logger 自身不变（§17.7 的 `requestId` 就是这样
 *    一路带到底的）。
 *
 * `level` 是 `config.logging.level` 的全集：配置里允许 `fatal`（§18），而 `Logger`
 * 接口没有 `fatal` 方法，所以设成 `fatal` 时一条也不输出——这是「级别更高」的直接
 * 推论，不是特例。
 */

import type { LogFields, Logger } from '../../domain/log.js';

/** 日志级别，与架构文档 §18 的 `logging.level` 一致。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * 级别排序值。只用于比较，不写进日志——日志里的 `level` 是字面量。
 * 间隔 10 是经验值，来源未知：取相邻整数也等价，留出间隔只是为了让「以后插一个
 * 级别」不用改所有数字。
 */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

export interface ConsoleLoggerOptions {
  readonly level: LogLevel;
  /** 输出目标；默认 `process.stdout`。测试注入 */
  readonly write?: (line: string) => void;
  /** 固定字段，每条日志都带上（如 service 名） */
  readonly bindings?: LogFields;
  /** 时钟；默认 `() => new Date()` */
  readonly now?: () => Date;
}

function defaultWrite(line: string): void {
  process.stdout.write(line);
}

export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #threshold: number;
  readonly #write: (line: string) => void;
  readonly #bindings: LogFields;
  readonly #now: () => Date;

  constructor(options: ConsoleLoggerOptions) {
    this.#level = options.level;
    this.#threshold = LEVEL_RANK[options.level];
    this.#write = options.write ?? defaultWrite;
    this.#bindings = options.bindings ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  trace(message: string, fields?: LogFields): void {
    this.#log('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new ConsoleLogger({
      level: this.#level,
      write: this.#write,
      bindings: { ...this.#bindings, ...bindings },
      now: this.#now,
    });
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    // 热路径（§17.8）：级别不够时直接返回，不合并字段、不序列化。
    if (LEVEL_RANK[level] < this.#threshold) {
      return;
    }
    const record = {
      ...this.#bindings,
      ...fields,
      level,
      time: this.#now().toISOString(),
      msg: message,
    };
    this.#write(`${JSON.stringify(record)}\n`);
  }
}
