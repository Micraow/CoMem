import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository, type TaskRow } from '../../../src/adapters/sqlite/task-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
/** §18 的 task.leaseSeconds 默认值；这里显式传入，避免测试依赖服务的默认值。 */
const LEASE_SECONDS = 60;

let db: DatabaseSync;
let repository: TaskRepository;

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

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    type: 'archive',
    status: 'pending',
    payload: { archiveId: 'archive_001' },
    stepsDone: [],
    attempts: 0,
    leaseUntil: null,
    error: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function at(offsetSeconds: number): Date {
  return new Date(NOW.getTime() + offsetSeconds * 1000);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new TaskRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('insert / get', () => {
  it('写入后按 id 读回全部字段，payload 与 stepsDone 走 JSON 往返', () => {
    const task = row({
      payload: { sessionUri: 'comem://user/alice/sessions/sess_1', nested: { attempt: 2 } },
      stepsDone: ['archive_summary', 'memory_extract'],
      attempts: 1,
      error: '上一次失败了',
    });

    repository.insert(task);

    expect(repository.get(task.id)).toEqual(task);
  });

  it('不存在返回 null', () => {
    expect(repository.get('missing')).toBeNull();
  });

  it('同一 id 重复插入抛错（主键冲突不会静默覆盖）', () => {
    repository.insert(row());
    expect(() => repository.insert(row())).toThrow();
  });

  it('payload 不是合法 JSON 时抛 INTERNAL', () => {
    db.prepare(
      `INSERT INTO task (id, type, status, payload, steps_done, attempts, lease_until, error, created_at, updated_at)
       VALUES (?, 'archive', 'pending', 'not-json', '[]', 0, NULL, NULL, ?, ?)`,
    ).run('broken', NOW.toISOString(), NOW.toISOString());

    let caught: unknown;
    try {
      repository.get('broken');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('INTERNAL');
  });

  it('steps_done 不是字符串数组时抛 INTERNAL', () => {
    db.prepare(
      `INSERT INTO task (id, type, status, payload, steps_done, attempts, lease_until, error, created_at, updated_at)
       VALUES (?, 'archive', 'pending', '{}', '[1, 2]', 0, NULL, NULL, ?, ?)`,
    ).run('broken-steps', NOW.toISOString(), NOW.toISOString());

    expect(() => repository.get('broken-steps')).toThrow(ComemError);
  });
});

describe('tryClaim', () => {
  it('pending 可以认领，lease_until = now + leaseSeconds', () => {
    repository.insert(row());

    expect(repository.tryClaim('task-1', NOW, LEASE_SECONDS)).toBe(true);

    const claimed = repository.get('task-1');
    expect(claimed?.status).toBe('running');
    expect(claimed?.leaseUntil).toBe(at(LEASE_SECONDS).toISOString());
    expect(claimed?.updatedAt).toBe(NOW.toISOString());
  });

  it('running 且租约未过期时不能认领', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(30).toISOString() }));

    expect(repository.tryClaim('task-1', NOW, LEASE_SECONDS)).toBe(false);
    expect(repository.get('task-1')?.leaseUntil).toBe(at(30).toISOString());
  });

  it('running 且租约过期时可以认领', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(-1).toISOString() }));

    expect(repository.tryClaim('task-1', NOW, LEASE_SECONDS)).toBe(true);
    expect(repository.get('task-1')?.leaseUntil).toBe(at(LEASE_SECONDS).toISOString());
  });

  it('running 但没有租约按已过期处理（与领域层 isLeaseExpired 一致）', () => {
    repository.insert(row({ status: 'running', leaseUntil: null }));

    expect(repository.tryClaim('task-1', NOW, LEASE_SECONDS)).toBe(true);
  });

  it('done / failed 不能认领', () => {
    repository.insert(row({ id: 'done', status: 'done' }));
    repository.insert(row({ id: 'failed', status: 'failed' }));

    expect(repository.tryClaim('done', NOW, LEASE_SECONDS)).toBe(false);
    expect(repository.tryClaim('failed', NOW, LEASE_SECONDS)).toBe(false);
  });
});

describe('renewLease', () => {
  it('把租约推进到 now + leaseSeconds', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(10).toISOString() }));

    repository.renewLease('task-1', at(20), LEASE_SECONDS);

    expect(repository.get('task-1')?.leaseUntil).toBe(at(80).toISOString());
  });

  it('不续非 running 的行：终态任务不该有租约', () => {
    repository.insert(row({ status: 'done', leaseUntil: null }));

    repository.renewLease('task-1', at(20), LEASE_SECONDS);

    expect(repository.get('task-1')?.leaseUntil).toBeNull();
  });
});

