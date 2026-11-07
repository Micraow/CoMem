/**
 * 归档端口工厂（架构文档 §10.1、§10.3、§10.5、§6.2 规则 6）。
 *
 * `CommitPipeline` 的 `StepContextPorts` 五个方法全部**绑定在某一个归档目录上**：
 * 读它自己的 `messages.jsonl`、写它自己的 `.meta.json`、找它上一个归档的概览。
 * 所以不能一次性构造，要按 `archiveUri` 现造——每个任务一份，不复用。
 *
 * ## 为什么有两个保留名不走 `ContentStore`
 *
 * `.done` 与 `memory_diff.json` 是归档产物，不是用户内容：`Uri` 拒绝它们作为普通
 * 路径段（§6.2 规则 6），`ContentStore.writeText` 也会以 `PERMISSION_DENIED` 拒绝。
 * 它们只能按「归档目录 + 文件名」落到磁盘路径，所以 `ArchivePortsDeps` 要带
 * `dataDir`。其余三个方法走正常的存储与元数据 API。
 *
 * ## 坏行是跳过，不是抛错
 *
 * `messages.jsonl` 由阶段一原子写，正常不会坏。但归档是持久产物：手改、磁盘错误、
 * 版本升级都可能留下一行脏数据，而一条脏数据让整个归档永远重试是更坏的失败形态
 * （§10.4 的租约重试会一直撞在同一行上）。所以逐行解析，坏行记 warn 后跳过。
 * 这与 `services/session.ts` 读取时抛 `INTERNAL` 的口径不同：那边读的是**活**会话，
 * 坏数据要立刻暴露；这边是**事后**重放，能做的是尽量往前跑。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import { toDiskPath } from '../adapters/fs/path.js';
import type { ArchiveMeta, MemoryDiff } from '../domain/archive.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { ContentPart, SessionMessage } from '../domain/session.js';
import type { Uri } from '../domain/uri.js';

import type { StepContextPorts } from '../services/commit/pipeline.js';

/** `archive_NNN/messages.jsonl`（§6.5）。 */
const MESSAGES_FILE_NAME = 'messages.jsonl';

/** 归档完成标记（§10.1：唯一的完成信号，最后写）。 */
const DONE_FILE_NAME = '.done';

/** 一批记忆操作的差异（§6.6）。 */
const MEMORY_DIFF_FILE_NAME = 'memory_diff.json';

/** 归档序号目录名：`archive_001`、`archive_002`……（§10.2）。 */
const ARCHIVE_DIRECTORY_PATTERN = /^archive_(\d+)$/;

export interface ArchivePortsDeps {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly logger: Logger;
  /**
   * 数据根。
   *
   * 只用于两个保留名产物（`.done` / `memory_diff.json`）的磁盘定位——它们既不能
   * 建成 `Uri` 路径段，也不能交给 `ContentStore`（见文件头）。
   */
  readonly dataDir: string;
  /**
   * 步骤集合变化时的回调。
   *
   * `CommitPipeline` 把 `stepsDone` 写进 `.meta.json`（重放跳过以它为准），
   * `task` 表也有一列 `steps_done`。**两个地方都写不是冗余**：`.meta.json` 是
   * 重放的依据，`task.steps_done` 让「卡在第几步」能直接 SQL 查出来而不用去翻
   * 每个归档目录。不接这个回调，任务行的 `steps_done` 永远是空的。
   */
  readonly onStepsChanged?: (steps: readonly string[]) => void;
}

/** `MemoryMergeStepDeps.archive` 的形状（`memory_diff.json` 的写入）。 */
export interface ArchiveWriter {
  writeMemoryDiff(archiveUri: Uri, diff: MemoryDiff): Promise<void>;
}

/**
 * 为**一个**归档目录构造端口。
 *
 * 五个方法都是「这个归档」的视角：读它自己的 `messages.jsonl`、写它自己的
 * `.meta.json`、找它上一个归档的概览。所以每次执行任务现造一份，不能复用。
 */
export function createArchivePorts(archiveUri: Uri, deps: ArchivePortsDeps): StepContextPorts {
  return {
    readMessages: () => readMessages(archiveUri, deps),
    readArchiveMeta: () => readArchiveMeta(archiveUri, deps),
    writeArchiveMeta: async (meta) => {
      await deps.metadata.writeArchive(archiveUri, meta);
      deps.onStepsChanged?.(meta.stepsDone);
    },
    latestArchiveOverview: () => latestArchiveOverview(archiveUri, deps),
    writeDone: () => writeDone(archiveUri, deps),
    logger: deps.logger,
  };
}

/**
 * `memory_diff.json` 的写入（`MemoryMergeStepDeps.archive`）。
 *
 * 工厂的第一个参数是端口契约要求的「绑定归档」形状；写盘位置取调用时传进来的
 * 归档——`CommitPipeline.run` 的入参就是构造端口用的那个，两者必然相同。用入参是
 * 为了让「写哪个归档」在调用点可见，而不是藏在这个闭包里。
 */
