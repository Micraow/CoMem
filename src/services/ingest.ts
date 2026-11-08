/**
 * 本机 Agent 对话导入的编排（架构文档 §11.9）。
 *
 * ## 一条会话的流程
 *
 * ```
 * 游标之后读一批 → 建会话（首次）→ 逐条 appendMessages → 写回游标
 *                → 重复直到读完 → commitPhase1（归档 + 建任务）
 * ```
 *
 * **游标只在消息落盘之后前进。** 反过来（先写游标再写消息）时，一次磁盘满或进程
 * 被杀就会永久丢掉那一段——日志还在，但游标越过去了。
 *
 * **每条会话单独提交。** 攒在内存里等到全部会话结束再写，一次失败就全丢；而且
 * 908 个会话的正文不能同时留在堆里。
 *
 * **一条会话失败不影响其它会话。** 单个文件坏掉（格式变化、权限、磁盘）时，其余
 * 会话仍然导入，失败进 `report.errors`。
 *
 * ## 幂等
 *
 * 同一个 `(harness, nativeSessionId)` 跑第二次：游标已经在末尾，`readMessages`
 * 不前进，`skipped + 1`，不建会话、不写消息、不提交。
 *
 * ## `dryRun` 不写
 *
 * `dryRun` 下不调 `SessionService` 的任何方法，也不调游标仓储的 `upsert`。它仍然
 * 读游标与源日志，所以报告里的「新建 / 跳过」是真实判断。游标仓储在 dry-run 时
 * 可以是只读连接，`services/` 不需要知道这一点。
 *
 * ## 溯源
 *
 * `SessionMeta` 是冻结契约（`domain/session.ts`），没有 `source` 字段，且
 * `metadata-file.ts` 读回时会丢弃未知字段。所以「这条会话从哪来」记在
 * `ingest_cursor` 行的 `(harness, nativeSessionId, locator → session_uri)` 上，
 * 而不是伪造一个读不回来的 `.meta.json` 字段。
 */

import { randomUUID } from 'node:crypto';

import type { IngestCursorRepository } from '../adapters/sqlite/ingest-cursor-repository.js';
import { ComemError } from '../domain/errors.js';
import type {
  IngestCursor,
  IngestHarness,
  SessionRef,
} from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';
import { Uri } from '../domain/uri.js';
import type { LogSource } from '../ingest/source.js';

import type { SessionService } from './session.js';

export interface IngestOptions {
  readonly harnesses?: readonly IngestHarness[];
  readonly dryRun?: boolean;
  /**
   * 每个会话一次读多少条。
   *
   * 默认 100，来源是 W24 任务约定（与 MCP 单次批量写入的量级一致，§10.6 的验收
   * 场景就是 100 个文件）。100 条消息的内存占用可忽略，又足够摊薄「每条消息一次
   * 游标写」的代价。
   */
  readonly limitPerSession?: number;
  /** ISO 时间，只导这个时间之后的会话（`startedAt` 为 null 的会话仍然导入）。 */
  readonly since?: string;
}

export interface IngestError {
  readonly locator: string;
  readonly message: string;
}

export interface IngestHarnessReport {
  readonly harness: IngestHarness;
  readonly discovered: number;
  /** 游标已到末尾（或 `since` 之前）的会话数 */
  readonly skipped: number;
  /** 新建的会话数 */
  readonly imported: number;
  /** 追加到已有会话的消息数 */
  readonly appended: number;
  /**
   * 写入的消息总数（含新建会话里的消息）。
   *
   * 报告接口里 `imported` 只数会话，`appended` 只数已有会话；CLI 要打印「共 N 条
   * 消息」时这两个数都不够，所以多一个总数，不改变前两者的语义。
   */
  readonly messages: number;
  readonly failed: number;
  readonly errors: readonly IngestError[];
}

export interface IngestReport {
  readonly harnesses: readonly IngestHarnessReport[];
}

export interface IngestServiceOptions {
  readonly sources: readonly LogSource[];
  readonly scopeUri: Uri;
  readonly logger: Logger;
  readonly batchSize: number;
  /**
   * 会话写入端口。`dryRun` 时可以不传——传了也不会被调用。
   *
   * 用 `Pick` 而不是整个 `SessionService`：导入只做三件事，构造它的其它依赖
   * （锁、任务、权限）与这里无关。
   */
  readonly sessions?: Pick<SessionService, 'create' | 'addMessage' | 'commitPhase1'>;
  /**
   * 游标端口。`dryRun` 时可以传只读连接；不传就当作「没有任何游标」。
   */
  readonly cursors?: Pick<IngestCursorRepository, 'get' | 'upsert'>;
}

interface MutableReport {
  harness: IngestHarness;
  discovered: number;
  skipped: number;
  imported: number;
  appended: number;
  messages: number;
  failed: number;
  errors: IngestError[];
}

