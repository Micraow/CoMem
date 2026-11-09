import { describe, expect, it } from 'vitest';

import {
  shouldRetry,
  type Task,
} from '../../../src/domain/task.js';

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