export function createArchiveWriter(_archiveUri: Uri, deps: ArchivePortsDeps): ArchiveWriter {
  return {
    async writeMemoryDiff(archiveUri: Uri, diff: MemoryDiff): Promise<void> {
      const absolute = join(toDiskPath(deps.dataDir, archiveUri), MEMORY_DIFF_FILE_NAME);
      // 写盘成功之前不写：`memory_diff.json` 存在就代表这批操作已经处理过。
      await writeFile(absolute, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
      deps.logger.debug('记忆差异已写入', {
        archive: archiveUri.toString(),
        adds: diff.summary.totalAdds,
        updates: diff.summary.totalUpdates,
        deletes: diff.summary.totalDeletes,
      });
    },
  };
}

async function readMessages(
  archiveUri: Uri,
  deps: ArchivePortsDeps,
): Promise<readonly SessionMessage[]> {
  const document = await deps.store.readText(archiveUri.child(MESSAGES_FILE_NAME));
  return parseMessages(document.text, archiveUri, deps.logger);
}

/**
 * 归档元数据。**缺失是数据损坏**，抛 `NOT_FOUND` 而不是编一个空结构。
 *
 * `ArchiveMeta` 不可空：编一个 `stepsDone: []` 的空结构会让管线跑完全部步骤、写
 * `.done`，把「元数据丢了」变成「归档完成」。
 */
async function readArchiveMeta(archiveUri: Uri, deps: ArchivePortsDeps): Promise<ArchiveMeta> {
  const meta = await deps.metadata.readArchive(archiveUri);
  if (meta === null) {
    throw new ComemError('NOT_FOUND', `归档元数据不存在：${archiveUri.toString()}`, {
      uri: archiveUri.toString(),
    });
  }
  return meta;
}

/**
 * 序号比当前归档小的最大归档的 `.overview.md` 正文（§10.5）；没有则 `null`。
 *
 * **按数字序号比较。** 字符串排序会把 `archive_10` 排在 `archive_9` 之前，而这里的
 * 返回值是下一次抽取的「上次聊到哪」，取错归档等于喂错上下文。目录 mtime 同样不行：
 * 复制、恢复、`rsync` 都会改它。
 */
async function latestArchiveOverview(
  archiveUri: Uri,
  deps: ArchivePortsDeps,
): Promise<string | null> {
  const historyUri = archiveUri.parent();
  const current = archiveSequence(archiveUri.name);
  if (historyUri === null || current === null) {
    return null;
  }

  let latest: { readonly sequence: number; readonly uri: Uri } | null = null;
  for (const entry of await deps.store.list(historyUri)) {
    if (entry.kind !== 'directory') {
      continue;
    }
    const sequence = archiveSequence(entry.uri.name);
    if (sequence === null || sequence >= current) {
      continue;
    }
    if (latest === null || sequence > latest.sequence) {
      latest = { sequence, uri: entry.uri };
    }
  }
  if (latest === null) {
    return null;
  }

  // 概览缺失（没开工作记忆、或归档是老版本）是正常状态，不是错误。
  const summary = await deps.metadata.readSummary(latest.uri);
  return summary.overview.trim() === '' ? null : summary.overview;
}

/**
 * 写 `archive_NNN/.done`（空内容）。
 *
 * **只有 `CommitPipeline.run` 在全部步骤成功后调它**（§10.1）。先写就等于宣称成功，
 * 而后面可能什么都没做；重放时看到它也会跳过整个归档。
 */
async function writeDone(archiveUri: Uri, deps: ArchivePortsDeps): Promise<void> {
  const absolute = join(toDiskPath(deps.dataDir, archiveUri), DONE_FILE_NAME);
  await writeFile(absolute, '', 'utf8');
  deps.logger.debug('归档完成标记已写入', { archive: archiveUri.toString() });
}

function parseMessages(
  raw: string,
  archiveUri: Uri,
  logger: Logger,
): readonly SessionMessage[] {
  const messages: SessionMessage[] = [];
  const lines = raw.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') {
      continue;
    }
    const message = toSessionMessage(line);
    if (message === null) {
      logger.warn('归档消息有一行不合法，已跳过', {
        archive: archiveUri.toString(),
        line: index + 1,
      });
      continue;
    }
    messages.push(message);
  }

  return messages;
}

/**
 * 一行 JSON → `SessionMessage`；坏行返回 `null`。
 *
 * 逐字段校验而不是断言：这些行是上一次进程写下来的，手改、版本升级都会让形状对
 * 不上，而 `as SessionMessage` 会把错误变成运行期的 `undefined`（下游 `parts.filter`
 * 直接崩）。
 */
function toSessionMessage(line: string): SessionMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const role = record['role'];
  const parts = record['parts'];
  const createdAt = record['createdAt'];
  const turn = record['turn'];
  if (typeof id !== 'string' || typeof createdAt !== 'string') {
    return null;
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
    return null;
  }
  if (!Array.isArray(parts)) {
    return null;
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    return null;
  }
  // `parts` 是判别联合，逐项校验等于把领域定义抄一遍；写入侧只写 `SessionMessage`，
  // 这里确认它是数组即可（与 `services/session.ts` 的 `toSessionMessage` 同口径）。
  return { id, role, parts: parts as readonly ContentPart[], createdAt, turn };
}

function archiveSequence(name: string): number | null {
  const matched = ARCHIVE_DIRECTORY_PATTERN.exec(name);
  if (matched === null) {
    return null;
  }
  const digits = matched[1];
  return digits === undefined ? null : Number(digits);
}
