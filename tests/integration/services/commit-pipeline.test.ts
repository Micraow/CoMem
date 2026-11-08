import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { ArchiveMeta, CommitStepName } from '../../../src/domain/archive.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  CommitPipeline,
  CommitStep,
  type StepContext,
  type StepContextPorts,
} from '../../../src/services/commit/pipeline.js';

const ARCHIVE = 'comem://user/alice/sessions/sess_1/history/archive_001';
const SCOPE = 'comem://user/alice';
const ARCHIVE_ID = 'archive_001';

const ALL_STEPS: readonly CommitStepName[] = [
  'archive_summary',
  'memory_extract',
  'memory_merge',
  'summary_invalidate',
];

class FakeStep extends CommitStep {
  readonly name: CommitStepName;
  readonly run: Mock<(context: StepContext) => Promise<void>>;

  constructor(
    name: CommitStepName,
    impl: (context: StepContext) => Promise<void> = async () => undefined,
  ) {
    super();
    this.name = name;
    this.run = vi.fn(impl);
  }
}

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

interface HarnessOptions {
  readonly steps: readonly CommitStep[];
  readonly stepsDone?: readonly CommitStepName[];
  readonly stepAttempts?: number;
  readonly messages?: readonly SessionMessage[];
  readonly latestArchiveOverview?: string | null;
}

interface Harness {
  readonly pipeline: CommitPipeline;
  readonly writeDone: Mock<() => Promise<void>>;
  readonly writeMeta: Mock<(meta: ArchiveMeta) => Promise<void>>;
  readonly metaWrites: ArchiveMeta[];
  readonly logger: Logger;
  currentMeta(): ArchiveMeta;
}

function createHarness(options: HarnessOptions): Harness {
  const logger = createLogger();
  let meta: ArchiveMeta = {
    archiveId: ARCHIVE_ID,
    phase1: {
      status: 'ready',
      messagesSha256: 'sha',
      archivedMessageIds: [],
      retainedMessageIds: [],
    },
    stepsDone: options.stepsDone ?? [],
    skippedSteps: [],
    taskId: 'task_1',
  };

  const metaWrites: ArchiveMeta[] = [];
  const writeMeta = vi.fn(async (next: ArchiveMeta) => {
    meta = next;
    metaWrites.push(next);
  });
  const writeDone = vi.fn(async () => undefined);

  const ports: StepContextPorts = {
    readMessages: async () => options.messages ?? [],
    readArchiveMeta: async () => meta,
    writeArchiveMeta: writeMeta,
    latestArchiveOverview: async () => options.latestArchiveOverview ?? null,
    writeDone,
    logger,
  };

  return {
    pipeline: new CommitPipeline({
      steps: options.steps,
      ports,
      logger,
      ...(options.stepAttempts === undefined ? {} : { stepAttempts: options.stepAttempts }),
    }),
    writeDone,
    writeMeta,
    metaWrites,
    logger,
    currentMeta: () => meta,
  };
}

