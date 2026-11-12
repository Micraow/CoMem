/**
 * `pnpm ingest` 命令（架构文档 §11.9）。
 *
 * ```bash
 * pnpm ingest --source claude-code
 * pnpm ingest --source all --dry-run
 * pnpm ingest --source codex --since 2026-08-01
 * pnpm ingest --source all --json
 * pnpm ingest --source all --no-wait
 * pnpm ingest --source all --timeout 600
 * ```
 *
 * ## 输出约定
 *
 * 报告写 stdout，日志写 stderr。`--json` 时 stdout 只有一份 JSON——`jq` 能直接
 * 解析，不会被启动日志污染。
 *
 * ## dry-run 不开数据库写连接
 *
 * 非 dry-run 走 `createContainer`（迁移、根预置、会话服务都在里面）；dry-run 只
 * 在数据库文件已经存在时用**只读连接**读游标，连 `_meta` 目录都不创建。这样
 * 「只报告不写」在文件系统层面也成立。
 *
 * ## 阶段二为什么要从命令里驱动
 *
 * `pnpm ingest` 是一次性进程，不是常驻服务。`commitPhase1` 只建任务（`pending`），
 * 服务端的 `CommitRunner` 不会知道这个进程导入了什么——不在这里驱动，任务永远停在
 * `pending`，用户看到「导了 908 个会话，find 0 命中」。
 *
 * 装配方把「跑任务直到队列空」包成 `ExtractionRunner`：`services/` 不依赖
 * `bootstrap/`，命令层负责接线。统计只算本次导入创建的任务；队列里的历史任务照常
 * 执行（执行器不区分来源）。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toDiskPath } from '../adapters/fs/path.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { openDatabase } from '../adapters/sqlite/database.js';
import { IngestCursorRepository } from '../adapters/sqlite/ingest-cursor-repository.js';
import type { TaskRow } from '../adapters/sqlite/task-repository.js';
import { createContainer } from '../bootstrap/container.js';
import type { CommitRunner } from '../bootstrap/commit-runner.js';
import { readFlag } from '../config/file.js';
import type { ComemConfig } from '../config/index.js';
import { USER_WILDCARD } from '../domain/acl.js';
import { ComemError, comemErrorMessage } from '../domain/errors.js';
import { fsErrorCode } from '../domain/errors.js';
import { isRecord } from '../domain/guards.js';
import type { IngestHarness } from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';
import { MILLISECONDS_PER_SECOND } from '../domain/time.js';
import { Uri } from '../domain/uri.js';
import { createSources, INGEST_HARNESSES, isIngestHarness } from '../ingest/registry.js';
import {
  IngestService,
  type ExtractionRunner,
  type IngestExtractionBatch,
  type IngestReport,
  type IngestServiceOptions,
} from '../services/ingest.js';
import type { TaskService } from '../services/task.js';

import { loadCommandConfig } from './config.js';

const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';
const MEMORY_DIFF_FILE_NAME = 'memory_diff.json';

/**
 * 另一个执行器（服务端调度器）占着任务时的轮询间隔。
 *
 * 50ms 是经验值：`CommitRunner` 的轮询间隔是 1 秒，这里只是等它释放 `#ticking`
 * 的那一小段；更密会让一个卡住的任务把这行循环打成忙等，更疏会让一批的最后几个
 * 任务多等半秒。只在「任务被别的执行器持有」这条罕见路径上生效。
 */
const EXTRACTION_POLL_INTERVAL_MS = 50;

/**
 * 导出修复工具的提示。文件不存在时（另一个 wave 还没做）只报错误，不指向不存在的
 * 脚本——指向一个不存在的路径比没有提示更糟。
 */
const REPAIR_SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/repair-export.mjs', import.meta.url),
);

