/**
 * `attempts` 的语义：**已开始的执行次数**（认领成功即 +1），`maxAttempts` 是**允许的
 * 最大执行次数**（架构文档 §10.4、`domain/task.ts` 的 `shouldRetry`）。
 *
 * 这里的核心断言是**执行计数器**，不是 `attempts` 字段值：字段值正是可能被改坏的东西
 * （多补一次 +1 会让它比真实执行次数大，少补一次会让它偏小）。计数器独立于这个字段，
 * 骗不过去。
 */
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import type { Logger } from '../../../src/domain/log.js';
import { TaskService, type TaskHandler } from '../../../src/services/task.js';

/** §18 的 `task.maxAttempts` 默认值：3 次。 */
const MAX_ATTEMPTS = 3;

/** §18 的 `task.leaseSeconds` 默认值。 */
const LEASE_SECONDS = 60;

/**
 * 驱动循环的上界。正常路径最多跑 `MAX_ATTEMPTS` 轮；有 bug（例如 `attempts` 不递增，
 * 任务永远留在 `pending`）时不让测试挂死在无限循环上——超过上界就交给断言报错。
 */
const ROUND_GUARD = 10;

let db: DatabaseSync;
let repository: TaskRepository;
let logger: Logger;
let service: TaskService;

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  repository = new TaskRepository({ db, logger });
  service = new TaskService({ tasks: repository, logger, maxAttempts: MAX_ATTEMPTS, leaseSeconds: LEASE_SECONDS });
});

afterEach(() => {
  db.close();
});

describe('attempts = 已开始的执行次数', () => {
  it('必然失败的任务配 maxAttempts = 3：恰好执行 3 次，第 3 次后 failed', async () => {
    const task = service.create('archive', { archiveId: 'archive_001' });
    /** 每次 handler 真正被调用就记一次——这就是用户能观察到的「执行了几次」。 */
    const executions: number[] = [];
    const attemptsSeen: number[] = [];
    const handler: TaskHandler = async (context) => {
      executions.push(executions.length + 1);
      // 认领后读到的 `attempts` 应当等于这次是第几次执行：1、2、3。
      attemptsSeen.push(context.task.attempts);
      throw new Error('模型超时');
    };

    // 与 `CommitRunner` 的驱动方式一致：每轮把「可认领」的任务跑掉。`failed` 不可
    // 认领，所以循环在任务进入终态后自然结束。
    for (let round = 0; round < ROUND_GUARD; round += 1) {
      const claimable = service.claimable();
      if (claimable.length === 0) {
        break;
      }
      for (const candidate of claimable) {
        await service.run(candidate.id, handler);
      }
    }

    expect(executions).toEqual([1, 2, 3]);
    expect(attemptsSeen).toEqual([1, 2, 3]);

    const final = repository.get(task.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toContain('模型超时');
    // 补充证据：计数与执行次数一致。字段只是结果，次数由上面的计数器证明。
    expect(final?.attempts).toBe(MAX_ATTEMPTS);
    // 进终态后不再被认领。
    expect(service.claimable()).toEqual([]);
  });

  it('连续两次认领同一任务：第二次认领不到，attempts 只按成功的那一次 +1', async () => {
    const task = service.create('archive', {});
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 第一次认领后 handler 卡在 gate 上，租约仍然有效。
    const first = service.run(task.id, async () => {
      await gate;
    });

    try {
      // `run` 在第一个 await 之前已经落盘认领，所以此刻可以直接断言。
      expect(repository.get(task.id)).toMatchObject({ status: 'running', attempts: 1 });

      const secondHandler = vi.fn(async () => {});
      expect(await service.run(task.id, secondHandler)).toBe(false);
      expect(secondHandler).not.toHaveBeenCalled();
      // 第二次认领没拿到行，计数不动：一次认领只加一。
      expect(repository.get(task.id)?.attempts).toBe(1);
    } finally {
      release();
    }

    expect(await first).toBe(true);
    // 成功也不再加一次：这次执行的开始已经记过了。
    expect(repository.get(task.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('租约过期被回收：回收不计数，重新认领才 +1', async () => {
    const task = service.create('archive', {});

    // 模拟「进程在任务中途被杀」：认领过、租约已过期、没有终态。
    const claimedAt = new Date(Date.now() - 10 * LEASE_SECONDS * 1000);
    expect(repository.tryClaim(task.id, claimedAt, LEASE_SECONDS)).toBe(true);
    expect(repository.get(task.id)).toMatchObject({ status: 'running', attempts: 1 });

    // 启动扫描把僵尸任务放回队列：那次认领已经算过一次，回收不再加。
    expect(service.recover()).toBe(1);
    expect(repository.get(task.id)).toMatchObject({ status: 'pending', attempts: 1 });

    // 重新执行 = 第二次认领 → 2。两条回收路径（回收扫描 / 直接抢过期租约）同一语义。
    let attemptsDuringRun: number | null = null;
    await service.run(task.id, async (context) => {
      attemptsDuringRun = context.task.attempts;
    });
    expect(attemptsDuringRun).toBe(2);
    expect(repository.get(task.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('回收扫描不替这次崩溃多记一次：上限 3 的任务仍然只放行 3 次开始', async () => {
    const task = service.create('archive', {});
    /** 每次 handler 真正被执行时看到的是「含这次执行」的计数。 */
    const attemptsSeen: number[] = [];
    const handler: TaskHandler = async (context) => {
      attemptsSeen.push(context.task.attempts);
      throw new Error('模型超时');
    };

    // 第 1 次执行：认领时 attempts = 1，失败后回队列，计数不变。
    await service.run(task.id, handler);
    expect(repository.get(task.id)).toMatchObject({ status: 'pending', attempts: 1 });

    // 模拟第 2 次执行「认领成功、进程被杀」：租约已过期，计数 = 2。
    expect(
      repository.tryClaim(task.id, new Date(Date.now() - 10 * LEASE_SECONDS * 1000), LEASE_SECONDS),
    ).toBe(true);
    expect(repository.get(task.id)).toMatchObject({ status: 'running', attempts: 2 });

    // 回收不计数：这次执行的开始已经记过了。旧实现会在这里加一，等于替这次崩溃
    // 多扣一次重试额度。
    expect(service.recover()).toBe(1);
    expect(repository.get(task.id)).toMatchObject({ status: 'pending', attempts: 2 });

    // 第 3 次执行：认领把计数推到上限，失败即终态。
    await service.run(task.id, handler);
    expect(repository.get(task.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    // 中间那次「认领了但进程被杀」也占了一次执行额度，所以 handler 只被执行 2 次。
    expect(attemptsSeen).toEqual([1, MAX_ATTEMPTS]);
    expect(service.claimable()).toEqual([]);
  });
});
