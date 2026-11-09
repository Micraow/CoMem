import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider, type FakeResponse } from '../../../src/adapters/llm/fake-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import type { AutoCommitPolicy } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { LlmService } from '../../../src/services/llm.js';
import {
  SearchService,
  type RetrievalSettings,
  type SearchOptions,
} from '../../../src/services/search.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

const SCOPE = 'comem://user/alice';
const PRINCIPALS = ['user:alice'];
const NOW = '2026-11-08T00:00:00.000Z';

/** 架构文档 §18 的 `retrieval` 段（与 `tests/integration/services/search.test.ts` 同一份）。 */
const CONFIG: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [
    's|^/\\w+.*$||',
    's|@[\\w/\\.\\-]+||g',
    's|```[\\s\\S]*?```||g',
    's|https?://\\S+||g',
    's|^(ok\\|yes\\|继续\\|好\\|嗯)$||i',
  ],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

/** 自动提交与本文件无关，关掉即可。 */
const AUTO_COMMIT: AutoCommitPolicy = {
  enabled: false,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

let dataDir: string;
let db: DatabaseSync;
let index: SqliteFtsIndex;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: Logger;
let authorizer: AllowAllAuthorizer;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-search-intent-'));
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  db = openDatabase(':memory:');
  runMigrations(db);
  index = new SqliteFtsIndex({ db, logger });
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  authorizer = new AllowAllAuthorizer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface RecordOverrides {
  readonly level?: Level;
  readonly contextType?: ContextType;
}

function record(uri: string, content: string, overrides: RecordOverrides = {}): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: 'document',
    contextType: overrides.contextType ?? 'memory',
    memoryType: null,
    level: overrides.level ?? 'L2',
    abstract: null,
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: NOW,
    status: 'active',
  };
}

/** 建索引行 + 授权（正文由 `filesystem` 读，本文件不需要）。 */
async function seed(uri: string, content: string, overrides: RecordOverrides = {}): Promise<void> {
  await index.upsert([record(uri, content, overrides)]);
  db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)').run(
    uri,
    'user:alice',
  );
}

interface Harness {
  readonly service: SearchService;
  readonly llm: LlmService;
  readonly provider: FakeLlmProvider;
  readonly sessions: SessionService;
}

interface HarnessOptions {
  /** 模型按顺序消费的预置响应。 */
  readonly responses?: readonly FakeResponse[];
  /** 不注入 `LlmService`：断言「意图分析不可用」的降级路径。 */
  readonly withoutLlm?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const provider = new FakeLlmProvider(options.responses ?? []);
  // `maxAttempts: 1`：重试策略是 `services/llm.ts` 的测试对象，这里只关心降级。
  const llm = new LlmService({ provider, logger, maxAttempts: 1 });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
  });
  const filesystem = new FileSystemService({ store, locks, authorizer, logger });
  const tasks = new TaskService({ tasks: new TaskRepository({ db, logger }), logger });
  const sessions = new SessionService({
    store,
    metadata,
    locks,
    tasks,
    logger,
    meta: metadata,
    config: { autoCommit: AUTO_COMMIT },
  });

  const service = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: CONFIG,
    llm: options.withoutLlm === true ? undefined : llm,
    sessions,
    // 必填依赖：测试显式传默认值（`telemetry.hotness.*` 的 schema 默认值）。
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });
  return { service, llm, provider, sessions };
}

function searchOptions(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return { scopes: [SCOPE], subject: 'user:alice', principals: PRINCIPALS, ...overrides };
}

/** 一条模型产出。 */
function draft(text: string, confidence = 0.8): Record<string, unknown> {
  return { text, intent: 'fact', confidence, derivedFrom: text };
}

/** 发给模型的用户消息（提示词里当前查询、历史与范围都在这一段）。 */
function promptOf(provider: FakeLlmProvider, callIndex = 0): string {
  const call = provider.calls[callIndex];
  return call?.prompt.messages.map((message) => message.content).join('\n') ?? '';
}

