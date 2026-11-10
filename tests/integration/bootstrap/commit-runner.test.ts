/**
 * 阶段二执行器的端到端验收（架构文档 §10.1、§10.3、§10.4）。
 *
 * 单元测试覆盖不到这里：`tests/integration/services/commit-pipeline.test.ts` 直接
 * `new CommitPipeline(...)` 再 `await run()`，绕过了「谁在什么时候调它」。这一份测试
 * 从 `session.create` 一路走到「`.done` + `memories/pending` 有产出」，用的全是真实
 * 服务（`ContentStore` / `MetadataFileStore` / SQLite `:memory:` / `SessionService` /
 * `TaskService` / `MemoryService` / `SummaryService`）。
 *
 * 唯一的测试替身是模型供应商（`FakeLlmProvider`，`adapters/llm/` 下的正式实现）：
 * 抽取步骤要调模型，测试里不该起网络，也不该 mock 整个 AI SDK。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider, type FakeResponse } from '../../helpers/fake-llm-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { MemoryLinkRepository } from '../../../src/adapters/sqlite/memory-link-repository.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { RequestLogRepository } from '../../../src/adapters/sqlite/request-log-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { createArchiveArtifacts, createArchivePorts } from '../../../src/bootstrap/archive-ports.js';
import { CommitRunner } from '../../../src/bootstrap/commit-runner.js';
import type {
  ArchiveTaskPayload,
  CommitStepName,
  MemoryDiff,
} from '../../../src/domain/archive.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { AutoCommitPolicy, SessionMessage } from '../../../src/domain/session.js';
import { ABSTRACT_MAX_CHARS, OVERVIEW_MAX_CHARS } from '../../../src/domain/summary.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  CommitPipeline,
  CommitStep,
  type CommitPhase,
  type StepContext,
  type StepContextPorts,
} from '../../../src/services/commit/pipeline.js';
import { ArchiveSummaryStep } from '../../../src/services/commit/steps/archive-summary.js';
import { ExperienceDistillStep } from '../../../src/services/commit/steps/experience-distill.js';
import { MemoryExtractStep } from '../../../src/services/commit/steps/memory-extract.js';
import { MemoryMergeStep } from '../../../src/services/commit/steps/memory-merge.js';
import { SummaryInvalidateStep } from '../../../src/services/commit/steps/summary-invalidate.js';
import { AclService } from '../../../src/services/acl.js';
import { LlmService } from '../../../src/services/llm.js';
import { MemoryService, type MemoryServicePorts } from '../../../src/services/memory.js';
import { MemoryLinkService } from '../../../src/services/memory-link.js';
import { ObservabilityService } from '../../../src/services/observability.js';
import { SessionService } from '../../../src/services/session.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';
import { TaskService } from '../../../src/services/task.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

const SCOPE = 'comem://user/alice';
const SESSION = `${SCOPE}/sessions/sess_1`;
const ARCHIVE = `${SESSION}/history/archive_001`;
const ARCHIVE_ID = 'archive_001';
const EXPERIENCE = `${SCOPE}/memories/experiences/code-style.md`;
const EVENT = `${SCOPE}/memories/events/2026-11-08-commit-pipeline-order.md`;

/** 架构文档 §10.3 的固定顺序：合并要在摘要失效之前。 */
const ALL_STEPS = [
  'archive_summary',
  'memory_extract',
  'memory_merge',
  'summary_invalidate',
  'experience_distill',
] as const;

/** §18 的 `task.maxAttempts` 默认值：3 次。坏载荷用完它之后进死信。 */
const MAX_ATTEMPTS = 3;