export interface IngestCommandOptions {
  /** 配置文件路径（测试注入用）；命令行传 `--config` */
  readonly configPath?: string;
  /** 数据根（测试注入用）；命令行传 `--data-dir` */
  readonly dataDir?: string;
  /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` / `--data-dir` 靠它生效 */
  readonly argv?: readonly string[];
  /** `all` 或逗号分隔的宿主名 */
  readonly source?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly since?: string;
  readonly limitPerSession?: number;
  /** 默认 `true`；`--no-wait` 时只导入、立即返回。 */
  readonly waitForExtraction?: boolean;
  /** 每批阶段二的最长等待（毫秒）。`--timeout <秒>` 覆盖。 */
  readonly extractionTimeoutMs?: number;
}

interface MemoryDiffEntry {
  readonly uri: string;
  readonly memoryType: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ComemError('INVALID_ARGUMENT', `${flag} 必须是正整数：${raw}`, { flag, value: raw });
  }
  return value;
}

function parseNonNegativeInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ComemError('INVALID_ARGUMENT', `${flag} 必须是非负整数：${raw}`, { flag, value: raw });
  }
  return value;
}

/**
 * 只解析命令自己的参数。`--config` / `--data-dir` 归 `loadCommandConfig` 解析：
 * 在这里再读一遍就会多一份「哪个 flag 算配置」的实现，漏一个就静默失效。
 */
function parseArgs(argv: readonly string[]): IngestCommandOptions {
  const source = readFlag(argv, 'source');
  const since = readFlag(argv, 'since');
  const limit = readFlag(argv, 'limit-per-session');
  const timeout = readFlag(argv, 'timeout');
  return {
    ...(source === undefined ? {} : { source }),
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined
      ? {}
      : { limitPerSession: parsePositiveInteger(limit, '--limit-per-session') }),
    ...(timeout === undefined
      ? {}
      : {
          extractionTimeoutMs:
            parseNonNegativeInteger(timeout, '--timeout') * MILLISECONDS_PER_SECOND,
        }),
    ...(argv.includes('--dry-run') ? { dryRun: true } : {}),
    ...(argv.includes('--json') ? { json: true } : {}),
    ...(argv.includes('--no-wait') ? { waitForExtraction: false } : {}),
  };
}

function selectHarnesses(source: string | undefined): readonly IngestHarness[] | undefined {
  if (source === undefined || source.trim() === '' || source === 'all') {
    return undefined;
  }
  const names = source
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.includes('all')) {
    return undefined;
  }
  const harnesses: IngestHarness[] = [];
  for (const name of names) {
    if (!isIngestHarness(name)) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `未知的导入来源：${name}。可选值：all / ${INGEST_HARNESSES.join(' / ')}`,
        { source: name },
      );
    }
    harnesses.push(name);
  }
  return harnesses;
}

function scopeUriOf(subject: string): Uri {
  return Uri.parse(`comem://user/${subject.replace(/^user:/u, '')}`);
}

/**
 * 只读地打开游标表。数据库不存在、或还没有 `ingest_cursor` 表时返回 `null`
 * （当作「没有任何游标」），dry-run 不写、也不跑迁移。
 */