describe('search 的意图分析', () => {
  const DOC = 'comem://user/alice/mem/design.md';

  it('单条查询正常检索，计划里带重写结果', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service } = createHarness({
      responses: [{ json: { queries: [draft('记忆', 0.9)] } }],
    });

    const result = await service.search('之前那个数据库设计呢', searchOptions());

    expect(result.hits.map((hit) => hit.uri)).toEqual([DOC]);
    expect(result.hits[0]?.matchedQuery).toBe('记忆');
    expect(result.plan.analyzed).toBe(true);
    expect(result.plan.reason).toBeNull();
    expect(result.plan.original).toBe('之前那个数据库设计呢');
    expect(result.plan.queries).toEqual([
      { text: '记忆', intent: 'fact', confidence: 0.9, derivedFrom: '记忆' },
    ]);
    expect(result.plan.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('模型返回 0 条 → 空命中且 analyzed: true（这是合法结论）', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service, provider } = createHarness({ responses: [{ json: { queries: [] } }] });

    const result = await service.search('之前那个设计呢', searchOptions());

    expect(result.hits).toEqual([]);
    expect(result.plan.queries).toEqual([]);
    expect(result.plan.analyzed).toBe(true);
    expect(result.plan.reason).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      '意图分析判定不该检索，返回空命中',
      expect.objectContaining({ returned: 0 }),
    );
  });

  it('模型返回 2 条 → 两次 find，合并去重后按分数降序', async () => {
    const preferences = 'comem://user/alice/mem/preferences.md';
    const deploy = 'comem://user/alice/mem/deploy.md';
    await seed(preferences, '偏好 代码 风格');
    await seed(deploy, '部署 流程 蓝绿');
    const { service } = createHarness({
      responses: [{ json: { queries: [draft('偏好'), draft('部署')] } }],
    });
    const searchSpy = vi.spyOn(index, 'search');

    const result = await service.search('风格和部署都说一下', searchOptions());

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result.hits.map((hit) => hit.uri)).toEqual([preferences, deploy]);
    expect(result.hits.map((hit) => hit.matchedQuery)).toEqual(['偏好', '部署']);
    const scores = result.hits.map((hit) => hit.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);
    expect(result.plan.queries).toHaveLength(2);
  });

  it('两条查询命中同一个 URI 时只出现一次，分数取最高', async () => {
    const style = 'comem://user/alice/mem/style.md';
    await seed(style, '代码风格偏好 严格模式');
    const { service } = createHarness({
      responses: [{ json: { queries: [draft('代码风格'), draft('偏好')] } }],
    });

    // 先分别取两条查询的分数，合并规则是「取最高」。
    const first = await service.find('代码风格', searchOptions());
    const second = await service.find('偏好', searchOptions());
    const expected = Math.max(first[0]?.score ?? 0, second[0]?.score ?? 0);

    const result = await service.search('之前的风格约定还不错', searchOptions());

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.uri).toBe(style);
    expect(result.hits[0]?.score).toBeCloseTo(expected, 10);
  });

  it('LLM 抛错 → 降级成原 query，analyzed: false 且 reason 非空', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service } = createHarness({
      responses: [{ error: new ComemError('UNAUTHENTICATED', 'API Key 无效。') }],
    });

    const result = await service.search('记忆', searchOptions());

    expect(result.plan.analyzed).toBe(false);
    expect(result.plan.reason).toContain('UNAUTHENTICATED');
    expect(result.plan.queries).toHaveLength(1);
    expect(result.plan.queries[0]?.text).toBe('记忆');
    expect(result.hits.map((hit) => hit.uri)).toEqual([DOC]);
    expect(logger.warn).toHaveBeenCalledWith(
      '意图分析不可用，已降级为原查询',
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('LLM 输出被截断 → 同样降级（不重试）', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    /**
     * `finishReason === 'length'` 在适配层映射成带 `truncated` 标记的
     * `PROVIDER_UNAVAILABLE`（`adapters/llm/ai-sdk-provider.ts`），`LlmService`
     * 见到它直接抛出、不重试（§11.4）。测试替身的 `completeJson` 不看
     * `finishReason`，所以用同一个错误对象模拟适配层的产物。
     */
    const { service, provider } = createHarness({
      responses: [
        {
          error: new ComemError(
            'PROVIDER_UNAVAILABLE',
            '模型输出被截断，结构化结果不完整。请调大 maxTokens 后重试。',
            { truncated: true, finishReason: 'length' },
          ),
        },
      ],
    });

    const result = await service.search('记忆', searchOptions());

    expect(result.plan.analyzed).toBe(false);
    expect(result.plan.reason).toContain('PROVIDER_UNAVAILABLE');
    expect(result.hits.map((hit) => hit.uri)).toEqual([DOC]);
    // 截断不重试：只消耗一次响应。
    expect(provider.remaining).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '意图分析不可用，已降级为原查询',
      expect.objectContaining({ truncated: true }),
    );
  });

  it('过滤后为空 → 不调 LLM', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service, llm } = createHarness();
    const generate = vi.spyOn(llm, 'generateJson');

    const result = await service.search('/help', searchOptions());

    expect(generate).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
    expect(result.plan.queries).toEqual([]);
    expect(result.plan.analyzed).toBe(true);
    expect(result.plan.reason).toBeNull();
  });

  it('没有 sessionId 时仍能分析（历史为空）', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service, provider } = createHarness({
      responses: [{ json: { queries: [draft('记忆')] } }],
    });

    const result = await service.search('记忆', searchOptions());

    expect(result.plan.analyzed).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(promptOf(provider)).toContain('（这次没有历史消息。）');
  });

  it('有 sessionId 时把最近对话放进提示词，工具消息被过滤掉', async () => {
    await seed(DOC, '部署 流程 蓝绿');
    const { service, provider, sessions } = createHarness({
      responses: [{ json: { queries: [draft('部署 流程')] } }],
    });
    const sessionUri = await sessions.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_intent' });
    await sessions.addMessage(sessionUri, {
      id: 'm1',
      role: 'user',
      parts: [{ kind: 'text', text: '我们讨论一下部署方案' }],
      createdAt: NOW,
    });
    await sessions.addMessage(sessionUri, {
      id: 'm2',
      role: 'tool',
      parts: [{ kind: 'tool_result', toolUseId: 'call-1', output: 'TOOL_NOISE', isError: false }],
      createdAt: NOW,
    });
    await sessions.addMessage(sessionUri, {
      id: 'm3',
      role: 'assistant',
      parts: [{ kind: 'text', text: '好的，用蓝绿部署' }],
      createdAt: NOW,
    });

    const result = await service.search('那它呢', searchOptions({ sessionId: 'sess_intent' }));

    expect(result.plan.analyzed).toBe(true);
    const prompt = promptOf(provider);
    expect(prompt).toContain('我们讨论一下部署方案');
    expect(prompt).toContain('好的，用蓝绿部署');
    // 工具输出又长又噪声，不进提示词（§10.1）。
    expect(prompt).not.toContain('TOOL_NOISE');
    expect(prompt).toContain(`- ${SCOPE}`);
  });

  it('会话不存在时按「历史为空」处理，检索仍然成功', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service, provider } = createHarness({
      responses: [{ json: { queries: [draft('记忆')] } }],
    });

    const result = await service.search('记忆', searchOptions({ sessionId: 'sess_missing' }));

    expect(result.plan.analyzed).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(promptOf(provider)).toContain('（这次没有历史消息。）');
    expect(logger.warn).toHaveBeenCalledWith(
      '会话不可读，意图分析按「历史为空」处理',
      expect.objectContaining({ sessionId: 'sess_missing' }),
    );
  });

  it('limit 生效：每条查询各取 limit 条候选，合并后仍是 limit 条', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      await seed(`comem://user/alice/mem/${name}.md`, '代码风格 偏好 严格模式');
    }
    // 5 条互不相同的文本，否则会被 schema 去重（§8.4 的去重规则）。
    const queries = ['代码风格', '代码 风格', '代码风格偏好', '代码风格 偏好', '代码 风格 偏好'].map(
      (text) => draft(text),
    );
    const { service } = createHarness({ responses: [{ json: { queries } }] });
    const searchSpy = vi.spyOn(index, 'search');

    const result = await service.search('风格', searchOptions({ limit: 3 }));

    expect(searchSpy).toHaveBeenCalledTimes(5);
    // 不是 limit / 5：每条查询都取 limit 条候选，去重后合并。
    for (const [query] of searchSpy.mock.calls) {
      expect(query.limit).toBe(3);
    }
    expect(result.hits).toHaveLength(3);
  });

  it('没有注入 LlmService 时降级为原查询，并写明原因', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const { service } = createHarness({ withoutLlm: true });

    const result = await service.search('记忆', searchOptions());

    expect(result.plan.analyzed).toBe(false);
    expect(result.plan.reason).toContain('LlmService');
    expect(result.hits.map((hit) => hit.uri)).toEqual([DOC]);
  });
});