/** 架构文档 §10.2.1 的默认策略；这些用例不需要自动提交。 */
const DEFAULT_POLICY: AutoCommitPolicy = {
  enabled: true,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

/**
 * 抽取步骤的模型输出：一条新建的 `experiences` 记忆。
 *
 * 用 `experiences` 而不是 `preferences`：它走复核闸门（§11.6），落到磁盘上是
 * `status: pending`，正好用「`memories/pending` 有产出」验收阶段二真的跑完了。
 * 新建项的 `pageId` 必须 `>= 100`（§11.4）。
 */
const EXTRACT_RESPONSE: unknown = {
  operations: [
    {
      kind: 'upsert',
      pageId: 100,
      type: 'experiences',
      identity: { topic: 'code-style' },
      operations: [
        { kind: 'replace', field: 'content', value: '项目里不用 any，需要收窄时用 unknown。' },
      ],
    },
  ],
};

/**
 * 抽取步骤的模型输出：一条新建的 `events` 记忆（`addOnly`，§11.1）。
 *
 * 两次归档抽到**同一个** `event` 标识时，`upsertMemory` 会对已存在的文件抛
 * `ALREADY_EXISTS`——正是「重复写入降级成跳过」要覆盖的路径。
 */
const EVENTS_RESPONSE: unknown = {
  operations: [
    {
      kind: 'upsert',
      pageId: 100,
      type: 'events',
      identity: { event: '2026-11-08-commit-pipeline-order' },
      operations: [
        { kind: 'replace', field: 'content', value: '提交管线固定四步，摘要失效在合并之后。' },
        { kind: 'replace', field: 'occurredAt', value: '2026-11-08T00:00:00.000Z' },
      ],
    },
  ],
};

/**
 * 经验归纳步骤的模型输出：这次会话没有可复用的经验。
 *
 * 空数组是合法结论（不写盘），所以完整流水线的用例不会因为多一步而多出记忆文件；
 * 归纳本身的行为在 `commit-steps.test.ts` 里逐条断言。
 */
const DISTILL_RESPONSE: FakeResponse = { json: { experiences: [] } };

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let store: ContentStore;
let metadata: MetadataFileStore;
let locks: PathLockManager;
let taskStore: TaskRepository;
let tasks: TaskService;
let session: SessionService;
let memory: MemoryService;
let memoryLink: MemoryLinkService;
let summary: SummaryService;

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-runner-'));
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger });
  const index = new SqliteFtsIndex({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  taskStore = new TaskRepository({ db, logger });

  tasks = new TaskService({
    tasks: taskStore,
    logger,
    leaseSeconds: 60,
    maxAttempts: MAX_ATTEMPTS,
    heartbeatSeconds: 20,
  });
  session = new SessionService({
    store,
    metadata,
    locks,
    tasks,
    logger,
    meta: metadata,
    config: { autoCommit: DEFAULT_POLICY },
  });

  // 记忆端口是「原样文档」语义（与 `container.ts` 的 `rawFilesystem` 一致）：
  // 走 `ContentStore` 的字节读写，不经过 `FileSystemService` 的 frontmatter 重排。
  const filesystem: MemoryServicePorts['filesystem'] = {
    read: async (uri) => ({
      text: Buffer.from(await store.readBytes(uri)).toString('utf8'),
    }),
    write: async (uri, text) =>
      store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8'))),
    stat: (uri) => store.stat(uri),
    remove: (uri) => store.remove(uri),
    list: (uri) => store.list(uri),
  };
  memory = new MemoryService({ filesystem, locks, search: { find: async () => [] }, logger });
  memoryLink = new MemoryLinkService({
    repository: new MemoryLinkRepository({ db, logger }),
    logger,
  });

  // 真实 `AclService`：归档步骤写摘要后要物化权限，桩会让这条链路在测试里断掉。
  const acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions: new PermissionRepository({ db, logger }),
    nodes,
    logger,
    locks,
  });
  summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger,
    config: { abstractMaxChars: ABSTRACT_MAX_CHARS, overviewMaxChars: OVERVIEW_MAX_CHARS },
    locks,
  });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface RunnerHarness {
  readonly runner: CommitRunner;
  readonly createPipeline: Mock<
    (archiveUri: Uri, onStepsChanged: (steps: readonly CommitStepName[]) => void) => CommitPipeline
  >;
  readonly provider: FakeLlmProvider;
}

/** 与 `container.ts` 同构的装配：端口按归档现造，五个步骤顺序固定。 */
function createRunner(
  responses: readonly FakeResponse[],
  options: {
    readonly concurrency?: number;
    readonly stepAttempts?: number;
    readonly phase?: CommitPhase;
  } = {},
): RunnerHarness {
  const provider = new FakeLlmProvider(responses);
  const llm = new LlmService({ provider, logger, retryBaseDelayMs: 0 });

  const createPipeline = vi.fn(
    (
      archiveUri: Uri,
      onStepsChanged: (steps: readonly CommitStepName[]) => void,
    ): CommitPipeline => {
      const deps = { store, metadata, logger, dataDir, onStepsChanged };
      const archiveArtifacts = createArchiveArtifacts(archiveUri, deps);
      return new CommitPipeline({
        steps: [
          new ArchiveSummaryStep({
            summary,
            llm,
            metadata,
            workingMemory: { enabled: false },
            logger,
          }),
          new MemoryExtractStep({
            memory,
            llm,
            archive: archiveArtifacts,
            logger,
            profile: { maxChars: 800 },
          }),
          new MemoryMergeStep({ memory, archive: archiveArtifacts, links: memoryLink, logger }),
          new SummaryInvalidateStep({ summary, logger }),
          new ExperienceDistillStep({ memory, llm, links: memoryLink, logger }),
        ],
        ports: createArchivePorts(archiveUri, deps),
        ...(options.stepAttempts === undefined ? {} : { stepAttempts: options.stepAttempts }),
        ...(options.phase === undefined ? undefined : { phase: options.phase }),
        logger,
      });
  });

  return {
    runner: new CommitRunner({
      tasks,
      createPipeline,
      logger,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    }),
    createPipeline,
    provider,
  };
}