describe('CommitPipeline 骨架（§10.3）', () => {
  it('四步按顺序执行', async () => {
    const steps = ALL_STEPS.map((name) => new FakeStep(name));
    const harness = createHarness({ steps });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    const order = steps.map((step) => step.run.mock.invocationCallOrder[0] ?? -1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(harness.currentMeta().stepsDone).toEqual([...ALL_STEPS]);
    expect(harness.writeDone).toHaveBeenCalledTimes(1);
  });

  it('stepsDone 里已有的步骤不执行（重放跳过）', async () => {
    const steps = ALL_STEPS.map((name) => new FakeStep(name));
    const harness = createHarness({
      steps,
      stepsDone: ['archive_summary', 'memory_extract'],
    });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(steps[0]?.run).not.toHaveBeenCalled();
    expect(steps[1]?.run).not.toHaveBeenCalled();
    expect(steps[2]?.run).toHaveBeenCalledTimes(1);
    expect(steps[3]?.run).toHaveBeenCalledTimes(1);
    // 跳过的步骤不会被重复记录。
    expect(harness.currentMeta().stepsDone).toEqual([...ALL_STEPS]);
    expect(harness.metaWrites.map((meta) => meta.stepsDone.length)).toEqual([3, 4]);
  });

  it('每步完成立刻落盘：第 2 步失败时第 1 步的 stepsDone 已写', async () => {
    const steps = [
      new FakeStep('archive_summary'),
      new FakeStep('memory_extract', async () => {
        throw new ComemError('INTERNAL', '模型挂了。');
      }),
      new FakeStep('memory_merge'),
      new FakeStep('summary_invalidate'),
    ];
    const harness = createHarness({ steps, stepAttempts: 0 });

    await expect(
      harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE)),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(harness.metaWrites).toHaveLength(1);
    expect(harness.metaWrites[0]?.stepsDone).toEqual(['archive_summary']);
    expect(steps[2]?.run).not.toHaveBeenCalled();
  });

  it('stepAttempts = 1 时失败重试 1 次', async () => {
    let attempt = 0;
    const flaky = new FakeStep('archive_summary', async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ComemError('PROVIDER_UNAVAILABLE', '供应商暂时不可用。');
      }
    });
    const harness = createHarness({ steps: [flaky], stepAttempts: 1 });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(flaky.run).toHaveBeenCalledTimes(2);
    expect(harness.currentMeta().stepsDone).toEqual(['archive_summary']);
    expect(harness.writeDone).toHaveBeenCalledTimes(1);
  });

  it.each(['INVALID_URI', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'UNAUTHENTICATED'] as const)(
    '终态错误（%s）不重试',
    async (code) => {
      const failing = new FakeStep('memory_extract', async () => {
        throw new ComemError(code, '确定性失败。');
      });
      const harness = createHarness({ steps: [failing], stepAttempts: 1 });

      await expect(
        harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE)),
      ).rejects.toMatchObject({ code });

      // `stepAttempts = 1` 等于「最多两次」：确定性失败第二次也只会再失败一次。
      expect(failing.run).toHaveBeenCalledTimes(1);
    },
  );

  it('重试超限后抛出，后续步骤不执行', async () => {
    const steps = [
      new FakeStep('archive_summary', async () => {
        throw new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。');
      }),
      new FakeStep('memory_extract'),
    ];
    const harness = createHarness({ steps, stepAttempts: 1 });

    await expect(
      harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(steps[0]?.run).toHaveBeenCalledTimes(2);
    expect(steps[1]?.run).not.toHaveBeenCalled();
    expect(harness.writeDone).not.toHaveBeenCalled();
  });
});

describe('CommitPipeline 的 .done 与 state', () => {
  it('中途失败时 .done 不存在；全成功时存在且最后写', async () => {
    const okSteps = ALL_STEPS.map((name) => new FakeStep(name));
    const okHarness = createHarness({ steps: okSteps });
    await okHarness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(okHarness.metaWrites.at(-1)?.stepsDone).toEqual([...ALL_STEPS]);
    // `.done` 的调用顺序在全部写 meta 之后（§10.1：它是唯一的完成信号）。
    const doneOrder = okHarness.writeDone.mock.invocationCallOrder[0] ?? -1;
    const lastMetaOrder = okHarness.writeMeta.mock.invocationCallOrder.at(-1) ?? -1;
    expect(doneOrder).toBeGreaterThan(lastMetaOrder);

    const failing = [
      new FakeStep('archive_summary'),
      new FakeStep('memory_extract', async () => {
        throw new ComemError('INTERNAL', '炸了。');
      }),
    ];
    const failedHarness = createHarness({ steps: failing, stepAttempts: 0 });
    await expect(
      failedHarness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE)),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(failedHarness.writeDone).not.toHaveBeenCalled();
  });

  it('state 跨步骤传递产物', async () => {
    const produced: string[] = [];
    const producer = new FakeStep('archive_summary', async (context) => {
      context.state.set('payload', { operations: 3 });
    });
    const consumer = new FakeStep('memory_extract', async (context) => {
      const payload = context.state.get('payload');
      produced.push(JSON.stringify(payload));
    });
    const harness = createHarness({ steps: [producer, consumer] });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(produced).toEqual(['{"operations":3}']);
  });

  it('把 messages 与上一个归档概览交给步骤', async () => {
    const messages: readonly SessionMessage[] = [
      { id: 'msg_1', role: 'user', parts: [{ kind: 'text', text: '你好' }], createdAt: '2026-11-08T00:00:00Z', turn: 1 },
    ];
    const seen: unknown[] = [];
    const step = new FakeStep('archive_summary', async (context) => {
      seen.push(context.messages.length, context.latestArchiveOverview);
    });
    const harness = createHarness({
      steps: [step],
      messages,
      latestArchiveOverview: '# 上次的工作记忆',
    });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(seen).toEqual([1, '# 上次的工作记忆']);
  });

  it('步骤自己调用 markStepDone 时落盘一次，管线不重复记', async () => {
    const step = new FakeStep('archive_summary', async (context) => {
      await context.markStepDone('archive_summary');
    });
    const harness = createHarness({ steps: [step] });

    await harness.pipeline.run(Uri.parse(ARCHIVE), Uri.parse(SCOPE));

    expect(harness.metaWrites).toHaveLength(1);
    expect(harness.currentMeta().stepsDone).toEqual(['archive_summary']);
  });
});
