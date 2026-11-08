import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import type { SummaryGeneration } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider } from '../../../src/adapters/llm/fake-provider.js';
import type { ArchiveMeta, MemoryDiff } from '../../../src/domain/archive.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { LlmOptions, LlmPrompt, LlmResult } from '../../../src/domain/llm.js';
import type { Logger } from '../../../src/domain/log.js';
import type { MemoryTypeSchema } from '../../../src/domain/memory-type.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { eventsMemoryType } from '../../../src/domain/memory-types/events.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import type { BatchOperation } from '../../../src/domain/merge-op.js';
import type { ContentPart, SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { StepContext } from '../../../src/services/commit/pipeline.js';
import { ArchiveSummaryStep } from '../../../src/services/commit/steps/archive-summary.js';
import {
  EXTRACT_RESULT_KEY,
  isMemoryExtractResult,
  MemoryExtractStep,
  type MemoryExtractResult,
} from '../../../src/services/commit/steps/memory-extract.js';
import {
  MemoryMergeStep,
  MERGE_RESULT_KEY,
  type MemoryMergeStepDeps,
} from '../../../src/services/commit/steps/memory-merge.js';
import { SummaryInvalidateStep } from '../../../src/services/commit/steps/summary-invalidate.js';
import { LlmService } from '../../../src/services/llm.js';
import { MemoryService, type MemoryRecord } from '../../../src/services/memory.js';

const SCOPE = 'comem://user/alice';
const ARCHIVE = `${SCOPE}/sessions/sess_1/history/archive_001`;
const CODE_STYLE = `${SCOPE}/memories/preferences/code-style.md`;
const UPDATED_AT = '2026-11-08T00:00:00.000Z';

let dataDir: string;
let store: ContentStore;
let logger: Logger;
let memory: MemoryService;
let writeSpy: Mock<(uri: Uri, text: string) => Promise<unknown>>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-steps-'));
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  writeSpy = vi.fn(async (uri: Uri, text: string) =>
    store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8'))),
  );
  memory = new MemoryService({
    filesystem: {
      read: async (uri) => ({ text: Buffer.from(await store.readBytes(uri)).toString('utf8') }),
      write: writeSpy,
      stat: (uri) => store.stat(uri),
      remove: (uri) => store.remove(uri),
      list: (uri) => store.list(uri),
    },
    search: { find: async () => [] },
    logger,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function createMeta(): ArchiveMeta {
  return {
    archiveId: 'archive_001',
    phase1: {
      status: 'ready',
      messagesSha256: 'sha',
      archivedMessageIds: [],
      retainedMessageIds: [],
    },
    stepsDone: [],
    skippedSteps: [],
    taskId: 'task_1',
  };
}

function createContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    archiveUri: Uri.parse(ARCHIVE),
    scopeUri: Uri.parse(SCOPE),
    messages: [],
    meta: createMeta(),
    latestArchiveOverview: null,
    state: new Map<string, unknown>(),
    markStepDone: async () => undefined,
    ...overrides,
  };
}

function message(id: string, role: SessionMessage['role'], parts: readonly ContentPart[]): SessionMessage {
  return { id, role, parts, createdAt: '2026-11-08T00:00:00.000Z', turn: 1 };
}

function record(uri: string, memoryType: string, fields: Record<string, unknown>): MemoryRecord {
  return { uri: Uri.parse(uri), memoryType, fields, status: 'active', updatedAt: UPDATED_AT };
}

/** 抽取步骤的端口替身：按记忆类型返回预置的「已读记忆」。 */
class FakeMemoryPort {
  readonly calls: { memoryType: string; query: string; topN: number }[] = [];
  readonly pages = new Map<string, MemoryRecord[]>();

  async prefetch(
    _scopeUri: Uri,
    schema: MemoryTypeSchema,
    query: string,
    topN: number,
  ): Promise<readonly MemoryRecord[]> {
    this.calls.push({ memoryType: schema.type, query, topN });
    return this.pages.get(schema.type) ?? [];
  }
}

function createExtractStep(
  provider: FakeLlmProvider,
  options: { readonly prefetchTopN?: number } = {},
): { readonly step: MemoryExtractStep; readonly fakeMemory: FakeMemoryPort } {
  const llm = new LlmService({ provider, logger, retryBaseDelayMs: 0 });
  const fakeMemory = new FakeMemoryPort();
  const step = new MemoryExtractStep({
    memory: fakeMemory,
    llm,
    logger,
    ...(options.prefetchTopN === undefined ? {} : { prefetchTopN: options.prefetchTopN }),
  });
  return { step, fakeMemory };
}

function extracted(context: StepContext): MemoryExtractResult {
  const value = context.state.get(EXTRACT_RESULT_KEY);
  if (!isMemoryExtractResult(value)) {
    throw new Error('state 里没有抽取结果');
  }
  return value;
}

describe('ArchiveSummaryStep', () => {
  it('工作记忆关闭时只重建归档目录摘要', async () => {
    const regenerate = vi.fn<(rootUri: Uri) => Promise<string[]>>(async () => [ARCHIVE]);
    const generate = vi.fn();
    const writeSummary = vi.fn();
    const step = new ArchiveSummaryStep({
      summary: { regenerate },
      llm: { generate },
      metadata: { writeSummary },
      workingMemory: { enabled: false },
      logger,
    });

    await step.run(createContext());

    expect(regenerate).toHaveBeenCalledWith(Uri.parse(ARCHIVE));
    expect(generate).not.toHaveBeenCalled();
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it('开启工作记忆时生成 7 段并写归档目录的 .overview.md', async () => {
    const overview = [
      '# 会话工作记忆',
      '',
      '**一行概述**：代码风格 | 定下严格模式 | 已完成',
      '',
      '## 分析',
      '',
      '无',
      '',
      '## 主要请求与意图',
      '',
      '无',
      '',
      '## 关键概念',
      '',
      '无',
      '',
      '## 待办',
      '',
      '无',
      '',
      '## 背景约束',
      '',
      '无',
      '',
      '## 相关上下文',
      '',
      '无',
    ].join('\n');
    const regenerate = vi.fn<(rootUri: Uri) => Promise<string[]>>(async () => [ARCHIVE]);
    const generate = vi.fn<(prompt: LlmPrompt, options?: LlmOptions) => Promise<LlmResult>>(
      async () => ({
        text: overview,
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
      }),
    );
    const writeSummary = vi.fn<
      (
        directoryUri: Uri,
        abstract: string,
        overview: string,
        generation: SummaryGeneration,
      ) => Promise<void>
    >(async () => undefined);
    const step = new ArchiveSummaryStep({
      summary: { regenerate },
      llm: { generate },
      metadata: { writeSummary },
      workingMemory: { enabled: true },
      logger,
    });

    await step.run(
      createContext({
        messages: [message('m1', 'user', [{ kind: 'text', text: '记住代码风格' }])],
        latestArchiveOverview: '# 上次',
      }),
    );

    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0]?.[0];
    expect(prompt?.messages[0]?.content).toContain('# 上次');
    expect(prompt?.messages[0]?.content).toContain('记住代码风格');

    const call = writeSummary.mock.calls[0];
    expect(call?.[0].toString()).toBe(ARCHIVE);
    expect(call?.[1]).toBe('**一行概述**：代码风格 | 定下严格模式 | 已完成');
    expect(call?.[2]).toBe(overview);
    expect(call?.[3]).toMatchObject({ generatedBy: 'llm', degraded: false });
  });

  it('工作记忆为空时抛 PROVIDER_UNAVAILABLE', async () => {
    const step = new ArchiveSummaryStep({
      summary: { regenerate: async () => [] },
      llm: {
        generate: async () => ({
          text: '   ',
          usage: { promptTokens: 0, completionTokens: 0 },
          finishReason: 'stop',
        }),
      },
      metadata: { writeSummary: async () => undefined },
      workingMemory: { enabled: true },
      logger,
    });

    await expect(step.run(createContext())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});

describe('MemoryExtractStep', () => {
  it('把预取记忆编号成 page_id，并把输出解析回 URI', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 1,
              type: 'preferences',
              identity: { topic: 'code-style' },
              operations: [
                {
                  kind: 'patch',
                  field: 'content',
                  blocks: [{ search: 'TypeScript', replace: 'TypeScript 严格模式' }],
                },
              ],
            },
          ],
        },
      },
    ]);
    const { step, fakeMemory } = createExtractStep(provider, { prefetchTopN: 3 });
    fakeMemory.pages.set('preferences', [
      record(CODE_STYLE, 'preferences', { topic: 'code-style', content: '偏好 TypeScript' }),
    ]);

    const context = createContext({
      messages: [message('m1', 'user', [{ kind: 'text', text: '我偏好 TypeScript 严格模式' }])],
    });
    await step.run(context);

    expect(fakeMemory.calls).toHaveLength(8);
    expect(fakeMemory.calls[0]).toMatchObject({ query: '我偏好 TypeScript 严格模式', topN: 3 });

    const result = extracted(context);
    expect(result.operations).toEqual([
      {
        kind: 'upsert',
        uri: CODE_STYLE,
        operation: {
          kind: 'patch',
          field: 'content',
          blocks: [{ search: 'TypeScript', replace: 'TypeScript 严格模式' }],
        },
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.memoryTypes.get(CODE_STYLE)).toBe('preferences');
  });

  it('新建项 pageId >= 100 时按 identity 生成新 URI', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 100,
              type: 'preferences',
              identity: { topic: 'new-topic' },
              operations: [{ kind: 'replace', field: 'content', value: '新内容' }],
            },
          ],
        },
      },
    ]);
    const { step } = createExtractStep(provider);
    const context = createContext();
    await step.run(context);

    // 新建项的 identity 也以 `replace` 操作插到最前面，合并步骤拿到的是完整字段。
    expect(extracted(context).operations).toEqual([
      {
        kind: 'upsert',
        uri: `${SCOPE}/memories/preferences/new-topic.md`,
        operation: { kind: 'replace', field: 'topic', value: 'new-topic' },
      },
      {
        kind: 'upsert',
        uri: `${SCOPE}/memories/preferences/new-topic.md`,
        operation: { kind: 'replace', field: 'content', value: '新内容' },
      },
    ]);
  });

  it('引用没有读过的编号时整条进 skipped，不抛错', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 7,
              type: 'preferences',
              identity: { topic: 'ghost' },
              operations: [{ kind: 'replace', field: 'content', value: 'x' }],
            },
            { kind: 'delete', pageId: 9 },
          ],
        },
      },
    ]);
    const { step } = createExtractStep(provider);
    const context = createContext();
    await step.run(context);

    const result = extracted(context);
    expect(result.operations).toEqual([]);
    expect(result.skipped.map((item) => item.reasonCode)).toEqual(['unknown_page', 'unknown_page']);
  });

  it('未知记忆类型进 skipped', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 100,
              type: 'not-a-memory-type',
              identity: { topic: 'x' },
              operations: [{ kind: 'replace', field: 'content', value: 'x' }],
            },
          ],
        },
      },
    ]);
    const { step } = createExtractStep(provider);
    const context = createContext();
    await step.run(context);

    expect(extracted(context).skipped[0]?.reasonCode).toBe('unknown_memory_type');
  });

  it('字段名不在 schema 里进 skipped', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 100,
              type: 'preferences',
              identity: { topic: 'x' },
              operations: [{ kind: 'replace', field: 'nope', value: 'x' }],
            },
          ],
        },
      },
    ]);
    const { step } = createExtractStep(provider);
    const context = createContext();
    await step.run(context);

    expect(extracted(context).skipped[0]?.reasonCode).toBe('unknown_field');
    expect(extracted(context).operations).toEqual([]);
  });

  it('没有字段操作进 skipped', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            { kind: 'upsert', pageId: 100, type: 'preferences', identity: { topic: 'x' }, operations: [] },
          ],
        },
      },
    ]);
    const { step } = createExtractStep(provider);
    const context = createContext();
    await step.run(context);

    expect(extracted(context).skipped[0]?.reasonCode).toBe('empty_operations');
  });

  it('identity 推出的路径与已读 page 不一致时进 skipped', async () => {
    const provider = new FakeLlmProvider([
      {
        json: {
          operations: [
            {
              kind: 'upsert',
              pageId: 1,
              type: 'preferences',
              identity: { topic: 'another-topic' },
              operations: [{ kind: 'replace', field: 'content', value: 'x' }],
            },
          ],
        },
      },
    ]);
    const { step, fakeMemory } = createExtractStep(provider);
    fakeMemory.pages.set('preferences', [
      record(CODE_STYLE, 'preferences', { topic: 'code-style', content: 'x' }),
    ]);
    const context = createContext();
    await step.run(context);

    expect(extracted(context).skipped[0]?.reasonCode).toBe('page_mismatch');
  });

  it('用户记忆抽取默认隐藏工具输出（§10.1）', async () => {
    const provider = new FakeLlmProvider([{ json: { operations: [] } }]);
    const { step } = createExtractStep(provider);
    const context = createContext({
      messages: [
        message('m1', 'user', [{ kind: 'text', text: '这条要保留' }]),
        message('m2', 'assistant', [
          { kind: 'tool_use', toolUseId: 'call_1', name: 'read', input: { path: '/etc/passwd' } },
        ]),
        message('m3', 'tool', [
          { kind: 'tool_result', toolUseId: 'call_1', output: 'TOKEN=secret-token', isError: false },
        ]),
      ],
    });

    await step.run(context);

    const rendered =
      provider.calls[0]?.prompt.messages.map((item) => item.content).join('\n') ?? '';
    expect(rendered).toContain('这条要保留');
    expect(rendered).not.toContain('secret-token');
    expect(rendered).not.toContain('/etc/passwd');
    expect(rendered).not.toContain('[tool_use');
    expect(rendered).not.toContain('[tool_result');
  });

  it('输出解析失败只重试一次，第二次仍失败抛 INVALID_ARGUMENT', async () => {
    const provider = new FakeLlmProvider([
      { json: { operations: '不是数组' } },
      { json: { operations: '仍然不是数组' } },
    ]);
    const { step } = createExtractStep(provider);

    await expect(step.run(createContext())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.calls).toHaveLength(2);
  });

  it('截断（finishReason === length）不重试：只调一次模型', async () => {
    // `generate` 路径（§11.4 的截断判定在 LlmService 里）。`generateJson` 的
    // 截断会被适配器映射成解析失败，见报告的「不确定」一节。
    const provider = new FakeLlmProvider([{ text: '半句', finishReason: 'length' }]);
    const llm = new LlmService({ provider, logger, retryBaseDelayMs: 0 });

    await expect(
      llm.generate({ messages: [{ role: 'user', content: '抽一下' }] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(provider.calls).toHaveLength(1);
  });
});

function createMergeStep(
  memoryOverride: Partial<MemoryMergeStepDeps['memory']> = {},
): {
  readonly step: MemoryMergeStep;
  readonly writeMemoryDiff: Mock<(archiveUri: Uri, diff: MemoryDiff) => Promise<void>>;
  readonly diffs: MemoryDiff[];
} {
  const diffs: MemoryDiff[] = [];
  const writeMemoryDiff = vi.fn(async (_archiveUri: Uri, diff: MemoryDiff) => {
    diffs.push(diff);
  });
  const step = new MemoryMergeStep({
    memory: {
      read: (uri) => memory.read(uri),
      upsertMemory: (scopeUri, schema, values) => memory.upsertMemory(scopeUri, schema, values),
      remove: (uri) => memory.remove(uri),
      ...memoryOverride,
    },
    archive: { writeMemoryDiff },
    logger,
  });
  return { step, writeMemoryDiff, diffs };
}

function mergeContext(
  operations: readonly BatchOperation[],
  memoryTypes: readonly (readonly [string, string])[],
  skipped: MemoryExtractResult['skipped'] = [],
): StepContext {
  const result: MemoryExtractResult = { operations, skipped, memoryTypes: new Map(memoryTypes) };
  return createContext({ state: new Map([[EXTRACT_RESULT_KEY, result]]) });
}

describe('MemoryMergeStep', () => {
  it('同 URI 的 5 条 patch 合并成一次写', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: 'l1\nl2\nl3\nl4\nl5',
    });
    writeSpy.mockClear();

    const operations: BatchOperation[] = ['l1', 'l2', 'l3', 'l4', 'l5'].map((line) => ({
      kind: 'upsert',
      uri: CODE_STYLE,
      operation: { kind: 'patch', field: 'content', blocks: [{ search: line, replace: `${line}-x` }] },
    }));

    const { step, diffs } = createMergeStep();
    await step.run(mergeContext(operations, [[CODE_STYLE, 'preferences']]));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect((await memory.read(Uri.parse(CODE_STYLE)))?.fields['content']).toBe(
      'l1-x\nl2-x\nl3-x\nl4-x\nl5-x',
    );
    expect(diffs[0]?.summary).toMatchObject({ totalAdds: 0, totalUpdates: 1, totalSkipped: 0 });
    expect(diffs[0]?.operations.updates[0]?.before).toBe('## content\n\nl1\nl2\nl3\nl4\nl5');
    expect(diffs[0]?.operations.updates[0]?.after).toBe(
      '## content\n\nl1-x\nl2-x\nl3-x\nl4-x\nl5-x',
    );
  });

  it('SEARCH 多命中时整条失败，且不影响同批次其它 URI', async () => {
    const dupUri = `${SCOPE}/memories/preferences/dup.md`;
    const goodUri = `${SCOPE}/memories/preferences/good.md`;
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'dup',
      content: 'a a',
    });
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'good',
      content: 'hello',
    });

    const operations: BatchOperation[] = [
      {
        kind: 'upsert',
        uri: dupUri,
        operation: { kind: 'patch', field: 'content', blocks: [{ search: 'a', replace: 'b' }] },
      },
      {
        kind: 'upsert',
        uri: goodUri,
        operation: {
          kind: 'patch',
          field: 'content',
          blocks: [{ search: 'hello', replace: 'hi' }],
        },
      },
    ];

    const { step, diffs } = createMergeStep();
    await step.run(mergeContext(operations, [[dupUri, 'preferences'], [goodUri, 'preferences']]));

    expect((await memory.read(Uri.parse(dupUri)))?.fields['content']).toBe('a a');
    expect((await memory.read(Uri.parse(goodUri)))?.fields['content']).toBe('hi');
    expect(diffs[0]?.skippedOperations[0]?.reasonCode).toBe('patch_ambiguous');
    expect(diffs[0]?.summary).toMatchObject({ totalUpdates: 1, totalSkipped: 1 });
  });

  it('addOnly 类型目标已存在时降级成跳过，同批其它 URI 照常写入', async () => {
    const eventUri = `${SCOPE}/memories/events/2026-11-08-conflict.md`;
    await memory.upsertMemory(Uri.parse(SCOPE), eventsMemoryType, {
      event: '2026-11-08-conflict',
      content: '第一条事件。',
      occurredAt: '2026-11-08T00:00:00.000Z',
    });
    const before = await memory.read(Uri.parse(eventUri));

    const operations: BatchOperation[] = [
      {
        kind: 'upsert',
        uri: eventUri,
        operation: { kind: 'replace', field: 'event', value: '2026-11-08-conflict' },
      },
      {
        kind: 'upsert',
        uri: eventUri,
        operation: { kind: 'replace', field: 'content', value: '另一条事件。' },
      },
      {
        kind: 'upsert',
        uri: CODE_STYLE,
        operation: { kind: 'replace', field: 'topic', value: 'code-style' },
      },
      {
        kind: 'upsert',
        uri: CODE_STYLE,
        operation: { kind: 'replace', field: 'content', value: '新增的偏好' },
      },
    ];

    const { step, diffs } = createMergeStep();
    // 不抛：一条已存在的记录不该拖垮整批操作。
    await step.run(
      mergeContext(operations, [
        [eventUri, 'events'],
        [CODE_STYLE, 'preferences'],
      ]),
    );

    // 已有事件一个字节都没变（`addOnly` 不允许覆盖写）。
    expect(await memory.read(Uri.parse(eventUri))).toEqual(before);
    // 同批的另一条 URI 照常写入。
    expect((await memory.read(Uri.parse(CODE_STYLE)))?.fields['content']).toBe('新增的偏好');
    // 内容不同 = 同 URI 的另一条事件，不是幂等重放：`reason` 要说清楚，不能静默。
    expect(diffs[0]?.skippedOperations).toHaveLength(1);
    expect(diffs[0]?.skippedOperations[0]).toMatchObject({
      memoryType: 'events',
      reasonCode: 'uri_conflict',
    });
    expect(diffs[0]?.skippedOperations[0]?.reason).toContain(eventUri);
    expect(diffs[0]?.summary).toMatchObject({ totalAdds: 1, totalSkipped: 1 });
  });

  it('同批次 upsert + delete 同一 URI 时保留 upsert', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: 'old',
    });

    const operations: BatchOperation[] = [
      {
        kind: 'upsert',
        uri: CODE_STYLE,
        operation: {
          kind: 'patch',
          field: 'content',
          blocks: [{ search: 'old', replace: 'new' }],
        },
      },
      { kind: 'delete', uri: CODE_STYLE },
    ];

    const { step, diffs } = createMergeStep();
    await step.run(mergeContext(operations, [[CODE_STYLE, 'preferences']]));

    expect((await memory.read(Uri.parse(CODE_STYLE)))?.fields['content']).toBe('new');
    expect(diffs[0]?.operations.deletes).toEqual([]);
  });

  it('delete 操作删除文件并记入 deletes', async () => {
    const uri = `${SCOPE}/memories/preferences/gone.md`;
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'gone',
      content: 'x',
    });

    const { step, diffs } = createMergeStep();
    await step.run(mergeContext([{ kind: 'delete', uri }], [[uri, 'preferences']]));

    expect(await memory.read(Uri.parse(uri))).toBeNull();
    expect(diffs[0]?.operations.deletes).toEqual([uri]);
    expect(diffs[0]?.summary).toMatchObject({ totalDeletes: 1 });
  });

  it('写盘失败时 memory_diff.json 不写', async () => {
    const failing = createMergeStep({
      upsertMemory: async () => {
        throw new ComemError('INTERNAL', '写盘失败。');
      },
    });

    const operations: BatchOperation[] = [
      {
        kind: 'upsert',
        uri: CODE_STYLE,
        operation: { kind: 'replace', field: 'content', value: 'x' },
      },
    ];

    await expect(
      failing.step.run(mergeContext(operations, [[CODE_STYLE, 'preferences']])),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(failing.writeMemoryDiff).not.toHaveBeenCalled();
  });

  it('缺抽取结果时抛 INVALID_ARGUMENT', async () => {
    const { step } = createMergeStep();

    await expect(step.run(createContext())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('抽取阶段被跳过的操作原样进 memory_diff', async () => {
    const { step, diffs } = createMergeStep();
    await step.run(
      mergeContext([], [], [
        { memoryType: 'events', reasonCode: 'invalid_ranges', reason: '消息区间无法解析，跳过' },
      ]),
    );

    expect(diffs[0]?.skippedOperations).toHaveLength(1);
    expect(diffs[0]?.summary).toMatchObject({ totalSkipped: 1 });
  });

  it('把写入结果放进 state 供摘要失效步骤消费', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: 'old',
    });
    const context = mergeContext(
      [
        {
          kind: 'upsert',
          uri: CODE_STYLE,
          operation: {
            kind: 'patch',
            field: 'content',
            blocks: [{ search: 'old', replace: 'new' }],
          },
        },
      ],
      [[CODE_STYLE, 'preferences']],
    );

    const { step } = createMergeStep();
    await step.run(context);

    const merged = context.state.get(MERGE_RESULT_KEY);
    expect(merged).toMatchObject({ written: [Uri.parse(CODE_STYLE)], deleted: [] });
  });

  it('复核类型写入后是 pending', async () => {
    const uri = `${SCOPE}/memories/experiences/monorepo-migration.md`;
    const { step } = createMergeStep();

    await step.run(
      mergeContext(
        [
          {
            kind: 'upsert',
            uri,
            operation: { kind: 'replace', field: 'topic', value: 'monorepo-migration' },
          },
          {
            kind: 'upsert',
            uri,
            operation: { kind: 'replace', field: 'content', value: '经验' },
          },
        ],
        [[uri, 'experiences']],
      ),
    );

    expect((await memory.read(Uri.parse(uri)))?.status).toBe('pending');
    expect(experiencesMemoryType.type).toBe('experiences');
  });
});