/** 与容器同构的观测服务：指标走公开的 `recordHookOverhead` / `renderMetrics`。 */
function createObservability(): ObservabilityService {
  const llm = new LlmService({ provider: new FakeLlmProvider([]), logger, retryBaseDelayMs: 0 });
  return new ObservabilityService({
    requestLog: new RequestLogRepository({ db, logger }),
    db,
    metadata,
    tasks: new TaskRepository({ db, logger }),
    llm,
    profileBodies: { readContent: async () => null },
    logger,
    now: () => new Date(),
  });
}

function payload(archiveId = ARCHIVE_ID): ArchiveTaskPayload {
  return {
    sessionUri: SESSION,
    archiveUri: `${SESSION}/history/${archiveId}`,
    archiveId,
  };
}

function message(
  id: string,
  text: string,
  role: SessionMessage['role'] = 'user',
): Omit<SessionMessage, 'turn'> {
  return { id, role, parts: [{ kind: 'text', text }], createdAt: '2026-11-08T00:00:00.000Z' };
}

/** 归档目录的磁盘路径（`comem://user/alice/sessions/sess_1/history/archive_001`）。 */
function archiveDirectory(archiveUri: string): string {
  return join(dataDir, ...archiveUri.replace('comem://', '').split('/'));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { promise, resolve: () => release() };
}

/** 端口替身：不碰磁盘，给「执行器本身的行为」这类用例用。 */
function createFakePorts(overrides: Partial<StepContextPorts> = {}): StepContextPorts {
  return {
    readMessages: async () => [],
    readArchiveMeta: async () => ({
      archiveId: ARCHIVE_ID,
      phase1: {
        status: 'ready',
        messagesSha256: 'sha',
        archivedMessageIds: [],
        retainedMessageIds: [],
      },
      stepsDone: [],
      skippedSteps: [],
      taskId: null,
    }),
    writeArchiveMeta: async () => undefined,
    latestArchiveOverview: async () => null,
    writeDone: async () => undefined,
    logger,
    ...overrides,
  };
}

/** 卡在 `gate` 上的管线：用来观察「在途」与「重入」。 */
function createBlockingPipeline(hooks: {
  readonly onStart: (archiveUri: Uri) => void;
  readonly gate: Promise<void>;
  readonly onFinish: (archiveUri: Uri) => void;
}): CommitPipeline {
  class BlockingStep extends CommitStep {
    readonly name = 'archive_summary' as const;

    async run(context: StepContext): Promise<void> {
      hooks.onStart(context.archiveUri);
      await hooks.gate;
      hooks.onFinish(context.archiveUri);
    }
  }

  return new CommitPipeline({ steps: [new BlockingStep()], ports: createFakePorts(), logger });
}

