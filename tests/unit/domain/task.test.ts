import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  canTransition,
  claim,
  isLeaseExpired,
  isStepDone,
  markStepDone,
  shouldRetry,
  transition,
  type Task,
  type TaskStatus,
} from '../../../src/domain/task.js';

const NOW = new Date('2026-11-05T16:40:00.000Z');
const ALL_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'done', 'failed'];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_b41e',
    type: 'archive',
    status: 'pending',
    payload: {},
    stepsDone: [],
    attempts: 0,
    leaseUntil: null,
    error: null,
    createdAt: '2026-11-05T16:39:00.000Z',
    updatedAt: '2026-11-05T16:39:00.000Z',
    ...overrides,
  };
}

function expectComemError(run: () => void, code: ComemError['code']): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe(code);
  return error;
}

describe('canTransition', () => {
  it('pending 只能到 running', () => {
    expect(canTransition('pending', 'running')).toBe(true);
    expect(canTransition('pending', 'done')).toBe(false);
    expect(canTransition('pending', 'failed')).toBe(false);
    expect(canTransition('pending', 'pending')).toBe(false);
  });

  it('running 可以完成、失败或回到队列', () => {
    expect(canTransition('running', 'done')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'pending')).toBe(true);
    expect(canTransition('running', 'running')).toBe(false);
  });

  it('failed 只能回到 pending 重试', () => {
    expect(canTransition('failed', 'pending')).toBe(true);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('failed', 'done')).toBe(false);
    expect(canTransition('failed', 'failed')).toBe(false);
  });

  it('done 是终态，四个方向都不能离开', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition('done', to)).toBe(false);
    }
  });
});

describe('transition', () => {
  it('合法转移更新状态与时间戳', () => {
    const next = transition(task(), 'running', NOW);

    expect(next.status).toBe('running');
    expect(next.updatedAt).toBe(NOW.toISOString());
    expect(next.createdAt).toBe('2026-11-05T16:39:00.000Z');
  });

  it('非法转移抛 CONFLICT', () => {
    const error = expectComemError(() => transition(task({ status: 'done' }), 'running', NOW), 'CONFLICT');

    expect(error.details).toEqual({ taskId: 'task_b41e', from: 'done', to: 'running' });
  });

  it('离开 running 时清空租约', () => {
    const running = task({ status: 'running', leaseUntil: '2026-11-05T16:41:00.000Z' });

    expect(transition(running, 'done', NOW).leaseUntil).toBeNull();
    expect(transition(running, 'failed', NOW).leaseUntil).toBeNull();
    expect(transition(running, 'pending', NOW).leaseUntil).toBeNull();
  });

  it('不修改原任务', () => {
    const original = task();
    const next = transition(original, 'running', NOW);

    expect(next).not.toBe(original);
    expect(original.status).toBe('pending');
  });
});

describe('isLeaseExpired', () => {
  it('非 running 没有租约概念', () => {
    expect(isLeaseExpired(task({ status: 'pending', leaseUntil: '2020-01-01T00:00:00.000Z' }), NOW)).toBe(
      false,
    );
    expect(isLeaseExpired(task({ status: 'done', leaseUntil: null }), NOW)).toBe(false);
  });

  it('租约到期时刻算过期', () => {
    const expired = task({ status: 'running', leaseUntil: NOW.toISOString() });

    expect(isLeaseExpired(expired, NOW)).toBe(true);
  });

  it('未到期的 running 不过期', () => {
    const running = task({ status: 'running', leaseUntil: '2026-11-05T16:41:00.000Z' });

    expect(isLeaseExpired(running, NOW)).toBe(false);
  });

  it('running 但没有租约视为过期，避免任务永远卡住', () => {
    expect(isLeaseExpired(task({ status: 'running', leaseUntil: null }), NOW)).toBe(true);
  });

  it('租约时间戳非法时抛 INVALID_ARGUMENT', () => {
    expectComemError(
      () => isLeaseExpired(task({ status: 'running', leaseUntil: '不是时间' }), NOW),
      'INVALID_ARGUMENT',
    );
  });
});

describe('claim', () => {
  it('pending 可以直接领取，并写入租约', () => {
    const claimed = claim(task(), NOW, 60);

    expect(claimed.status).toBe('running');
    expect(claimed.leaseUntil).toBe('2026-11-05T16:41:00.000Z');
    expect(claimed.updatedAt).toBe(NOW.toISOString());
  });

  it('租约过期的 running 可以领取', () => {
    const zombie = task({ status: 'running', leaseUntil: '2026-11-05T16:30:00.000Z' });

    expect(claim(zombie, NOW, 60).status).toBe('running');
  });

  it('租约未过期的 running 不能领取', () => {
    const running = task({ status: 'running', leaseUntil: '2026-11-05T16:41:00.000Z' });

    expectComemError(() => claim(running, NOW, 60), 'CONFLICT');
  });

  it('done 与 failed 不能领取', () => {
    expectComemError(() => claim(task({ status: 'done' }), NOW, 60), 'CONFLICT');
    expectComemError(() => claim(task({ status: 'failed' }), NOW, 60), 'CONFLICT');
  });

  it('认领不递增 attempts，避免一次重试被计两次', () => {
    expect(claim(task({ attempts: 2 }), NOW, 60).attempts).toBe(2);
  });

  it('租约时长必须为正数秒', () => {
    expectComemError(() => claim(task(), NOW, 0), 'INVALID_ARGUMENT');
    expectComemError(() => claim(task(), NOW, -1), 'INVALID_ARGUMENT');
    expectComemError(() => claim(task(), NOW, Number.NaN), 'INVALID_ARGUMENT');
  });
});

describe('steps', () => {
  it('未完成的步骤返回 false', () => {
    expect(isStepDone(task(), 'archive_summary')).toBe(false);
  });

  it('标记完成后可查询，且不修改原任务', () => {
    const original = task();
    const marked = markStepDone(original, 'archive_summary');

    expect(isStepDone(marked, 'archive_summary')).toBe(true);
    expect(original.stepsDone).toEqual([]);
    expect(marked.stepsDone).toEqual(['archive_summary']);
  });

  it('重复标记同一步是幂等的，不产生重复项', () => {
    const marked = markStepDone(task({ stepsDone: ['archive_summary'] }), 'archive_summary');

    expect(marked.stepsDone).toEqual(['archive_summary']);
  });

  it('按顺序追加多个步骤', () => {
    const marked = ['archive_summary', 'memory_extract', 'memory_merge'].reduce(
      (current, step) => markStepDone(current, step),
      task(),
    );

    expect(marked.stepsDone).toEqual(['archive_summary', 'memory_extract', 'memory_merge']);
  });
});

describe('shouldRetry', () => {
  it('failed 且未到上限时重试', () => {
    expect(shouldRetry(task({ status: 'failed', attempts: 2 }), 3)).toBe(true);
  });

  it('failed 到达上限时不再重试', () => {
    expect(shouldRetry(task({ status: 'failed', attempts: 3 }), 3)).toBe(false);
  });

  it('pending 只要没到上限就可以再跑', () => {
    expect(shouldRetry(task({ status: 'pending', attempts: 0 }), 3)).toBe(true);
  });

  it('done 永不重试', () => {
    expect(shouldRetry(task({ status: 'done', attempts: 0 }), 3)).toBe(false);
  });
});
