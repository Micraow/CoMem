import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { LlmCallRepository } from '../../../src/adapters/sqlite/llm-call-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { LlmService } from '../../../src/services/llm.js';
import { runWithLlmCallContext } from '../../../src/services/observability/call-context.js';
import { LlmSummarizer } from '../../../src/services/summary.js';
import { FakeLlmProvider } from '../../helpers/fake-llm-provider.js';

let db: DatabaseSync;
let logger: Logger;
let repository: LlmCallRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  repository = new LlmCallRepository({ db, logger, enabled: true });
});

afterEach(() => {
  db.close();
});

function createService(responses: ConstructorParameters<typeof FakeLlmProvider>[0]): LlmService {
  return new LlmService({
    provider: new FakeLlmProvider(responses),
    logger,
    model: 'audit-model',
    pricing: { inputPerMillion: 2, outputPerMillion: 4 },
    retryBaseDelayMs: 0,
    callLog: repository,
  });
}

describe('LLM 调用持久化', () => {
  it('文本调用记录用途、关联、耗时、token 与成本，不保存 prompt', async () => {
    const service = createService([
      {
        text: 'sensitive-response',
        usage: { promptTokens: 10, completionTokens: 5 },
        delayMs: 5,
      },
    ]);

    await runWithLlmCallContext(
      { requestId: 'req_123', subject: 'user:alice', sessionId: 'sess_context' },
      () => service.generate(
        { messages: [{ role: 'user', content: 'very-secret-prompt' }] },
        { purpose: 'working_memory' },
      ),
    );

    const page = service.listCalls({ subject: 'user:alice' });
    expect(page.items).toEqual([
      expect.objectContaining({
        purpose: 'working_memory',
        kind: 'text',
        model: 'audit-model',
        status: 'success',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 40 / 1_000_000,
        attempts: 1,
        errorCode: null,
        requestId: 'req_123',
        sessionId: 'sess_context',
      }),
    ]);
    expect(page.items[0]?.durationMs).toBeGreaterThanOrEqual(4);
    expect(Date.parse(page.items[0]?.startedAt ?? '')).toBeLessThanOrEqual(
      Date.parse(page.items[0]?.endedAt ?? ''),
    );

    const raw = JSON.stringify(db.prepare('SELECT * FROM llm_call_log').all());
    expect(raw).not.toContain('very-secret-prompt');
    expect(raw).not.toContain('sensitive-response');
  });

  it('结构化调用记录精确 usage，不再把 token 与成本当成未知', async () => {
    const service = createService([
      {
        json: { ok: true },
        usage: { promptTokens: 7, completionTokens: 3 },
      },
    ]);

    const result = await runWithLlmCallContext(
      { requestId: 'req_json', subject: 'user:alice' },
      () => service.generateJson(
        { messages: [{ role: 'user', content: 'x' }] },
        z.object({ ok: z.boolean() }),
        { purpose: 'memory_extract', sessionId: 'sess_extract' },
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(service.listCalls({ subject: 'user:alice' }).items[0]).toMatchObject({
      purpose: 'memory_extract',
      kind: 'json',
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      costUsd: 26 / 1_000_000,
      sessionId: 'sess_extract',
    });
    expect(service.stats).toMatchObject({
      calls: 1,
      promptTokens: 7,
      completionTokens: 3,
    });
  });

  it('重试后成功只留一条逻辑记录，并记录尝试次数', async () => {
    const service = createService([
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商暂不可用。') },
      { text: 'ok', usage: { promptTokens: 1, completionTokens: 1 } },
    ]);

    await runWithLlmCallContext(
      { requestId: 'req_retry', subject: 'user:alice' },
      () => service.generate(
        { messages: [{ role: 'user', content: 'x' }] },
        { purpose: 'directory_summary' },
      ),
    );

    expect(service.listCalls({ subject: 'user:alice' }).items).toEqual([
      expect.objectContaining({
        status: 'success',
        attempts: 2,
        errorCode: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
    ]);
  });

  it('重试中的结构化解析错误带 usage 时，只在全部尝试可计量后汇总', async () => {
    const service = createService([
      {
        error: new ComemError('INVALID_ARGUMENT', '模型输出不符合 schema。', {
          usage: { promptTokens: 7, completionTokens: 2 },
        }),
      },
      {
        json: { ok: true },
        usage: { promptTokens: 3, completionTokens: 1 },
      },
    ]);

    await runWithLlmCallContext(
      { subject: 'user:alice' },
      () => service.generateJson(
        { messages: [{ role: 'user', content: 'x' }] },
        z.object({ ok: z.boolean() }),
        { purpose: 'memory_extract' },
      ),
    );

    expect(service.listCalls({ subject: 'user:alice' }).items[0]).toMatchObject({
      status: 'success',
      attempts: 2,
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
      costUsd: 32 / 1_000_000,
    });
  });

  it('最终失败记录稳定错误码且不保存错误正文', async () => {
    const service = createService([
      { error: new ComemError('UNAUTHENTICATED', 'secret provider detail') },
    ]);

    await expect(
      runWithLlmCallContext(
        { requestId: 'req_fail', subject: 'user:alice' },
        () => service.generate(
          { messages: [{ role: 'user', content: 'x' }] },
          { purpose: 'config_probe' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(service.listCalls({ subject: 'user:alice' }).items[0]).toMatchObject({
      status: 'error',
      errorCode: 'UNAUTHENTICATED',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    });
    const raw = JSON.stringify(db.prepare('SELECT * FROM llm_call_log').all());
    expect(raw).not.toContain('secret provider detail');
  });

  it('分页与主体过滤都在持久化层执行', async () => {
    const service = createService(
      Array.from({ length: 5 }, (_, index) => ({
        text: `ok-${String(index)}`,
        usage: { promptTokens: index + 1, completionTokens: 1 },
      })),
    );

    await runWithLlmCallContext(
      { subject: 'user:alice' },
      async () => {
        for (let index = 0; index < 4; index += 1) {
          await service.generate(
            { messages: [{ role: 'user', content: String(index) }] },
            { purpose: 'query_rewrite' },
          );
        }
      },
    );
    await runWithLlmCallContext(
      { subject: 'user:bob' },
      () => service.generate(
        { messages: [{ role: 'user', content: 'bob' }] },
        { purpose: 'query_rewrite' },
      ),
    );

    const first = service.listCalls({ subject: 'user:alice', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = service.listCalls({
      subject: 'user:alice',
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    expect(service.listCalls({ subject: 'user:bob' }).items).toHaveLength(1);
  });

  it('按时间和行数裁剪存在 SQLite，不依赖进程内存', () => {
    const row = (id: string, startedAt: string) => ({
      id,
      requestId: null,
      sessionId: null,
      subject: 'user:alice',
      purpose: 'query_rewrite' as const,
      kind: 'text' as const,
      model: 'audit-model',
      status: 'success' as const,
      startedAt,
      endedAt: startedAt,
      durationMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: null,
      errorCode: null,
      attempts: 1,
    });
    repository.insert(row('stale', '2026-11-01T00:00:00.000Z'));
    repository.insert(row('fresh-1', '2026-11-16T00:00:00.000Z'));
    repository.insert(row('fresh-2', '2026-11-17T00:00:00.000Z'));

    expect(
      repository.prune({
        retainDays: 7,
        retainRows: 1,
        now: new Date('2026-11-17T12:00:00.000Z'),
      }),
    ).toBe(2);
    const persisted = new LlmCallRepository({ db, logger, enabled: true });
    expect(persisted.list({ subject: 'user:alice', limit: 10 }).map(({ id }) => id)).toEqual([
      'fresh-2',
    ]);
  });

  it('无 HTTP/任务上下文的目录摘要仍按目录 owner 可查', async () => {
    const service = createService([{ text: '# 摘要\n正文', usage: { promptTokens: 2 } }]);
    const summarizer = new LlmSummarizer(service);

    await summarizer.generate({
      uri: Uri.parse('comem://user/alice/memories'),
      children: [],
    });

    expect(service.listCalls({ subject: 'user:alice' }).items[0]).toMatchObject({
      purpose: 'directory_summary',
      requestId: null,
      sessionId: null,
      status: 'success',
    });
  });

  it('开关关闭时只停止新增，已有记录仍可读取', () => {
    repository.insert({
      id: 'enabled-write',
      requestId: null,
      sessionId: null,
      subject: 'user:alice',
      purpose: 'working_memory',
      kind: 'text',
      model: 'audit-model',
      status: 'success',
      startedAt: '2026-11-17T00:00:00.000Z',
      endedAt: '2026-11-17T00:00:00.001Z',
      durationMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: null,
      errorCode: null,
      attempts: 1,
    });
    const disabled = new LlmCallRepository({ db, logger, enabled: false });
    disabled.insert({
      id: 'disabled-write',
      requestId: null,
      sessionId: null,
      subject: 'user:alice',
      purpose: 'config_probe',
      kind: 'text',
      model: 'audit-model',
      status: 'success',
      startedAt: '2026-11-17T00:00:00.000Z',
      endedAt: '2026-11-17T00:00:00.001Z',
      durationMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: null,
      errorCode: null,
      attempts: 1,
    });

    expect(disabled.list({ subject: 'user:alice', limit: 10 }).map(({ id }) => id)).toEqual([
      'enabled-write',
    ]);
  });
});