describe('CommitRunner 端到端（§10.1 阶段二）', () => {
  it('建会话 → 写消息 → 提交 → tick 跑完 → .done + pending 记忆', async () => {
    const { runner, provider } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE]);

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    await session.addMessage(sessionUri, message('msg_2', '需要收窄时用 unknown。', 'assistant'));
    const committed = await session.commitPhase1(sessionUri);

    // 阶段一只建任务：执行器跑之前任务停在 pending。
    expect(taskStore.get(committed.taskId)?.status).toBe('pending');

    await runner.tick();

    // 任务终态。
    expect(taskStore.get(committed.taskId)).toMatchObject({ status: 'done', error: null });

    // `.meta.json` 的 stepsDone 含全部四步（每步完成立刻落盘，§10.1）。
    const meta = await metadata.readArchive(committed.archiveUri);
    expect(meta?.stepsDone).toEqual([...ALL_STEPS]);

    // `.done` 是唯一的完成信号，最后写。
    const directory = archiveDirectory(ARCHIVE);
    await expect(stat(join(directory, '.done'))).resolves.toBeDefined();

    // `memories/pending` 有产出：与 `GET /memories/pending` 走同一份查询。
    const pending = await memory.listPending(Uri.parse(SCOPE));
    expect(pending.map((record) => record.uri.toString())).toEqual([EXPERIENCE]);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.fields['content']).toBe('项目里不用 any，需要收窄时用 unknown。');

    // 抽取与经验归纳各调一次模型：任何一步重试都会把响应提前用掉，测试因此变红。
    expect(provider.calls).toHaveLength(2);

    await runner.stop();
  });

  it('重放幂等：重新入队后四步全部跳过，不重复写', async () => {
    const { runner, provider } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE]);

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);
    await runner.tick();

    const experiencePath = join(dataDir, 'user', 'alice', 'memories', 'experiences', 'code-style.md');
    const before = await readFile(experiencePath, 'utf8');
    const metaBefore = await metadata.readArchive(committed.archiveUri);

    // 模拟「租约过期后被重新认领」：`stepsDone` 里的四步一个都不能重跑。
    taskStore.requeue(committed.taskId, new Date());
    await runner.tick();

    expect(taskStore.get(committed.taskId)?.status).toBe('done');
    // 没有第二次抽取与第二次归纳（FakeLlmProvider 的响应已经用尽，重跑会抛错）。
    expect(provider.calls).toHaveLength(2);
    // 记忆文件一个字节都没变：`created_at` 与正文都没被覆盖写。
    expect(await readFile(experiencePath, 'utf8')).toBe(before);
    // 跳过的步骤不重写 `.meta.json`。
    expect(await metadata.readArchive(committed.archiveUri)).toEqual(metaBefore);
    await expect(stat(join(archiveDirectory(ARCHIVE), '.done'))).resolves.toBeDefined();

    await runner.stop();
  });

  it('memory_extract 之后失败，重放能恢复（不重调模型）', async () => {
    // 回归：`memory_extract` 的结果原先只存在 `StepContext.state` 里。`stepsDone`
    // 声称它跑完了，重放会跳过它——`memory_merge` 拿到空 `state`，抛
    // `INVALID_ARGUMENT`（终态），归档永久损坏，错误信息还说「步骤顺序被改过」。
    const { runner, provider } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE], {
      stepAttempts: 0,
    });

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, {
      sessionId: 'sess_1',
    });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);

    // 第 3 步撞瞬态失败（供应商 503 这一类）：不是终态，任务回队列。
    vi.spyOn(memory, 'upsertMemory').mockRejectedValueOnce(
      new ComemError('PROVIDER_UNAVAILABLE', '供应商暂时不可用。'),
    );
    await runner.tick();

    expect(taskStore.get(committed.taskId)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    // 抽取产物必须已经在盘上，否则重放恢复不了。
    const operationsPath = join(archiveDirectory(ARCHIVE), 'memory_operations.json');
    await expect(stat(operationsPath)).resolves.toBeDefined();
    // `memory_merge` 没写完 `memory_diff.json`：写盘失败时它不能存在。
    await expect(stat(join(archiveDirectory(ARCHIVE), 'memory_diff.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );

    // 第 2 轮：新的 `run()`、新的空 `state`。
    await runner.tick();

    expect(taskStore.get(committed.taskId)).toMatchObject({ status: 'done', error: null });
    // 第 1 轮是抽取，第 2 轮是经验归纳；抽取走 `rehydrate`，没有重调模型。
    expect(provider.calls).toHaveLength(2);

    const diff = JSON.parse(
      await readFile(join(archiveDirectory(ARCHIVE), 'memory_diff.json'), 'utf8'),
    ) as MemoryDiff;
    expect(diff.operations.adds.map((entry) => entry.uri)).toEqual([EXPERIENCE]);
    expect(diff.operations.deletes).toEqual([]);
    expect(diff.summary).toMatchObject({
      totalAdds: 1,
      totalUpdates: 0,
      totalDeletes: 0,
      totalSkipped: 0,
    });

    const meta = await metadata.readArchive(committed.archiveUri);
    expect(meta?.stepsDone).toEqual([...ALL_STEPS]);

    await runner.stop();
  });

  it('进程重启：新执行器按盘上的 stepsDone + memory_operations.json 恢复', async () => {
    // 上一个用例只验证「同进程重试」。进程崩了再起时，管线实例、`state`、模型
    // 供应商的响应全部消失——只剩磁盘。`recover()` 只重置租约过期的 `running`，
    // 这里用「任务回队列 + 新建执行器」走同一条恢复路径。
    const first = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE], { stepAttempts: 0 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, {
      sessionId: 'sess_1',
    });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);

    vi.spyOn(memory, 'upsertMemory').mockRejectedValueOnce(
      new ComemError('PROVIDER_UNAVAILABLE', '供应商暂时不可用。'),
    );
    await first.runner.tick();
    await first.runner.stop();
    expect(taskStore.get(committed.taskId)?.status).toBe('pending');
    vi.restoreAllMocks();

    // 全新的执行器：没有内存里的 `state`，只剩一次「这次没有经验可归纳」的响应。
    // 抽取若被重跑会消耗掉它，下面的断言因此变红。
    const restarted = createRunner([DISTILL_RESPONSE], { stepAttempts: 0 });
    await restarted.runner.tick();

    expect(taskStore.get(committed.taskId)).toMatchObject({ status: 'done', error: null });
    // 唯一的模型调用属于经验归纳：抽取走的是 `rehydrate`，没有重调模型。
    expect(restarted.provider.calls).toHaveLength(1);
    expect(restarted.provider.calls[0]?.prompt.system).toContain('经验归纳器');
    expect(
      JSON.parse(
        await readFile(join(archiveDirectory(ARCHIVE), 'memory_diff.json'), 'utf8'),
      ),
    ).toMatchObject({ summary: { totalAdds: 1 } });

    await restarted.runner.stop();
  });

  it('memory_merge 之后失败，重放仍会失效摘要（不静默降级）', async () => {
    // 第四步的输入只存在 `state` 里。不恢复的话，重放时它读到空集合，记一条
    // debug 日志就返回——目录摘要永远不重算，而归档照样完成。
    const invalidate = vi
      .spyOn(summary, 'invalidate')
      .mockRejectedValueOnce(new ComemError('INTERNAL', '摘要服务暂时不可用。'));
    const { runner } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE], { stepAttempts: 0 });

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, {
      sessionId: 'sess_1',
    });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);

    await runner.tick();
    expect(taskStore.get(committed.taskId)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    // 合并已经完成：`memory_diff.json` 在盘上。
    await expect(
      stat(join(archiveDirectory(ARCHIVE), 'memory_diff.json')),
    ).resolves.toBeDefined();

    await runner.tick();

    expect(taskStore.get(committed.taskId)).toMatchObject({ status: 'done', error: null });
    // 第二次真的标记了摘要：不是「没有记忆写入，跳过」。
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate.mock.calls[1]?.[0].toString()).toBe(EXPERIENCE);

    await runner.stop();
  });

  it('events 类型重复写入降级成跳过，归档仍完成', async () => {
    // 两次提交抽到同一个事件：第二次的 `memory_merge` 撞上 `ALREADY_EXISTS`。
    // 期望「这一条没写入、其它照常、归档完成」，而不是整批归档失败。
    const { runner } = createRunner([
      { json: EVENTS_RESPONSE },
      DISTILL_RESPONSE,
      { json: EVENTS_RESPONSE },
      DISTILL_RESPONSE,
    ]);

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '决定：提交管线固定四步。'));
    const first = await session.commitPhase1(sessionUri);
    await runner.tick();

    const written = await memory.read(Uri.parse(EVENT));
    expect(written?.fields['content']).toBe('提交管线固定四步，摘要失效在合并之后。');

    await session.addMessage(sessionUri, message('msg_2', '再确认：四步顺序不变。'));
    const second = await session.commitPhase1(sessionUri);
    // 跑满任务级重试上限：没有降级的话，第二次提交的归档会以 `failed` 收场
    // （先撞一次步骤级重试，再被任务重排队）。
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await runner.tick();
    }

    // 归档完成：`memory_merge` 算成功，任务不 failed。
    expect(taskStore.get(first.taskId)).toMatchObject({ status: 'done', error: null });
    const secondTask = taskStore.get(second.taskId);
    expect(secondTask).toMatchObject({ status: 'done', error: null });
    expect(secondTask?.stepsDone).toEqual([...ALL_STEPS]);
    // `attempts` 认领即递增：1 表示只开始了一次执行，第一次就跑完了，没有白重试。
    expect(secondTask?.attempts).toBe(1);

    // `memory_diff.json` 是「这条为什么没生效」的唯一入口。
    const diff = JSON.parse(
      await readFile(
        join(archiveDirectory(second.archiveUri.toString()), 'memory_diff.json'),
        'utf8',
      ),
    ) as MemoryDiff;
    expect(diff.operations.adds).toEqual([]);
    expect(diff.operations.updates).toEqual([]);
    expect(diff.skippedOperations).toHaveLength(1);
    expect(diff.skippedOperations[0]).toMatchObject({
      memoryType: 'events',
      reasonCode: 'already_exists',
    });
    expect(diff.skippedOperations[0]?.reason).toContain(EVENT);
    expect(diff.summary).toMatchObject({ totalAdds: 0, totalSkipped: 1 });

    // 事件文件没有被第二次写入覆盖：连 `updatedAt` 都没变。
    expect(await memory.read(Uri.parse(EVENT))).toEqual(written);

    // 降级必须可见：日志里带 URI 与原因。
    const skipLog = vi
      .mocked(logger.warn)
      .mock.calls.find(([message]) => String(message).includes('记忆写入被跳过'));
    expect(skipLog?.[1]).toMatchObject({
      uri: EVENT,
      memoryType: 'events',
      reasonCode: 'already_exists',
    });

    await runner.stop();
  });

  it('任务行的 stepsDone 与 .meta.json 同步', async () => {
    // 两处各记一份：`.meta.json` 是重放的依据，`task.steps_done` 让「卡在第几步」
    // 能直接 SQL 查出来。不接回调的话任务行永远是空的，而演示/运维看到的正是它。
    const { runner } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE]);

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);
    await runner.tick();

    const taskRow = taskStore.get(committed.taskId);
    const meta = await metadata.readArchive(committed.archiveUri);

    expect(taskRow?.stepsDone).toEqual([
      'archive_summary',
      'memory_extract',
      'memory_merge',
      'summary_invalidate',
      'experience_distill',
    ]);
    expect(taskRow?.stepsDone).toEqual(meta?.stepsDone);

    await runner.stop();
  });

  it('任务已完成时不再认领：清空 stepsDone 也不会重放', async () => {
    const { runner, provider } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE]);

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await session.commitPhase1(sessionUri);
    await runner.tick();

    const meta = await metadata.readArchive(committed.archiveUri);
    if (meta === null) {
      throw new Error('归档元数据不存在');
    }
    // `done` 的任务不在 `claimable` 里：没有步骤会被重放，`.meta.json` 原样不动。
    await metadata.writeArchive(committed.archiveUri, { ...meta, stepsDone: [] });
    await runner.tick();

    // 抽取与经验归纳各一次：没有任何一步被重放。
    expect(provider.calls).toHaveLength(2);
    expect((await metadata.readArchive(committed.archiveUri))?.stepsDone).toEqual([]);

    await runner.stop();
  });

  /**
   * 回归：四个后台步骤以前没有任何 `phase()` 调用点，`comem_hook_async_seconds`
   * 恒为 0。这里跑一次真实提交，再渲染指标，断言它非 0。
   *
   * 指标不再依赖一次 hook 上报把它「快照」出来，也不带 `event` 标签：后台阶段是
   * 进程级的，不属于任何一次上报。
   */
  it('后台阶段耗时进 comem_hook_async_seconds（非 0）', async () => {
    const observability = createObservability();
    const { runner } = createRunner([{ json: EXTRACT_RESPONSE }, DISTILL_RESPONSE], {
      phase: (name, fn) => observability.phase(name, fn),
    });

    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_1' });
    await session.addMessage(sessionUri, message('msg_1', '项目里不用 any，需要收窄时用 unknown。'));
    await session.commitPhase1(sessionUri);
    await runner.tick();

    const asyncLines = observability
      .renderMetrics()
      .split('\n')
      .filter((entry) => entry.startsWith('comem_hook_async_seconds{'));
    expect(asyncLines.length).toBeGreaterThan(0);
    // 只有 `phase` 一个维度：有的阶段真的更快，而事件之间的复制是假的。
    expect(asyncLines.every((entry) => entry.includes('{phase="'))).toBe(true);
    const asyncSeconds = asyncLines.reduce((sum, entry) => sum + Number(entry.split(' ').at(-1)), 0);
    expect(asyncSeconds).toBeGreaterThan(0);

    await runner.stop();
  });
});

