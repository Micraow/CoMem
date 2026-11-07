import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider } from '../../../src/adapters/llm/fake-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { RequestLogRepository } from '../../../src/adapters/sqlite/request-log-repository.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { LlmService } from '../../../src/services/llm.js';
import {
  ObservabilityService,
  type HookOverheadReport,
  type ObservabilityServiceDeps,
} from '../../../src/services/observability.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

const SCOPE_ROOT = 'comem://user/alice';
const DOCS = `${SCOPE_ROOT}/docs`;
const NOTES = `${SCOPE_ROOT}/notes`;
const DOC = `${DOCS}/architecture.md`;
const STALE = `${DOCS}/stale.md`;
const ACTIVE = `${DOCS}/active.md`;

/** §17.2 的四个阻塞阶段。 */
const BLOCKING = ['processStart', 'recall', 'serialize', 'capture'] as const;
/** §17.2 的后台阶段。 */
const ASYNC = ['archive', 'extract', 'merge', 'summary'] as const;

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let metadata: MetadataFileStore;
let requestLog: RequestLogRepository;
let llm: LlmService;
let service: ObservabilityService;

function createLogger(): Logger {
  const mock: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mock,
  };
  return mock;
}

function createService(overrides: Partial<ObservabilityServiceDeps> = {}): ObservabilityService {
  return new ObservabilityService({
    requestLog,
    db,
    metadata,
    llm,
    logger,
    now: () => NOW,
    ...overrides,
  });
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

interface NodeSeed {
  readonly uri: string;
  readonly kind: 'directory' | 'document';
  readonly status: 'active' | 'pending' | 'archived';
  readonly updatedAt: string;
  readonly summaryPending?: number;
}

function insertNode(seed: NodeSeed): void {
  const parent = seed.uri.slice(0, seed.uri.lastIndexOf('/'));
  db.prepare(
    `INSERT INTO node
       (uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
        body_digest, size, updated_at, status, summary_pending)
     VALUES (?, ?, 'user', ?, 'memory', NULL, 'L2', NULL, 'digest', 1, ?, ?, ?)`,
  ).run(seed.uri, parent, seed.kind, seed.updatedAt, seed.status, seed.summaryPending ?? 0);
}

interface TaskSeed {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  readonly leaseUntil: string | null;
}

function insertTask(seed: TaskSeed): void {
  db.prepare(
    `INSERT INTO task
       (id, type, status, payload, steps_done, attempts, lease_until, error, created_at, updated_at)
     VALUES (?, 'archive', ?, '{}', '[]', 0, ?, NULL, ?, ?)`,
  ).run(seed.id, seed.status, seed.leaseUntil, NOW.toISOString(), NOW.toISOString());
}

function hookReport(overrides: Partial<HookOverheadReport> = {}): HookOverheadReport {
  return {
    event: 'stop',
    sessionId: 'sess_7f3a',
    phases: { processStartMs: 38, recallMs: 104, serializeMs: 0, captureMs: 0 },
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-observability-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  metadata = new MetadataFileStore({ dataDir, logger });
  requestLog = new RequestLogRepository({ db, logger });
  llm = new LlmService({
    provider: new FakeLlmProvider([{ text: 'ok', usage: { promptTokens: 10, completionTokens: 5 } }]),
    logger,
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  });
  service = createService();
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * 阶段累加是**请求作用域**的（`AsyncLocalStorage`）。测试必须显式进 scope，
 * 否则 `phase()` 的耗时会被丢弃——这正是并发请求不互相污染的保证。
 */
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return service.withRequestScope(fn);
}

describe('phase / attribute', () => {
  it('同名阶段累加，accountedMs 等于阶段之和', async () => {
    const report = await inScope(async () => {
      await service.phase('recall', async () => {
        await sleep(5);
      });
      await service.phase('recall', async () => {
        await sleep(1);
      });
      return service.attribute('req_1');
    });

    expect(report.requestId).toBe('req_1');
    expect(report.phases['recall']).toBeGreaterThanOrEqual(5);
    expect(report.accountedMs).toBe(report.phases['recall'] ?? 0);
    expect(report.totalMs).toBe(report.accountedMs);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('四阶段相加等于总耗时（§20 的验收点）', async () => {
    const report = await inScope(async () => {
      for (const name of BLOCKING) {
        await service.phase(name, async () => {
          await sleep(1);
        });
      }
      return service.attribute('req_2');
    });
    const sum = BLOCKING.reduce((total, name) => total + (report.phases[name] ?? 0), 0);

    expect(report.accountedMs).toBe(sum);
    expect(Math.abs(report.totalMs - sum)).toBeLessThanOrEqual(0.5);
    expect(report.blockingMs).toBe(sum);
    expect(report.asyncMs).toBe(0);
  });

  it('超过 0.5ms 容差时记 warn，但不抛错', async () => {
    const report = await inScope(async () => {
      await service.phase('recall', async () => {});
      return service.attribute('req_3', 10);
    });

    expect(report.totalMs).toBe(10);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('不一致'),
      expect.objectContaining({ requestId: 'req_3', totalMs: 10 }),
    );

    // 容差以内不重复记：0.4ms 的偏差是浮点计时的正常范围。
    service.attribute('req_4', report.accountedMs + 0.4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('阻塞与异步分开统计（§17.2 的表格）', async () => {
    const report = await inScope(async () => {
      for (const name of [...BLOCKING, ...ASYNC]) {
        await service.phase(name, async () => {
          await sleep(1);
        });
      }
      return service.attribute('req_5');
    });
    const blocking = BLOCKING.reduce((total, name) => total + (report.phases[name] ?? 0), 0);
    const asyncMs = ASYNC.reduce((total, name) => total + (report.phases[name] ?? 0), 0);

    expect(report.blockingMs).toBe(blocking);
    expect(report.asyncMs).toBe(asyncMs);
    expect(report.blockingMs).toBeGreaterThan(0);
    expect(report.asyncMs).toBeGreaterThan(0);
    expect(report.blockingMs + report.asyncMs).toBe(report.accountedMs);
  });
});

describe('renderMetrics', () => {
  it('输出能被 Prometheus 文本格式解析，且指标齐全', async () => {
    await service.phase('archive', async () => {
      await sleep(1);
    });
    await service.recordHookOverhead(hookReport());
    await service.recordRequest({
      requestId: 'req_1',
      method: 'POST',
      path: '/api/v1/search/find',
      statusCode: 200,
      durationMs: 104,
      errorCode: null,
      subject: 'alice',
    });

    const text = service.renderMetrics();

    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) {
        continue;
      }
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? [0-9.eE+-]+$/);
    }

    expect(text).toContain('comem_http_request_duration_seconds_sum 0.104');
    expect(text).toContain('comem_http_request_duration_seconds_count 1');
    expect(text).toContain('comem_hook_overhead_seconds{event="stop",phase="process_start"} 0.038');
    expect(text).toContain('comem_hook_overhead_total_seconds{event="stop"} 0.142');
    expect(text).toMatch(/comem_hook_async_seconds\{event="stop"\} 0\.0/);
    expect(text).toContain('comem_index_nodes 0');
    expect(text).toContain('comem_pending_review 0');
    expect(text).toContain('comem_llm_tokens_total{kind="prompt"} 0');
    expect(text).toContain('comem_llm_tokens_total{kind="completion"} 0');
    expect(text).toContain('comem_llm_cost_usd_total 0');
  });

  it('未知事件归成 other，sessionId 不进标签（§17.1 的低基数要求）', async () => {
    await service.recordHookOverhead(hookReport({ event: 'some_unknown_event', sessionId: 'sess_secret' }));

    const text = service.renderMetrics();

    expect(text).toContain('comem_hook_overhead_total_seconds{event="other"} 0.142');
    expect(text).not.toContain('sess_secret');
    expect(text).not.toContain('some_unknown_event');
  });
});

describe('recordRequest', () => {
  it('写 request_log 并打结构化日志', async () => {
    await inScope(async () => {
      await service.phase('recall', async () => {});
      await service.recordRequest({
        requestId: 'req_1',
        method: 'POST',
        path: '/api/v1/search/find',
        statusCode: 200,
        durationMs: 104,
        errorCode: null,
        subject: 'alice',
      });
    });

    const rows = requestLog.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: 'req_1',
      method: 'POST',
      path: '/api/v1/search/find',
      statusCode: 200,
      durationMs: 104,
      errorCode: null,
      subject: 'alice',
      createdAt: NOW.toISOString(),
    });
    expect(rows[0]?.phases).toEqual({ recall: expect.any(Number) });
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP 请求完成。',
      expect.objectContaining({ requestId: 'req_1', statusCode: 200 }),
    );
  });

  it('5xx 记 error、4xx 记 warn', async () => {
    const entry = {
      requestId: 'req_5xx',
      method: 'GET',
      path: '/api/v1/memories',
      statusCode: 500,
      durationMs: 1,
      errorCode: 'INTERNAL',
      subject: null,
    };
    await service.recordRequest(entry);
    await service.recordRequest({ ...entry, requestId: 'req_4xx', statusCode: 404 });

    expect(logger.error).toHaveBeenCalledWith(
      'HTTP 请求失败。',
      expect.objectContaining({ requestId: 'req_5xx' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'HTTP 请求被拒绝。',
      expect.objectContaining({ requestId: 'req_4xx' }),
    );
  });

  it('并发请求的阶段不互相污染', async () => {
    // 实例字段版本会让 A 的 recall 记到 B 的账上，recordRequest 还会清掉 A 没写完
    // 的阶段。归因报告是「这一轮花了多少」的唯一证据，混了就没有意义。
    await Promise.all([
      inScope(async () => {
        await service.phase('recall', async () => {
          await sleep(8);
        });
      }),
      inScope(async () => {
        await service.phase('serialize', async () => {
          await sleep(1);
        });
      }),
    ]);

    const [first, second] = await Promise.all([
      inScope(async () => {
        await service.phase('recall', async () => {
          await sleep(2);
        });
        return service.attribute('req_a');
      }),
      inScope(async () => {
        await service.phase('capture', async () => {
          await sleep(2);
        });
        return service.attribute('req_b');
      }),
    ]);

    expect(Object.keys(first.phases)).toEqual(['recall']);
    expect(Object.keys(second.phases)).toEqual(['capture']);
  });

  it('采样率 0 时成功请求不落库，错误请求永远全量', async () => {
    const sampled = createService({ requestLogPolicy: { enabled: true, sampleRate: 0 } });
    const entry = {
      requestId: 'req_ok',
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 1,
      errorCode: null,
      subject: null,
    };

    await sampled.recordRequest(entry);
    expect(requestLog.count()).toBe(0);

    await sampled.recordRequest({ ...entry, requestId: 'req_error', statusCode: 500 });
    expect(requestLog.count()).toBe(1);
  });

  it('enabled 为 false 时什么都不写', async () => {
    const disabled = createService({ requestLogPolicy: { enabled: false, sampleRate: 1 } });

    await disabled.recordRequest({
      requestId: 'req_1',
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 1,
      errorCode: null,
      subject: null,
    });

    expect(requestLog.count()).toBe(0);
  });
});

describe('health', () => {
  it('各字段按 §17.5 的口径统计', async () => {
    await metadata.writeSummary(Uri.parse(DOCS), '摘要', '概览', {
      generatedBy: 'rule',
      degraded: true,
    });
    await metadata.writeSummary(Uri.parse(NOTES), '摘要', '概览', {
      generatedBy: 'llm',
      degraded: false,
    });

    insertNode({ uri: DOCS, kind: 'directory', status: 'active', updatedAt: NOW.toISOString(), summaryPending: 1 });
    insertNode({ uri: NOTES, kind: 'directory', status: 'active', updatedAt: NOW.toISOString() });
    insertNode({ uri: DOC, kind: 'document', status: 'active', updatedAt: NOW.toISOString() });
    insertNode({ uri: STALE, kind: 'document', status: 'pending', updatedAt: '2026-11-07T22:00:00.000Z' });
    insertNode({ uri: ACTIVE, kind: 'document', status: 'pending', updatedAt: '2026-11-07T23:00:00.000Z' });

    insertTask({ id: 'task-running', status: 'running', leaseUntil: '2026-11-07T23:59:00.000Z' });
    insertTask({ id: 'task-future', status: 'running', leaseUntil: '2026-11-08T01:00:00.000Z' });
    insertTask({ id: 'task-pending', status: 'pending', leaseUntil: null });

    const health = await service.health();

    expect(health).toEqual({
      pendingReview: 2,
      staleSummaries: 1,
      degradedSummaries: 1,
      orphanTasks: 1,
      indexNodes: 5,
      // 最老的 pending 是 2026-11-07T22:00:00Z，距今 2 小时。
      oldestPendingAgeSeconds: 2 * 60 * 60,
    });
  });

  it('空库返回 0 与 null（「没有」不是 0 秒）', async () => {
    expect(await service.health()).toEqual({
      pendingReview: 0,
      staleSummaries: 0,
      degradedSummaries: 0,
      orphanTasks: 0,
      indexNodes: 0,
      oldestPendingAgeSeconds: null,
    });
  });

  it('目录超过 1000 个时记 warn，并只统计前 1000 个', async () => {
    db.exec('BEGIN');
    for (let index = 0; index <= 1000; index += 1) {
      insertNode({
        uri: `${SCOPE_ROOT}/dir-${index}`,
        kind: 'directory',
        status: 'active',
        updatedAt: NOW.toISOString(),
      });
    }
    db.exec('COMMIT');

    const health = await service.health();

    expect(health.indexNodes).toBe(1001);
    expect(health.degradedSummaries).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('上限'),
      expect.objectContaining({ limit: 1000 }),
    );
  });
});

describe('modelUsage', () => {
  it('返回 LlmService 的用量快照，并进 /metrics', async () => {
    await llm.generate({ messages: [{ role: 'user', content: '你好' }] });

    expect(service.modelUsage().stats).toMatchObject({
      calls: 1,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.00002,
    });

    const text = service.renderMetrics();
    expect(text).toContain('comem_llm_tokens_total{kind="prompt"} 10');
    expect(text).toContain('comem_llm_tokens_total{kind="completion"} 5');
    expect(text).toContain('comem_llm_cost_usd_total 0.00002');
  });
});
