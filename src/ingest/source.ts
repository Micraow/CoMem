/**
 * 导入源的公共接口与 JSONL 基类（架构文档 §11.9）。
 *
 * ## 为什么是「游标 + 幂等 + 可续跑」
 *
 * 用户的日志是追加式的。今天导了一半，明天又多了 500 条；没有游标就只能全量重导，
 * 而重导会产生重复会话。`readMessages` 从游标之后读，返回新的游标，调用方确认
 * 消息落盘之后再写回游标——「只在服务端确认后前进」。
 *
 * ## 为什么逐行流式读
 *
 * 真实语料里最大的 rollout 文件 64MB。`readFileSync` 会把它整个读进内存，再按行
 * 切一遍字符串（峰值 128MB 以上），而导入是「一次处理一个会话」的后台动作，没有
 * 任何一步需要全文件。`readLines` 按块解码、只保留未完成的一行。
 *
 * 不用 `readline` 的原因：游标是**字节**偏移，而 `readline` 交出的是去掉行尾的
 * 字符串。用 `\n` 切分 Buffer 能同时拿到行内容与精确的字节边界（`\r\n` 也不会
 * 让偏移漂一格）。
 *
 * ## 坏行不中断
 *
 * 一行坏 JSON 不该让 908 个会话都导不进来。基类跳过并计数（`skippedLines`），
 * 由调用方写进日志；会话层面的失败才进报告。
 */

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ComemError } from '../domain/errors.js';
import type {
  CursorKind,
  IngestCursor,
  IngestHarness,
  NormalizedMessage,
  SessionRef,
} from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';

export interface ReadMessagesResult {
  readonly messages: readonly NormalizedMessage[];
  readonly cursor: IngestCursor;
}

/** 发现阶段跳过的文件（损坏、不可读）。由编排层收进 `report.errors`。 */
export interface SourceFileError {
  readonly locator: string;
  readonly message: string;
}

export interface LogSource {
  readonly harness: IngestHarness;
  readonly cursorKind: CursorKind;
  /** 发现会话。**流式**——不要把几百个会话一次读进内存。 */
  discoverSessions(): AsyncIterable<SessionRef>;
  /** 从游标之后读最多 `limit` 条。返回 (消息, 新游标)。 */
  readMessages(
    ref: SessionRef,
    cursor: IngestCursor | null,
    limit: number,
  ): Promise<ReadMessagesResult>;
  /**
   * 发现阶段因为文件损坏而跳过的文件。
   *
   * 整份 JSON 导出（DeepSeek / Qwen）用整体 `JSON.parse`，一个坏文件不该中断同
   * 来源的其它文件。适配器按文件 `catch` 后记到这里，编排层遍历结束后收进报告——
   * 「跳过了哪些文件」必须在报告里可见。
   *
   * JSONL 来源不需要它：坏行由 `JsonlLogSource` 跳过并计数，文件本身不会整体失败。
   */
  readonly fileErrors?: readonly SourceFileError[];
}

/**
 * 脱敏伪影：导出前做过脱敏，数字串被替换成中文字符串 `密码保护`
 * （`"total_tokens":4密码保护811`、`"create_time": 1791275310.6密码保护9`），
 * 整份 JSON 因此不可解析。
 *
 * 实测三份文件（Qwen 导出、ChatGPT 的 `conversations-000.json` 与
 * `library_files.json`）只在这一处损坏。替换成 `0` 后可以完整解析：被抹掉的是
 * 计数与时间戳的高位，会话结构与正文都在。这是修一个**确定的、可逆的**伪影，
 * 不是「猜一个坏文件」。
 */
const DESENSITIZATION_ARTIFACT = '密码保护';
const DESENSITIZATION_REPLACEMENT = '0';

export interface ParsedJsonDocument {
  readonly value: unknown;
  /** 是否走了脱敏修复。调用方记日志，让「数字被改过」可追溯。 */
  readonly repaired: boolean;
}

/**
 * 解析整份 JSON 导出。
 *
 * 直接 `JSON.parse` 失败时先按脱敏伪影修复再试一次；仍然失败就抛带 `locator` 的
 * `INVALID_ARGUMENT`。调用方按**文件**捕获，跳过坏文件并继续同来源的其它文件。
 */