function errorMessage(error: unknown): string {
  return ComemError.from(error).message;
}

/** 错误里带的源文件路径；发现阶段的失败（如整份 Qwen 导出损坏）要靠它定位。 */
function locatorOf(error: unknown): string | null {
  if (!(error instanceof ComemError)) {
    return null;
  }
  const locator = error.details?.['locator'];
  return typeof locator === 'string' ? locator : null;
}

/** 源时间戳不是合法 ISO 时用导入时刻兜底：`SessionMessage.createdAt` 必须是 ISO。 */
function normalizeTimestamp(value: string | null): string {
  if (value !== null && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

function isBefore(value: string | null, since: string): boolean {
  if (value === null) {
    return false;
  }
  const startedAt = Date.parse(value);
  if (Number.isNaN(startedAt)) {
    return false;
  }
  return startedAt < Date.parse(since);
}

export class IngestService {
  readonly #sources: readonly LogSource[];
  readonly #scopeUri: Uri;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #sessions: IngestServiceOptions['sessions'];
  readonly #cursors: IngestServiceOptions['cursors'];

  constructor(options: IngestServiceOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `ingest.batchSize 必须是正整数：${options.batchSize}`, {
        batchSize: options.batchSize,
      });
    }
    this.#sources = options.sources;
    this.#scopeUri = options.scopeUri;
    this.#logger = options.logger;
    this.#batchSize = options.batchSize;
    this.#sessions = options.sessions;
    this.#cursors = options.cursors;
  }

  async run(options: IngestOptions = {}): Promise<IngestReport> {
    const dryRun = options.dryRun ?? false;
    if (!dryRun) {
      this.#requireWriter();
      if (this.#cursors === undefined) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          '导入需要游标仓储；`dryRun` 之外必须注入 IngestCursorRepository。',
        );
      }
    }

    const since = this.#parseSince(options.since);
    const batchSize = this.#parseBatchSize(options.limitPerSession);
    const sources = this.#selectSources(options.harnesses);
    const reports: IngestHarnessReport[] = [];

    for (const source of sources) {
      const report: MutableReport = {
        harness: source.harness,
        discovered: 0,
        skipped: 0,
        imported: 0,
        appended: 0,
        messages: 0,
        failed: 0,
        errors: [],
      };

      try {
        for await (const ref of source.discoverSessions()) {
          report.discovered += 1;
          if (since !== null && isBefore(ref.startedAt, since)) {
            report.skipped += 1;
            continue;
          }
          try {
            await this.#ingestSessionAsync(source, ref, report, dryRun, batchSize);
          } catch (error) {
            report.failed += 1;
            report.errors.push({ locator: ref.locator, message: errorMessage(error) });
            this.#logger.error('导入会话失败', {
              harness: source.harness,
              locator: ref.locator,
              nativeSessionId: ref.nativeSessionId,
              reason: errorMessage(error),
            });
          }
        }
      } catch (error) {
        // 发现阶段失败（Qwen 整份导出不是合法 JSON）：整份文件不可用，明确记进
        // 报告，不静默返回 0 个会话。
        report.failed += 1;
        report.errors.push({
          locator: locatorOf(error) ?? `<${source.harness}>`,
          message: errorMessage(error),
        });
        this.#logger.error('导入源发现失败', {
          harness: source.harness,
          reason: errorMessage(error),
        });
      }

      reports.push(report);
      this.#logger.info('导入源完成', {
        harness: report.harness,
        discovered: report.discovered,
        skipped: report.skipped,
        imported: report.imported,
        appended: report.appended,
        messages: report.messages,
        failed: report.failed,
      });
    }

    return { harnesses: reports };
  }

  async #ingestSessionAsync(
    source: LogSource,
    ref: SessionRef,
    report: MutableReport,
    dryRun: boolean,
    batchSize: number,
  ): Promise<void> {
    const existing = this.#cursors?.get(source.harness, ref.nativeSessionId) ?? null;
    if (existing !== null && existing.cursorKind !== source.cursorKind) {
      throw new ComemError('INTERNAL', `游标类型与源不匹配：${ref.locator}`, {
        locator: ref.locator,
        expected: source.cursorKind,
        actual: existing.cursorKind,
      });
    }

    let cursor: IngestCursor | null =
      existing === null ? null : { kind: existing.cursorKind, value: existing.cursorValue };
    let sessionUri: Uri | null =
      existing === null ? null : parseUri(existing.sessionUri, ref.locator);
    let created = false;
    let written = 0;

    while (true) {
      const result = await source.readMessages(ref, cursor, batchSize);
      const advanced =
        cursor === null ? result.cursor.value !== '' : result.cursor.value !== cursor.value;
      if (!advanced) {
        break;
      }

      if (result.messages.length > 0) {
        if (!dryRun) {
          sessionUri = await this.#ensureSession(sessionUri, () => {
            created = true;
          });
          const sessions = this.#requireWriter();
          for (const message of result.messages) {
            await sessions.addMessage(sessionUri, {
              id: randomUUID(),
              role: message.role,
              parts: [{ kind: 'text', text: message.text }],
              createdAt: normalizeTimestamp(message.createdAt),
            });
          }
          written += result.messages.length;
          this.#writeCursor(source, ref, sessionUri, result.cursor, existing, written);
        } else {
          written += result.messages.length;
          if (sessionUri === null) {
            created = true;
          }
        }
      } else if (!dryRun && sessionUri !== null) {
        // 只消费到空行 / 坏行：游标也要前进，否则下一次从同一位置开始，永远读不到
        // 后面的内容。
        this.#writeCursor(source, ref, sessionUri, result.cursor, existing, written);
      }

      cursor = result.cursor;

      // dry-run 只需要回答「这个会话有没有新消息」，不需要把整个文件读完。
      // 真跑时循环到游标不再前进为止。
      if (dryRun) {
        break;
      }
    }

    if (written === 0) {
      report.skipped += 1;
      this.#logger.debug('会话没有新消息，跳过', {
        harness: source.harness,
        nativeSessionId: ref.nativeSessionId,
        locator: ref.locator,
      });
      return;
    }

    if (!dryRun) {
      if (sessionUri !== null) {
        // 一条会话导入完立刻提交：不提交的话记忆永远不会被抽取，用户拿到的只是
        // 一堆 `sessions/sess_xxx/messages.jsonl`。
        await this.#requireWriter().commitPhase1(sessionUri);
      }
      report.messages += written;
      if (created) {
        report.imported += 1;
      } else {
        report.appended += written;
      }
    } else {
      report.messages += written;
      if (created) {
        report.imported += 1;
      } else {
        report.appended += written;
      }
    }

    this.#logger.info(created ? '会话已导入' : '会话已追加', {
      harness: source.harness,
      nativeSessionId: ref.nativeSessionId,
      locator: ref.locator,
      messages: written,
      dryRun,
    });
  }

  async #ensureSession(
    current: Uri | null,
    onCreated: () => void,
  ): Promise<Uri> {
    if (current !== null) {
      return current;
    }
    const sessions = this.#requireWriter();
    const created = await sessions.create(this.#scopeUri);
    onCreated();
    return created;
  }

  #writeCursor(
    source: LogSource,
    ref: SessionRef,
    sessionUri: Uri,
    cursor: IngestCursor,
    existing: { readonly messageCount: number } | null,
    written: number,
  ): void {
    const cursors = this.#cursors;
    if (cursors === undefined) {
      throw new ComemError(
        'INTERNAL',
        '导入游标仓储未注入，无法在非 dry-run 下前进游标。',
        { harness: source.harness, nativeSessionId: ref.nativeSessionId },
      );
    }
    cursors.upsert({
      harness: source.harness,
      nativeSessionId: ref.nativeSessionId,
      sessionUri: sessionUri.toString(),
      cursorKind: cursor.kind,
      cursorValue: cursor.value,
      messageCount: (existing?.messageCount ?? 0) + written,
      updatedAt: new Date().toISOString(),
    });
  }

  #requireWriter(): NonNullable<IngestServiceOptions['sessions']> {
    if (this.#sessions === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        '导入需要会话服务；`dryRun` 之外必须注入 SessionService。',
      );
    }
    return this.#sessions;
  }

  #selectSources(harnesses: readonly IngestHarness[] | undefined): readonly LogSource[] {
    if (harnesses === undefined) {
      return this.#sources;
    }
    const known = new Set(this.#sources.map((source) => source.harness));
    for (const harness of harnesses) {
      if (!known.has(harness)) {
        throw new ComemError('INVALID_ARGUMENT', `未知的导入来源：${harness}`, { harness });
      }
    }
    const selected = new Set(harnesses);
    return this.#sources.filter((source) => selected.has(source.harness));
  }

  #parseBatchSize(limitPerSession: number | undefined): number {
    if (limitPerSession === undefined) {
      return this.#batchSize;
    }
    if (!Number.isInteger(limitPerSession) || limitPerSession <= 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `limitPerSession 必须是正整数：${limitPerSession}`,
        { limitPerSession },
      );
    }
    return limitPerSession;
  }

  #parseSince(since: string | undefined): string | null {
    if (since === undefined || since === '') {
      return null;
    }
    if (Number.isNaN(Date.parse(since))) {
      throw new ComemError('INVALID_ARGUMENT', `--since 不是合法时间：${since}`, { since });
    }
    return since;
  }
}

function parseUri(value: string, locator: string): Uri {
  try {
    return Uri.parse(value);
  } catch (error) {
    throw new ComemError('INTERNAL', `游标里的会话 URI 不合法：${locator}`, {
      locator,
      uri: value,
      reason: errorMessage(error),
    });
  }
}
