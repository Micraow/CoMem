import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import hookEventNames from '../../../integrations/lib/events.json';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider } from '../../../src/adapters/llm/fake-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { RequestLogRepository } from '../../../src/adapters/sqlite/request-log-repository.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { LlmService, type LlmCallStats } from '../../../src/services/llm.js';
import {
  ObservabilityService,
  type HookOverheadReport,
  type ObservabilityServiceDeps,
  type RequestLogEntry,
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
let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let metadata: MetadataFileStore;
let requestLog: RequestLogRepository;
let llm: LlmService;
let service: ObservabilityService;

/** `request_log` 的行数；`count` 已删，测试直接查表。 */
function requestRows(): number {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM request_log').get()?.['total'] ?? 0);
}

/** 一次请求的默认入参；只覆盖用例关心的字段。 */
function requestEntry(
  requestId: string,
  overrides: Partial<Omit<RequestLogEntry, 'requestId'>> = {},
): RequestLogEntry {
  return {
    requestId,
    method: 'GET',
    path: '/health',
    statusCode: 200,
    durationMs: 1,
    errorCode: null,
    subject: null,
    ...overrides,
  };
}

/** `request_log.phases` 反序列化；没有这一行或 NULL 时返回 `null`。 */
function phasesOf(requestId: string): Record<string, number> | null {
  const raw = db.prepare('SELECT phases FROM request_log WHERE request_id = ?').get(requestId)?.['phases'];
  if (typeof raw !== 'string') {
    return null;
  }
  return JSON.parse(raw) as Record<string, number>;
}

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

function createService(overrides: Partial<ObservabilityServiceDeps> = {}): ObservabilityService {
  return new ObservabilityService({
    requestLog,
    db,
    metadata,
    llm,
    // 默认没有任何画像：健康度里的 profileFormat 全 0，与空库语义一致。
    profileBodies: { readContent: async () => null },
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
  /** `node.memory_type`；普通文档为 `null` */
  readonly memoryType?: string | null;
}

function insertNode(seed: NodeSeed): void {
  const parent = seed.uri.slice(0, seed.uri.lastIndexOf('/'));
  db.prepare(
    `INSERT INTO node
       (uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
        body_digest, size, updated_at, status, summary_pending)
     VALUES (?, ?, 'user', ?, 'memory', ?, 'L2', NULL, 'digest', 1, ?, ?, ?)`,
  ).run(
    seed.uri,
    parent,
    seed.kind,
    seed.memoryType ?? null,
    seed.updatedAt,
    seed.status,
    seed.summaryPending ?? 0,
  );
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

describe('phase / 归因（通过 recordRequest 观察）', () => {
  it('同名阶段累加：request_log.phases 是两条 recall 之和', async () => {
    await inScope(async () => {
      await service.phase('recall', async () => {
        await sleep(5);
      });
      await service.phase('recall', async () => {
        await sleep(1);
      });
      await service.recordRequest(requestEntry('req_1', { durationMs: 104 }));
    });

    const phases = phasesOf('req_1');
    expect(phases?.['recall']).toBeGreaterThanOrEqual(6);
    // 总耗时 104ms 大于阶段之和：差额是未归因间隙，不是错误信号。
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('作用域外调 phase() 丢弃并记一条 warn', async () => {
    // 没有 `withRequestScope` 包住：阶段无处可记。静默丢弃会让「为什么 phases 是
    // NULL」变成要读实现才能回答的问题。
    await service.phase('recall', async () => {
      await sleep(1);
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('不在请求作用域'),
      expect.objectContaining({ phase: 'recall' }),
    );

    // 后台阶段是例外：它记进程级 gauge（`#asyncPhases`），不需要作用域，也不该 warn。
    await service.phase('archive', async () => {
      await sleep(1);
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('阶段之和不超过测量总耗时时不告警（§20 的验收点）', async () => {
    await inScope(async () => {
      for (const name of BLOCKING) {
        await service.phase(name, async () => {
          await sleep(1);
        });
      }
      // 外部量到的总耗时远大于阶段之和：身份解析、路由、响应编码没有计时。
      await service.recordRequest(requestEntry('req_2', { durationMs: 1000 }));
    });

    const phases = phasesOf('req_2');
    const sum = BLOCKING.reduce((total, name) => total + (phases?.[name] ?? 0), 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(1000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('阶段之和超过总耗时超过容差时记 warn，但不抛错', async () => {
    await inScope(async () => {
      await service.phase('recall', async () => {
        await sleep(2);
      });
      // 总耗时 0ms，阶段之和 ≥2ms：同一段被套了两层 `phase()`，或者读到的是别
      // 的请求的账。观测代码不该让请求失败，所以只记 warn。
      await service.recordRequest(requestEntry('req_3', { durationMs: 0 }));
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('超过请求总耗时'),
      expect.objectContaining({ requestId: 'req_3' }),
    );
  });

  it('后台阶段只在进程级记账，不写进请求的 phases', async () => {
    // `archive` 不在请求作用域里也不 warn；它是进程级 gauge（§17.2 的后台阶段）。
    await service.phase('archive', async () => {
      await sleep(1);
    });
    await inScope(async () => {
      await service.phase('recall', async () => {
        await sleep(1);
      });
      await service.recordRequest(requestEntry('req_async', { durationMs: 100 }));
    });

    expect(Object.keys(phasesOf('req_async') ?? {})).toEqual(['recall']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('attribute 是内部实现，不出现在公开面', () => {
    // 它只服务同类 `recordRequest`；留在原型上会诱使调用方绕过 `request_log`
    // 直接读阶段账，而那个账在请求结束时已经随作用域丢弃。
    expect(Object.getOwnPropertyNames(ObservabilityService.prototype)).not.toContain('attribute');
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
    // 后台耗时按 `phase` 上报：`#asyncPhases` 是进程级的「每个阶段最近一次」，
    // 不属于任何一次 hook 上报，所以不能再带 `event` 标签。
    expect(text).toMatch(/comem_hook_async_seconds\{phase="archive"\} 0\.0/);
    expect(text).not.toContain('comem_hook_async_seconds{event=');
    expect(text).toContain('comem_index_nodes 0');
    expect(text).toContain('comem_pending_review 0');
    expect(text).toContain('comem_llm_tokens_total{kind="prompt"} 0');
    expect(text).toContain('comem_llm_tokens_total{kind="completion"} 0');
    // 这一份服务配了单价（`pricing`），所以 0 是真实累加值，不是默认值。
    expect(text).toContain('comem_llm_cost_usd_total 0');
    expect(text).toContain('comem_llm_pricing_configured 1');
  });

  it('后台耗时按阶段各自计算：不同 phase 的值不是同一份快照', async () => {
    // 值来自 `#asyncPhases` 里**该阶段自己**的最近一次耗时。以前它被复制进「刚上
    // 报的那个事件」，同一个数字被贴到每个 event 上——那不是维度，是噪音。
    await service.phase('archive', async () => {
      await sleep(30);
    });
    await service.phase('extract', async () => {});

    const text = service.renderMetrics();
    const valueOf = (phase: string): number => {
      const match = new RegExp(
        `comem_hook_async_seconds\\{phase="${phase}"\\} ([0-9.eE+-]+)`,
      ).exec(text);
      return match === null ? Number.NaN : Number(match[1]);
    };

    // 30ms 与 0ms 差一个数量级，机器负载不会把顺序翻过来。
    expect(valueOf('archive')).toBeGreaterThan(0.02);
    expect(valueOf('extract')).toBeLessThan(0.01);
  });

  it('未知事件归成 other，sessionId 不进标签（§17.1 的低基数要求）', async () => {
    await service.recordHookOverhead(hookReport({ event: 'some_unknown_event', sessionId: 'sess_secret' }));

    const text = service.renderMetrics();

    expect(text).toContain('comem_hook_overhead_total_seconds{event="other"} 0.142');
    expect(text).not.toContain('sess_secret');
    expect(text).not.toContain('some_unknown_event');
  });
});

describe('hook 事件名契约', () => {
  /**
   * 上报方的事件名表（`integrations/lib/events.json`，hook 侧唯一的常量表）。
   *
   * 断言从这张表读键，不手写事件名：手写的话，以后加一个事件、只改上报方、忘了
   * 改这里，测试仍然是绿的——那正是「所有样本塌进 other」那个缺陷的成因。加事件
   * 的一方必须同时改 `HOOK_EVENTS`（本文件所在的服务的白名单）。
   *
   * `reportsOverhead` 区分了「宿主会调用」与「会出现在 `/metrics`」两个集合；
   * 白名单只接受后者，所以两个方向都要断言。
   */
  const table = Object.entries(hookEventNames);
  const reported = table.filter(([, entry]) => entry.reportsOverhead).map(([name]) => name);
  const unreported = table.filter(([, entry]) => !entry.reportsOverhead).map(([name]) => name);

  it('有上报点的每个事件名都原样成为 event 标签，不塌进 other', async () => {
    for (const name of reported) {
      await service.recordHookOverhead(hookReport({ event: name }));
    }

    const text = service.renderMetrics();

    for (const name of reported) {
      expect(text).toContain(`comem_hook_overhead_total_seconds{event="${name}"} 0.142`);
    }
    // 一个 `other` 都不该有：它只接收真正未知的事件名。
    expect(text).not.toContain('event="other"');
  });

  it('没有上报点的事件名不进白名单：不留永远没有样本的事件名', async () => {
    // 目前只有 `pre_tool_use`：`PreToolUse` 刻意不发 HTTP，所以它永远不会有样本。
    // 留在白名单里会多一条永远空的时间序列，控制台上也会多一个「看起来没发生」的行。
    expect(unreported).toEqual(['pre_tool_use']);

    for (const name of unreported) {
      await service.recordHookOverhead(hookReport({ event: name }));
    }

    const text = service.renderMetrics();

    expect(text).not.toContain('event="pre_tool_use"');
    expect(text).toContain('comem_hook_overhead_total_seconds{event="other"} 0.142');
  });

  it('不接受宿主侧的 PascalCase：两套命名不共存', async () => {
    // 服务端不加「PascalCase 也接受」的兼容表。真需要兼容时先决定哪一侧是权威
    // 的一方，而不是让两套名字长期并存。
    await service.recordHookOverhead(hookReport({ event: 'SessionStart' }));

    const text = service.renderMetrics();

    expect(text).toContain('comem_hook_overhead_total_seconds{event="other"} 0.142');
    expect(text).not.toContain('event="SessionStart"');
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

    const rows = db
      .prepare(
        `SELECT request_id, method, path, status_code, duration_ms, error_code, subject,
                created_at, phases
           FROM request_log ORDER BY created_at DESC LIMIT 10`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: 'req_1',
      method: 'POST',
      path: '/api/v1/search/find',
      status_code: 200,
      duration_ms: 104,
      error_code: null,
      subject: 'alice',
      created_at: NOW.toISOString(),
    });
    expect(JSON.parse(String(rows[0]?.['phases']))).toEqual({ recall: expect.any(Number) });
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
    // 的阶段。`request_log.phases` 是「这一轮花了多少」的唯一证据，混了就没有意义。
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

    await Promise.all([
      inScope(async () => {
        await service.phase('recall', async () => {
          await sleep(2);
        });
        await service.recordRequest(requestEntry('req_a', { durationMs: 100 }));
      }),
      inScope(async () => {
        await service.phase('capture', async () => {
          await sleep(2);
        });
        await service.recordRequest(requestEntry('req_b', { durationMs: 100 }));
      }),
    ]);

    expect(Object.keys(phasesOf('req_a') ?? {})).toEqual(['recall']);
    expect(Object.keys(phasesOf('req_b') ?? {})).toEqual(['capture']);
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
    expect(requestRows()).toBe(0);

    await sampled.recordRequest({ ...entry, requestId: 'req_error', statusCode: 500 });
    expect(requestRows()).toBe(1);
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

    expect(requestRows()).toBe(0);
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
      profileFormat: { checked: 0, invalid: 0, violations: 0, truncated: false },
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
      profileFormat: { checked: 0, invalid: 0, violations: 0, truncated: false },
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

describe('profileFormatHealth（§11.1）', () => {
  it('合规与不合规画像分别计数，非画像节点不参与', async () => {
    insertNode({
      uri: `${SCOPE_ROOT}/memories/profile`,
      kind: 'document',
      status: 'active',
      updatedAt: NOW.toISOString(),
      memoryType: 'profile',
    });
    insertNode({
      uri: `${SCOPE_ROOT}/projects/p/memories/profile`,
      kind: 'document',
      status: 'active',
      updatedAt: NOW.toISOString(),
      memoryType: 'profile',
    });
    insertNode({
      uri: `${SCOPE_ROOT}/memories/preferences/style`,
      kind: 'document',
      status: 'active',
      updatedAt: NOW.toISOString(),
      memoryType: 'preferences',
    });

    const bodies = new Map<string, string>([
      [`${SCOPE_ROOT}/memories/profile`, '- 后端工程师 (as of 2026-11-09)'],
      [`${SCOPE_ROOT}/projects/p/memories/profile`, '# 标题\n这是一段散文。'],
    ]);
    const local = createService({
      profileBodies: {
        readContent: async (uri) => bodies.get(uri.toString()) ?? null,
      },
    });

    const health = await local.health();

    // 两份画像：一份合规、一份 2 条违规（标题 + 非 bullet）。
    expect(health.profileFormat).toEqual({
      checked: 2,
      invalid: 1,
      violations: 2,
      truncated: false,
    });
  });

  it('超过 200 份画像时截断，并记 warn 说明上限', async () => {
    db.exec('BEGIN');
    for (let index = 0; index <= 200; index += 1) {
      insertNode({
        uri: `${SCOPE_ROOT}/scope-${index}/memories/profile`,
        kind: 'document',
        status: 'active',
        updatedAt: NOW.toISOString(),
        memoryType: 'profile',
      });
    }
    db.exec('COMMIT');

    const local = createService({
      profileBodies: {
        readContent: async () => '- 后端工程师 (as of 2026-11-09)',
      },
    });

    // 唯一出口是 `health()`：这个方法不再对外公开，截断行为跟着健康度一起验。
    const format = (await local.health()).profileFormat;

    expect(format).toEqual({ checked: 200, invalid: 0, violations: 0, truncated: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('上限'),
      expect.objectContaining({ limit: 200 }),
    );
  });
});

describe('模型成本', () => {
  /** 只关心 `LlmCallStats` 的调用方；`llm` 依赖只要能给出 stats 即可。 */
  function serviceWith(stats: LlmCallStats): ObservabilityService {
    return createService({ llm: { stats } });
  }

  it('没配单价时不输出成本样本：未知不写成 0', () => {
    // pricing 没配时 `costUsd` 是 `null`（`services/llm.ts` 的 `costOf` 返回 null），
    // 但 `calls` 已经涨过——这正是「有调用、没单价」那个状态。
    const text = serviceWith({
      calls: 3,
      promptTokens: 30,
      completionTokens: 15,
      costUsd: null,
      truncated: 0,
      failed: 0,
    }).renderMetrics();

    expect(text).not.toContain('comem_llm_cost_usd_total');
    expect(text).toContain('comem_llm_pricing_configured 0');
    // token 计数照常：它不依赖单价。
    expect(text).toContain('comem_llm_tokens_total{kind="prompt"} 30');
  });

  it('配了单价但还一次没调用：成本是真实的 0，configured=1', () => {
    // `LlmService.emptyStats()` 在配了 pricing 时把 costUsd 初始化成 0（累加起点），
    // 没配时才是 null。所以 0 与「没有序列」的区别不是靠猜的。
    const text = serviceWith({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      truncated: 0,
      failed: 0,
    }).renderMetrics();

    expect(text).toContain('comem_llm_cost_usd_total 0');
    expect(text).toContain('comem_llm_pricing_configured 1');
  });

  it('配了单价且有过调用：输出累计成本与 configured=1', () => {
    const text = serviceWith({
      calls: 3,
      promptTokens: 30,
      completionTokens: 15,
      costUsd: 0.0125,
      truncated: 0,
      failed: 0,
    }).renderMetrics();

    expect(text).toContain('comem_llm_cost_usd_total 0.0125');
    expect(text).toContain('comem_llm_pricing_configured 1');
  });

  it('真实调用后 /metrics 反映同一份累加器', async () => {
    await llm.generate({ messages: [{ role: 'user', content: '你好' }] });

    const text = service.renderMetrics();
    expect(text).toContain('comem_llm_tokens_total{kind="prompt"} 10');
    expect(text).toContain('comem_llm_tokens_total{kind="completion"} 5');
    expect(text).toContain('comem_llm_cost_usd_total 0.00002');
    expect(text).toContain('comem_llm_pricing_configured 1');
  });
});