describe('createArchivePorts（§10.5、§6.2 规则 6）', () => {
  it('readMessages 逐行解析，坏行跳过并记 warn', async () => {
    const archiveUri = Uri.parse(ARCHIVE);
    const messagesUri = archiveUri.child('messages.jsonl');
    const good = JSON.stringify({ ...message('msg_1', '好的一行'), turn: 1 });
    const badShape = JSON.stringify({ id: 'msg_2', role: 'root' });
    await store.writeText(messagesUri, `${good}\n{不是 JSON\n${badShape}\n`);

    const ports = createArchivePorts(archiveUri, { store, metadata, logger, dataDir });
    const messages = await ports.readMessages();

    // 一条脏数据不能让整个归档永远重试：好行照读，坏行跳过。
    expect(messages).toEqual([{ ...message('msg_1', '好的一行'), turn: 1 }]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('readArchiveMeta 缺失时抛 NOT_FOUND，不编空结构', async () => {
    const archiveUri = Uri.parse(`${SESSION}/history/archive_404`);
    await store.mkdir(archiveUri, { recursive: true });

    const ports = createArchivePorts(archiveUri, { store, metadata, logger, dataDir });

    await expect(ports.readArchiveMeta()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('latestArchiveOverview 按数字序号取上一个归档（不是字符串排序）', async () => {
    const history = Uri.parse(`${SESSION}/history`);
    // 三位补零只能撑到 archive_999；第 1000 个归档开始字符串序与数字序分叉：
    // 'archive_1000' < 'archive_999'，按字符串取会喂错「上次聊到哪」。
    for (const [archiveId, overview] of [
      ['archive_999', '# 第 999 次'],
      ['archive_1000', '# 第 1000 次'],
    ] as const) {
      const archiveUri = history.child(archiveId);
      await store.mkdir(archiveUri, { recursive: true });
      await metadata.writeSummary(archiveUri, '摘要', overview);
    }

    const current = history.child('archive_1001');
    await store.mkdir(current, { recursive: true });
    const ports = createArchivePorts(current, { store, metadata, logger, dataDir });

    expect(await ports.latestArchiveOverview()).toBe('# 第 1000 次');
  });

  it('writeDone 写空 .done；writeMemoryDiff 写 JSON 并带换行', async () => {
    const archiveUri = Uri.parse(ARCHIVE);
    await store.mkdir(archiveUri, { recursive: true });
    const ports = createArchivePorts(archiveUri, { store, metadata, logger, dataDir });

    await ports.writeDone();
    expect(await readFile(join(archiveDirectory(ARCHIVE), '.done'), 'utf8')).toBe('');

    const writer = createArchiveArtifacts(archiveUri, { store, metadata, logger, dataDir });
    const diff = {
      archiveUri: ARCHIVE,
      extractedAt: '2026-11-08T00:00:00.000Z',
      operations: { adds: [], updates: [], deletes: [] },
      skippedOperations: [],
      summary: { totalAdds: 0, totalUpdates: 0, totalDeletes: 0, totalSkipped: 0 },
    };
    await writer.writeMemoryDiff(archiveUri, diff);

    const raw = await readFile(join(archiveDirectory(ARCHIVE), 'memory_diff.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(diff);
  });

  it('readMemoryOperations 把坏 JSON / 坏形状报成 INTERNAL，不伪装成「没有产物」', async () => {
    // 坏文件不能返回 `null`：rehydrate 会把「文件坏了」报成「步骤声称跑过但产物
    // 不存在」，指错方向。
    const archiveUri = Uri.parse(ARCHIVE);
    await store.mkdir(archiveUri, { recursive: true });
    const artifacts = createArchiveArtifacts(archiveUri, { store, metadata, logger, dataDir });
    const operationsPath = join(archiveDirectory(ARCHIVE), 'memory_operations.json');

    await writeFile(operationsPath, '{不是 JSON', 'utf8');
    await expect(artifacts.readMemoryOperations(archiveUri)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('memory_operations.json'),
    });

    await writeFile(operationsPath, JSON.stringify({ operations: [] }), 'utf8');
    await expect(artifacts.readMemoryOperations(archiveUri)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('memory_operations.json'),
    });

    // 不存在才是 `null`。
    await rm(operationsPath);
    await expect(artifacts.readMemoryOperations(archiveUri)).resolves.toBeNull();
  });

  it('没有更早的归档时 latestArchiveOverview 是 null', async () => {
    const archiveUri = Uri.parse(ARCHIVE);
    await store.mkdir(archiveUri, { recursive: true });
    const ports = createArchivePorts(archiveUri, { store, metadata, logger, dataDir });

    expect(await ports.latestArchiveOverview()).toBeNull();
  });
});

describe('CommitRunner 的失败与收尾', () => {
  it('坏载荷：缺字段的任务标 failed，重试有上限', async () => {
    const { runner, createPipeline } = createRunner([]);
    // 只给 archiveId：sessionUri / archiveUri 缺失。
    const task = tasks.create('archive', { archiveId: ARCHIVE_ID });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await runner.tick();
    }

    expect(taskStore.get(task.id)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
    });
    // 载荷坏了不能造出管线：否则会往一个编出来的归档里写。
    expect(createPipeline).not.toHaveBeenCalled();

    // 已进死信：再 tick 也不会重跑。
    await runner.tick();
    expect(taskStore.get(task.id)?.attempts).toBe(MAX_ATTEMPTS);

    await runner.stop();
  });

  it('payload 里的 URI 不合法时同样标 failed，不无限重试', async () => {
    const { runner, createPipeline } = createRunner([]);
    const task = tasks.create('archive', {
      sessionUri: 'not-a-uri',
      archiveUri: ARCHIVE,
      archiveId: ARCHIVE_ID,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await runner.tick();
    }

    expect(taskStore.get(task.id)?.status).toBe('failed');
    expect(createPipeline).not.toHaveBeenCalled();

    await runner.stop();
  });

  it('API Key 无效时步骤不重试，任务直接失败', async () => {
    // 回归：`UNAUTHENTICATED` 曾经两个重试分类都不在——模型调用层正确地不重试，
    // 步骤层却把它当成瞬态失败、任务层再重新排队。一把错的 API Key 因此要等满
    // `(stepAttempts + 1) × taskAttempts` 次超时（默认 2 × 3 = 6 次）。
    const stepRun = vi.fn(async (): Promise<void> => {
      throw new ComemError(
        'UNAUTHENTICATED',
        '模型供应商拒绝了这次请求：API Key 无效，或没有访问该模型的权限。',
      );
    });

    class UnauthenticatedStep extends CommitStep {
      readonly name = 'archive_summary' as const;
      readonly run = stepRun;
    }

    const createPipeline = vi.fn(
      (): CommitPipeline =>
        new CommitPipeline({ steps: [new UnauthenticatedStep()], ports: createFakePorts(), logger }),
    );
    const runner = new CommitRunner({ tasks, createPipeline, logger });
    const task = tasks.create('archive', payload());

    await runner.tick();

    // 只跑一次。`stepAttempts` 默认 1 等于「最多两次」，第二次纯属白重试。
    expect(stepRun).toHaveBeenCalledTimes(1);
    // 任务直接进终态：`attempts` 是 1，不是 `maxAttempts`。
    const failed = taskStore.get(task.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    // 错误必须能定位到 API Key，而不是一句「任务失败」。
    expect(failed?.error).toContain('API Key');

    // 进死信后不会再被认领。
    await runner.tick();
    expect(stepRun).toHaveBeenCalledTimes(1);

    await runner.stop();
  });

  it('stop() 等在途任务收尾', async () => {
    const task = tasks.create('archive', payload());
    const gate = deferred();
    const started = deferred();
    const finished: string[] = [];
    const runner = new CommitRunner({
      tasks,
      createPipeline: () =>
        createBlockingPipeline({
          onStart: () => started.resolve(),
          gate: gate.promise,
          onFinish: (archiveUri) => finished.push(archiveUri.toString()),
        }),
      logger,
    });

    const ticking = runner.tick();
    await started.promise;

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    // 在途任务**不打断**（§10.1 的收尾语义）：stop 必须等它跑完。
    expect(stopped).toBe(false);
    expect(finished).toEqual([]);

    gate.resolve();
    await stopping;

    expect(stopped).toBe(true);
    expect(finished).toEqual([ARCHIVE]);
    expect(taskStore.get(task.id)?.status).toBe('done');

    await ticking;
  });

  it('concurrency = 1 时两个任务串行', async () => {
    const first = tasks.create('archive', payload('archive_001'));
    const second = tasks.create('archive', payload('archive_002'));

    let concurrent = 0;
    let maxConcurrent = 0;

    class TrackingStep extends CommitStep {
      readonly name = 'archive_summary' as const;

      async run(context: StepContext): Promise<void> {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        concurrent -= 1;
        context.state.set('ran', context.archiveUri.toString());
      }
    }

    const createPipeline = vi.fn(
      (): CommitPipeline =>
        new CommitPipeline({ steps: [new TrackingStep()], ports: createFakePorts(), logger }),
    );
    const runner = new CommitRunner({ tasks, createPipeline, logger, concurrency: 1 });

    const statuses = (): readonly (string | undefined)[] =>
      [first, second].map((task) => taskStore.get(task.id)?.status).sort();

    await runner.tick();
    // 并发上限同时是「一轮认领几个」：一次只启动一个。
    expect(createPipeline).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['done', 'pending']);

    await runner.tick();
    expect(createPipeline).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual(['done', 'done']);
    expect(maxConcurrent).toBe(1);

    await runner.stop();
  });

  it('tick() 在上一轮没跑完时直接返回', async () => {
    const task = tasks.create('archive', payload());
    const gate = deferred();
    const started = deferred();
    const createPipeline = vi.fn(
      (): CommitPipeline =>
        createBlockingPipeline({
          onStart: () => started.resolve(),
          gate: gate.promise,
          onFinish: () => undefined,
        }),
    );
    const runner = new CommitRunner({ tasks, createPipeline, logger });

    const firstTick = runner.tick();
    await started.promise;

    // 上一轮还在跑：这一轮立刻返回，不排队、不重叠。
    await runner.tick();
    expect(createPipeline).toHaveBeenCalledTimes(1);
    expect(taskStore.get(task.id)?.status).toBe('running');

    gate.resolve();
    await firstTick;
    expect(taskStore.get(task.id)?.status).toBe('done');

    await runner.stop();
  });
});
