import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import type { CommitStepName } from '../../../src/domain/archive.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { TaskStatus } from '../../../src/domain/task.js';
import { TaskService } from '../../../src/services/task.js';

/**
 * §18 的 `task.maxAttempts` 默认值：3 次。
 * `shouldRetry` 在 `attempts` 到上限后返回假，所以第 3 次失败后置 `failed`。
 */
const MAX_ATTEMPTS = 3;

/** §18 的 `task.leaseSeconds` 默认值。 */
const LEASE_SECONDS = 60;

let db: DatabaseSync;
let repository: TaskRepository;
let logger: Logger;
let service: TaskService;

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

function createService(options: { readonly maxAttempts?: number } = {}): TaskService {
  return new TaskService({
    tasks: repository,
    logger,
    leaseSeconds: LEASE_SECONDS,
    maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
  });
}

function statusOf(id: string): TaskStatus | undefined {
  return repository.get(id)?.status;
}

function attemptsOf(id: string): number | undefined {
  return repository.get(id)?.attempts;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  repository = new TaskRepository({ db, logger });
  service = createService();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('create', () => {
  it('建一个 pending 任务，id 是 UUID，payload 原样落盘', () => {
    const task = service.create('archive', { archiveId: 'archive_001' });

    expect(task.status).toBe('pending');
    expect(task.type).toBe('archive');
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.attempts).toBe(0);
    expect(task.stepsDone).toEqual([]);
    expect(task.leaseUntil).toBeNull();
    expect(repository.get(task.id)?.payload).toEqual({ archiveId: 'archive_001' });
  });
});

describe('run', () => {
  it('认领并执行成功：status = done，handler 拿到任务行', async () => {
    const task = service.create('archive', { archiveId: 'archive_001' });
    let receivedId: string | null = null;

    const ran = await service.run(task.id, async (context) => {
      receivedId = context.task.id;
    });

    expect(ran).toBe(true);
    expect(receivedId).toBe(task.id);
    expect(repository.get(task.id)).toMatchObject({ status: 'done', leaseUntil: null, error: null });
  });

  it('已被别人认领（租约未过期）返回 false 且不执行', async () => {
    const task = service.create('archive', {});
    expect(repository.tryClaim(task.id, new Date(), LEASE_SECONDS)).toBe(true);
    const handler = vi.fn(async () => {});

    expect(await service.run(task.id, handler)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(statusOf(task.id)).toBe('running');
  });

  it('markStepDone 幂等：同一个 step 调两次只有一条记录', async () => {
    const task = service.create('archive', {});

    await service.run(task.id, async (context) => {
      await context.markStepDone('archive_summary');
      await context.markStepDone('archive_summary');
      await context.markStepDone('memory_extract');
    });

    expect(repository.get(task.id)?.stepsDone).toEqual(['archive_summary', 'memory_extract']);
  });

  it('重放时跳过 stepsDone 里已有的步骤：再次标记不重复追加', async () => {
    const task = service.create('archive', {});
    repository.updateStepsDone(task.id, ['archive_summary']);

    const visited: CommitStepName[] = [];
    await service.run(task.id, async (context) => {
      const done = new Set(context.task.stepsDone);
      for (const step of ['archive_summary', 'memory_extract'] as const) {
        if (done.has(step)) {
          continue;
        }
        visited.push(step);
        await context.markStepDone(step);
      }
    });

    expect(visited).toEqual(['memory_extract']);
    expect(repository.get(task.id)?.stepsDone).toEqual(['archive_summary', 'memory_extract']);
  });

  it('心跳续租：每 heartbeatSeconds 推进 leaseUntil', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));
    service = createService();
    const task = service.create('archive', {});
    let leaseDuringRun: string | null = null;

    const runPromise = service.run(task.id, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25_000));
      leaseDuringRun = repository.get(task.id)?.leaseUntil ?? null;
    });
    await vi.advanceTimersByTimeAsync(25_000);

    expect(await runPromise).toBe(true);
    // 认领写 now + 60s = 00:01:00；20 秒时心跳续到 00:00:20 + 60s = 00:01:20。
    expect(leaseDuringRun).toBe('2026-11-08T00:01:20.000Z');
  });

  it('handler 抛错后 clearInterval：没有残留定时器', async () => {
    vi.useFakeTimers();
    const task = service.create('archive', {});

    expect(
      await service.run(task.id, async () => {
        throw new Error('boom');
      }),
    ).toBe(false);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('handler 成功时也清掉定时器', async () => {
    vi.useFakeTimers();
    const task = service.create('archive', {});

    await service.run(task.id, async () => {});
    await vi.runOnlyPendingTimersAsync();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('失败重试', () => {
  it('attempts 到 maxAttempts 后置 failed，错误写进 error 字段', async () => {
    const task = service.create('archive', {});
    const handler = async (): Promise<void> => {
      throw new Error('模型超时');
    };

    expect(await service.run(task.id, handler)).toBe(false);
    expect(repository.get(task.id)).toMatchObject({ status: 'pending', attempts: 1 });

    expect(await service.run(task.id, handler)).toBe(false);
    expect(repository.get(task.id)).toMatchObject({ status: 'pending', attempts: 2 });

    expect(await service.run(task.id, handler)).toBe(false);
    const failed = repository.get(task.id);
    expect(failed?.status).toBe('failed');
    expect(attemptsOf(task.id)).toBe(MAX_ATTEMPTS);
    expect(failed?.error).toContain('模型超时');
    expect(logger.error).toHaveBeenCalled();
  });

  it('maxAttempts = 1 时第一次失败就置 failed', async () => {
    service = createService({ maxAttempts: 1 });
    const task = service.create('archive', {});

    await service.run(task.id, async () => {
      throw new Error('一次就失败');
    });

    expect(statusOf(task.id)).toBe('failed');
    expect(attemptsOf(task.id)).toBe(1);
  });

  it.each([
    'INVALID_URI',
    'INVALID_ARGUMENT',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
  ] as const)(
    '终态错误 %s 直接 failed，不重试',
    async (code) => {
      const task = service.create('archive', {});

      await service.run(task.id, async () => {
        throw new ComemError(code, '终态错误');
      });

      expect(statusOf(task.id)).toBe('failed');
      expect(attemptsOf(task.id)).toBe(1);
      expect(repository.get(task.id)?.error).toBe('终态错误');
    },
  );
});

describe('recover', () => {
  it('回收租约过期的 running 任务：attempts 保持认领时的值，回收不计数', () => {
    const zombie = service.create('archive', {});
    repository.tryClaim(zombie.id, new Date('2026-11-01T00:00:00.000Z'), 1);
    // 认领成功就是一次执行的开始。
    expect(attemptsOf(zombie.id)).toBe(1);

    expect(service.recover()).toBe(1);
    expect(repository.get(zombie.id)).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('没有僵尸任务时返回 0（幂等，可每 30 秒跑一次）', () => {
    service.create('archive', {});

    expect(service.recover()).toBe(0);
    expect(service.recover()).toBe(0);
  });
});

describe('claimable / countByStatus', () => {
  it('返回待处理任务，按 created_at 升序', () => {
    const first = service.create('archive', {});
    const second = service.create('archive', {});

    expect(service.claimable().map((task) => task.id)).toEqual([first.id, second.id]);
    expect(service.claimable(1)).toHaveLength(1);
  });

  it('按状态计数（health 工具用）', () => {
    service.create('archive', {});
    service.create('archive', {});

    expect(service.countByStatus('pending')).toBe(2);
    expect(service.countByStatus('done')).toBe(0);
  });
});