describe('updateStepsDone', () => {
  it('整体写回（重放判据）', () => {
    repository.insert(row());

    repository.updateStepsDone('task-1', ['archive_summary', 'memory_extract']);

    expect(repository.get('task-1')?.stepsDone).toEqual(['archive_summary', 'memory_extract']);
  });
});

describe('requeue / finish', () => {
  it('requeue 回到 pending 并递增 attempts，保留 error', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(60).toISOString(), error: '上次失败' }));

    repository.requeue('task-1', at(5));

    const task = repository.get('task-1');
    expect(task?.status).toBe('pending');
    expect(task?.leaseUntil).toBeNull();
    expect(task?.attempts).toBe(1);
    expect(task?.error).toBe('上次失败');
    expect(task?.updatedAt).toBe(at(5).toISOString());
  });

  it('finish(done) 清空租约但不递增 attempts', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(60).toISOString() }));

    repository.finish('task-1', 'done', null, at(5));

    const task = repository.get('task-1');
    expect(task?.status).toBe('done');
    expect(task?.leaseUntil).toBeNull();
    expect(task?.attempts).toBe(0);
    expect(task?.error).toBeNull();
  });

  it('finish(failed) 写 error 并递增 attempts', () => {
    repository.insert(row({ status: 'running', leaseUntil: at(60).toISOString() }));

    repository.finish('task-1', 'failed', '抽取失败', at(5));

    const task = repository.get('task-1');
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('抽取失败');
    expect(task?.attempts).toBe(1);
    expect(task?.leaseUntil).toBeNull();
  });
});

describe('recoverExpired', () => {
  it('只回收租约过期的 running 行，并 attempts += 1', () => {
    repository.insert(row({ id: 'zombie', status: 'running', leaseUntil: at(-10).toISOString() }));
    repository.insert(row({ id: 'alive', status: 'running', leaseUntil: at(30).toISOString() }));
    repository.insert(row({ id: 'queued', status: 'pending' }));

    const recovered = repository.recoverExpired(NOW);

    expect(recovered).toEqual(['zombie']);
    expect(repository.get('zombie')).toMatchObject({
      status: 'pending',
      leaseUntil: null,
      attempts: 1,
    });
    expect(repository.get('alive')).toMatchObject({ status: 'running', attempts: 0 });
    expect(repository.get('queued')).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('没有僵尸任务时返回空数组（幂等，可反复跑）', () => {
    repository.insert(row({ status: 'pending' }));

    expect(repository.recoverExpired(NOW)).toEqual([]);
    expect(repository.recoverExpired(NOW)).toEqual([]);
  });
});

describe('claimable', () => {
  it('pending 与租约过期的 running 都在，按 created_at 升序', () => {
    repository.insert(row({ id: 'third', createdAt: '2026-11-08T00:00:03.000Z' }));
    repository.insert(
      row({
        id: 'first',
        status: 'running',
        leaseUntil: at(-1).toISOString(),
        createdAt: '2026-11-08T00:00:01.000Z',
      }),
    );
    repository.insert(row({ id: 'second', createdAt: '2026-11-08T00:00:02.000Z' }));
    repository.insert(row({ id: 'future', status: 'running', leaseUntil: at(30).toISOString() }));
    repository.insert(row({ id: 'done', status: 'done' }));

    expect(repository.claimable(NOW, 10).map((task) => task.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('limit 截断', () => {
    for (let index = 0; index < 5; index += 1) {
      repository.insert(
        row({
          id: `task-${index}`,
          createdAt: new Date(NOW.getTime() + index).toISOString(),
        }),
      );
    }

    expect(repository.claimable(NOW, 2).map((task) => task.id)).toEqual(['task-0', 'task-1']);
  });
});

describe('countByStatus', () => {
  it('按状态计数', () => {
    repository.insert(row({ id: 'a', status: 'pending' }));
    repository.insert(row({ id: 'b', status: 'pending' }));
    repository.insert(row({ id: 'c', status: 'done' }));

    expect(repository.countByStatus('pending')).toBe(2);
    expect(repository.countByStatus('done')).toBe(1);
    expect(repository.countByStatus('failed')).toBe(0);
  });
});
