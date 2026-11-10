/**
 * 单个会话的落地：读游标 → 读批次 → 建/复用会话 → 逐条追加 → 写回游标 → 阶段一。
 *
 * **游标与计数只在这个函数的栈上**（`cursor` / `written` / `known`），不跨调用保存。
 * 游标只在消息落盘之后前进；消息 ID 是确定性的，重跑靠 `knownMessageIds` 去重。
 * 判定顺序与 `IngestService` 内联时逐行相同。
 */

import { ComemError } from '../../domain/errors.js';
import type { IngestCursor, SessionRef } from '../../domain/ingest.js';
import type { Uri } from '../../domain/uri.js';
import type { LogSource } from '../../ingest/source.js';
import { stableMessageId } from '../session.js';

import type { IngestPorts } from './ports.js';
import { requireWriter } from './ports.js';
import type { MutableReport } from './stats.js';
import { normalizeTimestamp, parseUri } from './support.js';

/**
 * `writeCursors` 同时表达写入模式：`null` 是 dry-run（不写会话、不写游标），
 * 非空是游标仓储，由 `run()` 的 `requireCursors` 保证。
 */
export async function ingestSessionAsync(
  ports: IngestPorts,
  source: LogSource,
  ref: SessionRef,
  report: MutableReport,
  writeCursors: NonNullable<IngestPorts['cursors']> | null,
  batchSize: number,
): Promise<string | null> {
  const existing = ports.cursors?.get(source.harness, ref.nativeSessionId) ?? null;
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
  /**
   * 会话里已经有的消息 ID。**惰性**取：会话可能是这一批刚建的，此时它是空的。
   *
   * 只在第一次需要时读一次，之后的批共用。新追加的消息**不**加进来：同一批里
   * 两条完全相同的消息是两次真实的发言，按 ID 去重会把它们合并成一条。
   */
  let known: ReadonlySet<string> | null = null;

  while (true) {
    const result = await source.readMessages(ref, cursor, batchSize);
    const advanced =
      cursor === null ? result.cursor.value !== '' : result.cursor.value !== cursor.value;
    if (!advanced) {
      break;
    }

    if (result.messages.length > 0) {
      if (writeCursors !== null) {
        sessionUri = await ensureSession(ports, sessionUri, () => {
          created = true;
        });
        const sessions = requireWriter(ports.sessions);
        known ??= await knownMessageIds(sessions, sessionUri);
        let appended = 0;
        for (const message of result.messages) {
          const createdAt = normalizeTimestamp(message.createdAt);
          const id = stableMessageId(message.role, message.text, createdAt);
          if (known.has(id)) {
            // 重跑：这条消息上一次已经落过盘，只是游标没来得及前进
            // （见文件头「幂等」）。再追加一次就是重复导入。
            continue;
          }
          await sessions.addMessage(sessionUri, {
            id,
            role: message.role,
            parts: [{ kind: 'text', text: message.text }],
            createdAt,
          });
          appended += 1;
        }
        written += appended;
        // 游标照常前进：这批消息已经在磁盘上了（要么这次写的，要么上次写的）。
        // 不前进会让下一次重跑再读一遍同一段，虽然去重后不会重复，但白读一遍
        // 整个文件。
        writeCursor(writeCursors, source, ref, sessionUri, result.cursor, existing, written);
      } else {
        written += result.messages.length;
        if (sessionUri === null) {
          created = true;
        }
      }
    } else if (writeCursors !== null && sessionUri !== null) {
      // 只消费到空行 / 坏行：游标也要前进，否则下一次从同一位置开始，永远读不到
      // 后面的内容。
      writeCursor(writeCursors, source, ref, sessionUri, result.cursor, existing, written);
    }

    cursor = result.cursor;

    // dry-run 只需要回答「这个会话有没有新消息」，不需要把整个文件读完。
    // 真跑时循环到游标不再前进为止。
    if (writeCursors === null) {
      break;
    }
  }

  if (written === 0) {
    report.skipped += 1;
    ports.logger.debug('会话没有新消息，跳过', {
      harness: source.harness,
      nativeSessionId: ref.nativeSessionId,
      locator: ref.locator,
    });
    return null;
  }

  if (writeCursors !== null) {
    if (sessionUri !== null) {
      // 一条会话导入完立刻提交：阶段一只落归档、建任务，记忆要等阶段二。
      const commit = await requireWriter(ports.sessions).commitPhase1(sessionUri);
      report.messages += written;
      if (created) {
        report.imported += 1;
      } else {
        report.appended += written;
      }
      ports.logger.info(created ? '会话已导入' : '会话已追加', {
        harness: source.harness,
        nativeSessionId: ref.nativeSessionId,
        locator: ref.locator,
        messages: written,
        taskId: commit.taskId,
      });
      return commit.taskId;
    }
    return null;
  }

  report.messages += written;
  if (created) {
    report.imported += 1;
  } else {
    report.appended += written;
  }
  ports.logger.info(created ? '会话已导入' : '会话已追加', {
    harness: source.harness,
    nativeSessionId: ref.nativeSessionId,
    locator: ref.locator,
    messages: written,
    dryRun: true,
  });
  return null;
}

/**
 * 会话里已经有的消息 ID：live 与全部归档。
 *
 * 只读 live 不够——归档之后消息已经移进 `history/archive_NNN/`，live 是空的，
 * 重跑会把整段对话再追加一遍。归档元数据里有 `archivedMessageIds`，不需要重新
 * 解析 `messages.jsonl`。
 *
 * 与 `remember` 的 `knownMessageIds` 同一套判据（§11.9）。
 */
async function knownMessageIds(
  sessions: NonNullable<IngestPorts['sessions']>,
  sessionUri: Uri,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const message of (await sessions.load(sessionUri)).messages) {
    ids.add(message.id);
  }
  for (const archiveUri of await sessions.listArchives(sessionUri)) {
    const meta = await sessions.readArchiveMeta(archiveUri);
    for (const id of meta?.phase1.archivedMessageIds ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

/** 首次写入时建会话；`onCreated` 让调用方置 `created = true`（报告用）。 */
async function ensureSession(
  ports: IngestPorts,
  current: Uri | null,
  onCreated: () => void,
): Promise<Uri> {
  if (current !== null) {
    return current;
  }
  const sessions = requireWriter(ports.sessions);
  const created = await sessions.create(ports.scopeUri, ports.principals);
  onCreated();
  return created;
}

function writeCursor(
  cursors: NonNullable<IngestPorts['cursors']>,
  source: LogSource,
  ref: SessionRef,
  sessionUri: Uri,
  cursor: IngestCursor,
  existing: { readonly messageCount: number } | null,
  written: number,
): void {
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