function openReadOnlyCursors(
  dataDir: string,
  logger: Logger,
): { readonly cursors: Pick<IngestCursorRepository, 'get' | 'upsert'>; readonly db: DatabaseSync } | null {
  const path = join(dataDir, META_DIRECTORY, DATABASE_FILE);
  if (!existsSync(path)) {
    return null;
  }
  const db = openDatabase(path, { readonly: true });
  const table = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'ingest_cursor'")
    .get();
  if (table === undefined) {
    db.close();
    return null;
  }
  return { cursors: new IngestCursorRepository({ db, logger }), db };
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

/** `memory_diff.json` 的 `operations.adds` / `updates`：一次写入就是一条记忆。 */
function memoryDiffEntries(value: unknown): readonly MemoryDiffEntry[] {
  if (!isRecord(value)) {
    return [];
  }
  const operations = value['operations'];
  if (!isRecord(operations)) {
    return [];
  }
  const entries: MemoryDiffEntry[] = [];
  for (const key of ['adds', 'updates'] as const) {
    const list = operations[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (!isRecord(item)) {
        continue;
      }
      const uri = item['uri'];
      const memoryType = item['memoryType'];
      if (typeof uri === 'string' && typeof memoryType === 'string') {
        entries.push({ uri, memoryType });
      }
    }
  }
  return entries;
}

function archiveUriOf(payload: unknown): Uri | null {
  if (!isRecord(payload)) {
    return null;
  }
  const archiveUri = payload['archiveUri'];
  return typeof archiveUri === 'string' ? Uri.tryParse(archiveUri) : null;
}

interface ExtractionRunnerOptions {
  readonly tasks: Pick<TaskService, 'claimable'>;
  readonly taskStore: Pick<{ get(id: string): TaskRow | null }, 'get'>;
  readonly commitRunner: Pick<CommitRunner, 'tick'>;
  readonly dataDir: string;
  /** `memory.reviewRequired`：这些类型的记忆写入时是 `pending`，不进检索。 */
  readonly reviewRequired: ReadonlySet<string>;
  readonly logger: Logger;
  /** 与 `config.task.concurrency` 一致：一次 `tick` 最多认领几个任务。 */
  readonly concurrency: number;
}

/**
 * `ExtractionRunner` 的装配实现（命令层）。
 *
 * `CommitRunner.tick()` 认领的是**队列里的**任务，不接受 ID 过滤；`taskIds` 只用于
 * 「这批里哪些任务跑完了」的统计。历史任务照常执行——执行器是全局的。
 */
class ExtractionRunnerImpl implements ExtractionRunner {
  readonly #tasks: ExtractionRunnerOptions['tasks'];
  readonly #taskStore: ExtractionRunnerOptions['taskStore'];
  readonly #commitRunner: ExtractionRunnerOptions['commitRunner'];
  readonly #dataDir: string;
  readonly #reviewRequired: ReadonlySet<string>;
  readonly #logger: Logger;
  readonly #concurrency: number;

  constructor(options: ExtractionRunnerOptions) {
    this.#tasks = options.tasks;
    this.#taskStore = options.taskStore;
    this.#commitRunner = options.commitRunner;
    this.#dataDir = options.dataDir;
    this.#reviewRequired = options.reviewRequired;
    this.#logger = options.logger;
    this.#concurrency = Math.max(1, options.concurrency);
  }

  async run(options: { readonly timeoutMs: number }): Promise<IngestExtractionBatch> {
    const deadline = Date.now() + options.timeoutMs;
    let timedOut = false;
    let previous: string | null = null;

    const attempted = new Set<string>();
    const counted = new Set<string>();
    const memories = new Map<string, string>();
    const pendingReview = new Set<string>();
    let tasksCompleted = 0;
    let tasksFailed = 0;

    while (true) {
      const claimed = this.#tasks.claimable(this.#concurrency);
      if (claimed.length === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const first = claimed[0];
      if (first !== undefined && first.id === previous && first.status === 'running') {
        // 服务端调度器正持有这个任务的租约：它的 `#ticking` 会让我们的 tick 直接
        // 返回。等它跑完再看，避免把循环打成忙等。
        await delay(EXTRACTION_POLL_INTERVAL_MS);
        continue;
      }
      previous = first?.id ?? null;
      for (const task of claimed) {
        attempted.add(task.id);
      }
      await this.#commitRunner.tick();

      // `tick` 一次最多认领 `concurrency` 个任务；认领之后 status 才会变。逐个
      // 回读：完成 / 失败计数，并读 `memory_diff.json` 统计写入的记忆。
      for (const task of claimed) {
        if (counted.has(task.id)) {
          continue;
        }
        const row = this.#taskStore.get(task.id);
        if (row === null) {
          continue;
        }
        if (row.status === 'done') {
          tasksCompleted += 1;
          counted.add(task.id);
        } else if (row.status === 'failed') {
          tasksFailed += 1;
          counted.add(task.id);
        } else {
          // 还没跑完（被别的执行器持有 / 仍在重试）：下一轮再看。
          continue;
        }
        const archiveUri = archiveUriOf(row.payload);
        if (archiveUri === null) {
          continue;
        }
        for (const entry of await this.#readMemoryDiff(archiveUri)) {
          // 同一份记忆在一个归档里既可能是 add 又可能是 update；URI 去重。
          memories.set(entry.uri, entry.memoryType);
          if (this.#reviewRequired.has(entry.memoryType)) {
            pendingReview.add(entry.uri);
          }
        }
      }
    }

    return {
      tasksAttempted: attempted.size,
      tasksCompleted,
      tasksFailed,
      memories,
      pendingReview: [...pendingReview],
      timedOut,
    };
  }

  async #readMemoryDiff(archiveUri: Uri): Promise<readonly MemoryDiffEntry[]> {
    const path = join(toDiskPath(this.#dataDir, archiveUri), MEMORY_DIFF_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') {
        this.#logger.warn('读取 memory_diff.json 失败，报告里的抽取条数可能偏少。', {
          archive: archiveUri.toString(),
          reason: comemErrorMessage(error),
        });
      }
      return [];
    }
    try {
      return memoryDiffEntries(JSON.parse(raw));
    } catch (error) {
      this.#logger.warn('memory_diff.json 不是合法 JSON，报告里的抽取条数可能偏少。', {
        archive: archiveUri.toString(),
        reason: comemErrorMessage(error),
      });
      return [];
    }
  }
}