describe('SummaryInvalidateStep', () => {
  it('同一目录下的 N 个文件只触发一次父目录标记', async () => {
    const invalidate = vi.fn<(nodeUri: Uri) => Promise<{ recomputed: string[]; markedStale: string[]; stoppedAt: string }>>(async () => ({ recomputed: [], markedStale: [], stoppedAt: '' }));
    const step = new SummaryInvalidateStep({ summary: { invalidate }, logger });
    const written = ['a.md', 'b.md', 'c.md'].map((name) =>
      Uri.parse(`${SCOPE}/memories/preferences/${name}`),
    );

    await step.run(createContext({ state: new Map([[MERGE_RESULT_KEY, { written, deleted: [] }]]) }));

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0].toString()).toBe(written[0]?.toString());
  });

  it('不同目录各触发一次', async () => {
    const invalidate = vi.fn<(nodeUri: Uri) => Promise<{ recomputed: string[]; markedStale: string[]; stoppedAt: string }>>(async () => ({ recomputed: [], markedStale: [], stoppedAt: '' }));
    const step = new SummaryInvalidateStep({ summary: { invalidate }, logger });
    const written = [
      Uri.parse(`${SCOPE}/memories/preferences/a.md`),
      Uri.parse(`${SCOPE}/memories/preferences/b.md`),
      Uri.parse(`${SCOPE}/memories/experiences/c.md`),
    ];

    await step.run(createContext({ state: new Map([[MERGE_RESULT_KEY, { written, deleted: [] }]]) }));

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('删除的 URI 也进失效集合', async () => {
    const invalidate = vi.fn<(nodeUri: Uri) => Promise<{ recomputed: string[]; markedStale: string[]; stoppedAt: string }>>(async () => ({ recomputed: [], markedStale: [], stoppedAt: '' }));
    const step = new SummaryInvalidateStep({ summary: { invalidate }, logger });

    await step.run(
      createContext({
        state: new Map([
          [MERGE_RESULT_KEY, { written: [], deleted: [Uri.parse(`${SCOPE}/memories/preferences/x.md`)] }],
        ]),
      }),
    );

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('没有合并结果时不做任何标记', async () => {
    const invalidate = vi.fn<(nodeUri: Uri) => Promise<{ recomputed: string[]; markedStale: string[]; stoppedAt: string }>>(async () => ({ recomputed: [], markedStale: [], stoppedAt: '' }));
    const step = new SummaryInvalidateStep({ summary: { invalidate }, logger });

    await step.run(createContext());

    expect(invalidate).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      '没有记忆写入，跳过摘要失效',
      expect.objectContaining({ archive: ARCHIVE }),
    );
  });
});
