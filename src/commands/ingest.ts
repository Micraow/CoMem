/**
 * `pnpm ingest` 命令（架构文档 §11.9）。
 *
 * ```bash
 * pnpm ingest --source claude-code
 * pnpm ingest --source all --dry-run
 * pnpm ingest --source codex --since 2026-08-01
 * pnpm ingest --source all --json
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
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { ConsoleLogger } from '../adapters/log/console.js';
import { openDatabase } from '../adapters/sqlite/database.js';
import { IngestCursorRepository } from '../adapters/sqlite/ingest-cursor-repository.js';
import { DEFAULT_SUBJECT } from '../api/http/middleware.js';
import { createContainer } from '../bootstrap/container.js';
import { loadConfig, type ComemConfig } from '../config/index.js';
import { ComemError } from '../domain/errors.js';
import type { IngestHarness } from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';
import { Uri } from '../domain/uri.js';
import { createSources, INGEST_HARNESSES, isIngestHarness } from '../ingest/registry.js';
import { IngestService, type IngestReport, type IngestServiceOptions } from '../services/ingest.js';

const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

export interface IngestCommandOptions {
  readonly configPath?: string;
  readonly dataDir?: string;
  /** `all` 或逗号分隔的宿主名 */
  readonly source?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly since?: string;
  readonly limitPerSession?: number;
}

function errorMessage(error: unknown): string {
  return ComemError.from(error).message;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = `--${name}`;
  for (const [index, arg] of argv.entries()) {
    if (arg === prefixed) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${prefixed}=`)) {
      return arg.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ComemError('INVALID_ARGUMENT', `${flag} 必须是正整数：${raw}`, { flag, value: raw });
  }
  return value;
}

function parseArgs(argv: readonly string[]): IngestCommandOptions {
  const source = readFlag(argv, 'source');
  const configPath = readFlag(argv, 'config');
  const dataDir = readFlag(argv, 'data-dir');
  const since = readFlag(argv, 'since');
  const limit = readFlag(argv, 'limit-per-session');
  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(source === undefined ? {} : { source }),
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limitPerSession: parsePositiveInteger(limit, '--limit-per-session') }),
    ...(argv.includes('--dry-run') ? { dryRun: true } : {}),
    ...(argv.includes('--json') ? { json: true } : {}),
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
 * 只读地打开游标表。数据库不存在、或还是 0011 之前的版本时返回 `null`
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

function renderReport(report: IngestReport, dryRun: boolean): string {
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
  return `${lines.join('\n')}\n`;
}

/**
 * 跑一次导入。返回报告；失败会计入报告，不抛错（除非参数或配置不合法）。
 *
 * `dryRun` 时 `sessions` 不注入——`IngestService` 一旦尝试写入就会明确报错，
 * 而不是静默写下去。
 */
export async function runIngest(options: IngestCommandOptions = {}): Promise<IngestReport> {
  const argv = [
    ...(options.configPath === undefined ? [] : ['--config', options.configPath]),
    ...(options.dataDir === undefined ? [] : ['--data-dir', options.dataDir]),
  ];
  const dryRun = options.dryRun ?? false;
  const harnesses = selectHarnesses(options.source);

  if (!dryRun) {
    // `createContainer` 自己加载配置；这里先读一遍是为了在写任何东西之前拒绝
    // 「默认关闭」的导入。容器启动会建库、建根目录，不校验就会先写后报错。
    const config = loadConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
      argv,
    });
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
    const config = loadConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
      argv,
    });
    return runWithConfig(config, logger, harnesses, options, dryRun);
  }

  // 容器的日志默认写 stdout；`--json` 时那会污染报告。压到 error 级别，报告与
  // 导入日志各走各的流。
  const container = await createContainer({ argv, env: { ...process.env, COMEM_LOGGING_LEVEL: 'error' } });
  try {
    return await runWithConfig(
      container.config,
      logger,
      harnesses,
      options,
      dryRun,
      {
        sessions: container.services.session,
        cursors: new IngestCursorRepository({ db: container.db, logger }),
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
  writers?: Pick<IngestServiceOptions, 'sessions' | 'cursors'>,
): Promise<IngestReport> {
  const readOnly = dryRun ? openReadOnlyCursors(config.dataDir, logger) : null;
  try {
    const sessions = writers?.sessions;
    const cursors = writers?.cursors ?? readOnly?.cursors;
    const service = new IngestService({
      sources: createSources(config, logger),
      scopeUri: scopeUriOf(DEFAULT_SUBJECT),
      logger,
      batchSize: config.ingest.batchSize,
      ...(sessions === undefined ? {} : { sessions }),
      ...(cursors === undefined ? {} : { cursors }),
    });

    return await service.run({
      ...(harnesses === undefined ? {} : { harnesses }),
      dryRun,
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
  const options = parseArgs(argv);
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
      process.stderr.write(`ingest 失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