/** 人类可读的终端输出。导出只为了测试「降级那行确实打印出来」。 */
export function renderReport(report: IngestReport, dryRun: boolean): string {
  const lines: string[] = [];
  for (const source of report.harnesses) {
    lines.push(
      `来源 ${source.harness}：发现 ${formatNumber(source.discovered)} 个会话${dryRun ? '（dry-run，未写入）' : ''}`,
    );
    const newMessages = source.messages - source.appended;
    if (source.imported > 0) {
      lines.push(
        `  ✅ 新建 ${formatNumber(source.imported)} 个会话，共 ${formatNumber(newMessages)} 条消息`,
      );
    }
    if (source.appended > 0) {
      lines.push(`  ➕ 追加 ${formatNumber(source.appended)} 条消息到已有会话`);
    }
    if (source.skipped > 0) {
      lines.push(`  ⏭️  跳过 ${formatNumber(source.skipped)} 个（游标已到末尾）`);
    }
    if (source.failed > 0) {
      lines.push(`  ❌ 失败 ${formatNumber(source.failed)} 个`);
      for (const error of source.errors) {
        lines.push(`    - ${error.locator}：${error.message}`);
      }
    }
    if (
      source.imported === 0 &&
      source.appended === 0 &&
      source.skipped === 0 &&
      source.failed === 0
    ) {
      lines.push('  （没有可导入的会话）');
    }
  }

  const extraction = report.extraction;
  if (extraction !== null && extraction.skipped) {
    // 降级必须让用户看见：跑完 1,076 个会话却不说「记忆没被抽取」，用户会以为
    // `find` 能搜到。
    lines.push('');
    lines.push(
      '阶段二（记忆抽取）：跳过——providers.llm.default.type 是 disabled，没有可用的模型。会话已归档、任务已建，但记忆还没抽取，`find` 暂时搜不到内容。配好 providers.llm 后重跑本命令，积压的任务会被执行器认领。',
    );
  } else if (extraction !== null) {
    lines.push('');
    lines.push('阶段二（记忆抽取）：');
    for (const batch of extraction.batches) {
      const scope = `${formatNumber(batch.sessions)} 个会话`;
      if (batch.error !== null) {
        lines.push(`  第 ${batch.index} 批（${scope}）❌ 失败：${batch.error}`);
        continue;
      }
      const active = batch.memoriesExtracted - batch.memoriesPendingReview;
      const suffix = batch.timedOut ? '（超时，剩余任务留在队列）' : '';
      lines.push(
        `  第 ${batch.index} 批（${scope}）✅ 抽取 ${formatNumber(batch.memoriesExtracted)} 条记忆（${formatNumber(active)} 条 active，${formatNumber(batch.memoriesPendingReview)} 条待复核）${suffix} ${formatDuration(batch.durationMs)}`,
      );
    }
    const total = extraction;
    const active = total.memoriesExtracted - total.memoriesPendingReview;
    lines.push(
      `  合计：完成 ${formatNumber(total.tasksCompleted)} 个任务，失败 ${formatNumber(total.tasksFailed)} 个，抽取 ${formatNumber(total.memoriesExtracted)} 条记忆（${formatNumber(active)} 条 active，${formatNumber(total.memoriesPendingReview)} 条待复核），耗时 ${formatDuration(total.durationMs)}`,
    );
    if (total.memoriesPendingReview > 0) {
      lines.push(
        '  待复核的记忆不会出现在检索结果里：`GET /api/v1/memories/pending` 查看，`POST /api/v1/memories/{uri}/approve` 通过（URI 需 URL 编码）。',
      );
    }
  } else if (dryRun) {
    lines.push('');
    lines.push('阶段二（记忆抽取）：dry-run 不执行。');
  } else if (report.harnesses.some((source) => source.imported > 0 || source.appended > 0)) {
    lines.push('');
    lines.push(
      '阶段二（记忆抽取）：未等待（--no-wait）。会话已归档、任务已建，但记忆还没抽取，`find` 暂时搜不到内容。',
    );
  }

  // 部分失败必须让脚本能感知（退出码 1），同时给出可执行的下一步。
  const failed = report.harnesses.filter((source) => source.failed > 0);
  if (failed.length > 0) {
    lines.push('');
    lines.push(`⚠️  ${formatNumber(failed.length)} 个来源失败：`);
    const repairHint = existsSync(REPAIR_SCRIPT_PATH)
      ? '修复工具见 scripts/repair-export.mjs'
      : null;
    for (const source of failed) {
      for (const error of source.errors) {
        lines.push(`  ${source.harness}：${error.message}`);
        if (source.harness === 'qwen' && repairHint !== null) {
          lines.push(`       ${repairHint}`);
        }
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 跑一次导入。返回报告；失败会计入报告，不抛错（除非参数或配置不合法）。
 *
 * `dryRun` 时 `sessions` 不注入——`IngestService` 一旦尝试写入就会明确报错，
 * 而不是静默写下去。
 */
export async function runIngest(options: IngestCommandOptions = {}): Promise<IngestReport> {
  // 统一入口：`configPath` / `dataDir` 是测试注入用的显式覆盖，真实 `--config` /
  // `--data-dir` 从 `options.argv` 解析（缺省 `process.argv.slice(2)`）。显式覆盖
  // 排在前面，与 `loadConfig` 的 `options.path 优先于 --config` 一致。
  const argv = [
    ...(options.configPath === undefined ? [] : ['--config', options.configPath]),
    ...(options.dataDir === undefined ? [] : ['--data-dir', options.dataDir]),
    ...(options.argv ?? process.argv.slice(2)),
  ];
  const dryRun = options.dryRun ?? false;
  const harnesses = selectHarnesses(options.source);

  if (!dryRun) {
    // `createContainer` 自己加载配置；这里先读一遍是为了在写任何东西之前拒绝
    // 「默认关闭」的导入。容器启动会建库、建根目录，不校验就会先写后报错。
    const config = loadCommandConfig({ argv });
    if (!config.ingest.enabled) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        '导入默认关闭：把 ingest.enabled 设为 true（或设 COMEM_INGEST_ENABLED=true）后再运行。',
        { field: 'ingest.enabled' },
      );
    }
  }

  const logger = new ConsoleLogger({
    level: 'info',
    write: (line) => process.stderr.write(line),
  });

  if (dryRun) {
    const config = loadCommandConfig({ argv });
    return runWithConfig(config, logger, harnesses, options, dryRun);
  }

  // 容器的日志默认写 stdout；`--json` 时那会污染报告。压到 error 级别，报告与
  // 导入日志各走各的流。
  const container = await createContainer({ argv, env: { ...process.env, COMEM_LOGGING_LEVEL: 'error' } });
  try {
    // 一次性导入不该和 30 秒调度器抢同一批会话：调度器可能在两次 `addMessage`
    // 之间自动提交，归档出一段不完整的对话。停掉它，阶段二由本命令自己驱动。
    await container.scheduler.stop();
    return await runWithConfig(
      container.config,
      logger,
      harnesses,
      options,
      dryRun,
      {
        sessions: container.services.session,
        cursors: new IngestCursorRepository({ db: container.db, logger }),
        extraction: new ExtractionRunnerImpl({
          tasks: container.services.task,
          taskStore: container.services.taskStore,
          commitRunner: container.commitRunner,
          dataDir: container.config.dataDir,
          reviewRequired: new Set(container.config.memory.reviewRequired),
          logger,
          concurrency: container.config.task.concurrency,
        }),
      },
    );
  } finally {
    await container.close();
  }
}

async function runWithConfig(
  config: ComemConfig,
  logger: Logger,
  harnesses: readonly IngestHarness[] | undefined,
  options: IngestCommandOptions,
  dryRun: boolean,
  writers?: Pick<IngestServiceOptions, 'sessions' | 'cursors' | 'extraction'>,
): Promise<IngestReport> {
  const readOnly = dryRun ? openReadOnlyCursors(config.dataDir, logger) : null;
  try {
    const sessions = writers?.sessions;
    const cursors = writers?.cursors ?? readOnly?.cursors;
    const extraction = writers?.extraction;
    // 没有可用模型时阶段二注定失败：每个会话的任务都会停在 `DisabledLlmProvider`。
    // 阶段一（归档）不依赖模型，所以降级成「只归档」并把原因写进报告，而不是让
    // 1,076 个会话各失败一次、也不是拒绝整个命令——「先导数据、后配模型」合法。
    const extractionSkip =
      config.providers.llm.default.type === 'disabled'
        ? ('llm_disabled' as const)
        : undefined;
    const service = new IngestService({
      sources: createSources(config, logger),
      scopeUri: scopeUriOf(config.server.subject),
      principals: [config.server.subject, USER_WILDCARD],
      logger,
      batchSize: config.ingest.batchSize,
      extractionBatchSize: config.ingest.extractionBatchSize,
      extractionTimeoutMs: config.ingest.extractionTimeoutMs,
      ...(sessions === undefined ? {} : { sessions }),
      ...(cursors === undefined ? {} : { cursors }),
      ...(extraction === undefined ? {} : { extraction }),
      ...(extractionSkip === undefined ? {} : { extractionSkip }),
    });

    return await service.run({
      ...(harnesses === undefined ? {} : { harnesses }),
      dryRun,
      ...(options.waitForExtraction === undefined
        ? {}
        : { waitForExtraction: options.waitForExtraction }),
      ...(options.extractionTimeoutMs === undefined
        ? {}
        : { extractionTimeoutMs: options.extractionTimeoutMs }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.limitPerSession === undefined
        ? {}
        : { limitPerSession: options.limitPerSession }),
    });
  } finally {
    readOnly?.db.close();
  }
}

/** 只有直接执行（`tsx src/commands/ingest.ts`）时才跑 CLI 入口，测试 import 不触发。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const options = { ...parseArgs(argv), argv };
  runIngest(options).then(
    (report) => {
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(renderReport(report, options.dryRun ?? false));
      }
      if (report.harnesses.some((source) => source.failed > 0)) {
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      process.stderr.write(`ingest 失败：${comemErrorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