export function parseJsonDocument(raw: string, locator: string): ParsedJsonDocument {
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch (first) {
    const repaired = raw.replaceAll(DESENSITIZATION_ARTIFACT, DESENSITIZATION_REPLACEMENT);
    if (repaired !== raw) {
      try {
        return { value: JSON.parse(repaired), repaired: true };
      } catch {
        // 修复也救不回来：落到下面统一报错，带原始失败原因。
      }
    }
    throw new ComemError('INVALID_ARGUMENT', `导出文件不是合法 JSON：${locator}`, {
      locator,
      reason: errorMessage(first),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

interface Line {
  readonly text: string;
  /** 这一行**结束之后**的字节偏移（含行尾换行符） */
  readonly end: number;
}

/**
 * 从 `start` 起逐行读 UTF-8 文本。
 *
 * 只在内存里保留「还没遇到换行符的那一段」。`end` 是字节偏移，不是字符数：
 * 导入游标跨进程复用，字符数在非 ASCII 文本上与字节数不同。
 */
export async function* readLines(path: string, start: number): AsyncGenerator<Line> {
  const stream = createReadStream(path, { start });
  let buffer = Buffer.alloc(0);
  let offset = start;

  for await (const chunk of stream) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    let newline = buffer.indexOf(NEWLINE);
    while (newline !== -1) {
      const hasCarriageReturn = newline > 0 && buffer[newline - 1] === CARRIAGE_RETURN;
      const contentEnd = hasCarriageReturn ? newline - 1 : newline;
      const text = buffer.subarray(0, contentEnd).toString('utf8');
      const end = offset + newline + 1;
      yield { text, end };
      buffer = buffer.subarray(newline + 1);
      offset = end;
      newline = buffer.indexOf(NEWLINE);
    }
  }

  // 最后一行没有换行符：它的结束位置就是文件尾。
  if (buffer.length > 0) {
    const hasCarriageReturn = buffer[buffer.length - 1] === CARRIAGE_RETURN;
    const content = hasCarriageReturn ? buffer.subarray(0, -1) : buffer;
    yield { text: content.toString('utf8'), end: offset + buffer.length };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 文件系统错误的 `code` 判断（`ENOENT` 等）。各源共用，避免各写一份。 */
function isErrno(error: unknown, code: string): boolean {
  const actual = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return actual === code;
}

/**
 * 递归列出一个根下的文件。根不存在返回空（默认路径在没装过该宿主的机器上不存在，
 * 这不是错误）。
 *
 * 按名字排序，保证同一台机器上重跑的报告顺序一致——导入是幂等的，报告也应该是。
 */
export async function* walkFiles(
  root: string,
  matches: (name: string) => boolean,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path, matches);
    } else if (entry.isFile() && matches(entry.name)) {
      yield path;
    }
  }
}

function parseOffset(cursor: IngestCursor | null, locator: string): number {
  if (cursor === null) {
    return 0;
  }
  if (cursor.kind !== 'byte_offset') {
    throw new ComemError('INVALID_ARGUMENT', `游标类型与源不匹配：${locator}`, {
      locator,
      kind: cursor.kind,
    });
  }
  const offset = Number(cursor.value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ComemError('INTERNAL', `导入游标不是合法的字节偏移：${locator}`, {
      locator,
      value: cursor.value,
    });
  }
  return offset;
}

/**
 * 追加式 JSONL 日志的基类。
 *
 * 子类只负责「一行怎么变成一个 `NormalizedMessage`」与「怎么发现会话文件」；
 * 流式读取、坏行跳过与字节游标都在这里，避免四个适配器各写一份而慢慢漂移。
 */
export abstract class JsonlLogSource implements LogSource {
  abstract readonly harness: IngestHarness;
  readonly cursorKind = 'byte_offset' as const;

  readonly #logger: Logger;
  #skippedLines = 0;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** 已跳过的坏行数。报告里不单列，但日志与测试要靠它证明「跳过」发生过。 */
  get skippedLines(): number {
    return this.#skippedLines;
  }

  abstract discoverSessions(): AsyncIterable<SessionRef>;

  /** 一行 JSON → 一条消息；返回 `null` 表示这一行按规则丢弃（不是错误）。 */
  protected abstract parseLine(
    value: Record<string, unknown>,
    ref: SessionRef,
  ): NormalizedMessage | null;

  async readMessages(
    ref: SessionRef,
    cursor: IngestCursor | null,
    limit: number,
  ): Promise<ReadMessagesResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `每次读取的条数必须是正整数：${limit}`, {
        limit,
      });
    }

    const start = parseOffset(cursor, ref.locator);
    const messages: NormalizedMessage[] = [];
    let position = start;

    for await (const line of readLines(ref.locator, start)) {
      // 空行与只含空白的行仍然算「消费过」：游标必须越过它，否则下一次从同一个
      // 位置开始，永远读不到后面的内容。
      position = line.end;
      if (line.text.trim() === '') {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(line.text);
      } catch {
        this.#skipLine(ref, '不是合法 JSON');
        continue;
      }
      if (!isRecord(value)) {
        this.#skipLine(ref, '不是 JSON 对象');
        continue;
      }

      const message = this.parseLine(value, ref);
      if (message !== null) {
        messages.push(message);
      }
      if (messages.length >= limit) {
        break;
      }
    }

    return {
      messages,
      cursor: { kind: 'byte_offset', value: String(position) },
    };
  }

  #skipLine(ref: SessionRef, reason: string): void {
    this.#skippedLines += 1;
    this.#logger.warn('导入时跳过无法解析的日志行', {
      locator: ref.locator,
      reason,
      skippedLines: this.#skippedLines,
    });
  }
}
