import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  RequestLogRepository,
  type RequestLogRow,
} from '../../../src/adapters/sqlite/request-log-repository.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

/** 读剩下的行，按与保留策略一致的顺序（`created_at` 倒序、`id` 倒序）。 */
function ids(): string[] {
  return db
    .prepare('SELECT id FROM request_log ORDER BY created_at DESC, id DESC')
    .all()
    .map((row) => String(row['id']));
}

function total(): number {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM request_log').get()?.['total'] ?? 0);
}

let db: DatabaseSync;
let repository: RequestLogRepository;

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

function row(overrides: Partial<RequestLogRow> = {}): RequestLogRow {
  return {
    id: 'log-1',
    requestId: 'req_abc',
    method: 'POST',
    path: '/api/v1/search/find',
    statusCode: 200,
    durationMs: 104,
    phases: { processStart: 38, recall: 66, serialize: 0, capture: 0 },
    errorCode: null,
    subject: 'alice',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

/** 在 `NOW` 之前 `secondsAgo` 秒的时间戳。 */
function at(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new RequestLogRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('prune', () => {
  it('先按天数删：早于 retainDays 的行全部消失', () => {
    repository.insert(row({ id: 'stale', requestId: 'req_stale', createdAt: at(8 * 24 * 60 * 60) }));
    repository.insert(row({ id: 'recent', requestId: 'req_recent', createdAt: at(60) }));

    const deleted = repository.prune({ retainDays: 7, retainRows: 100, now: NOW });

    expect(deleted).toBe(1);
    expect(ids()).toEqual(['recent']);
  });

  it('再按行数删：只保留最新的 retainRows 条', () => {
    for (let index = 0; index < 5; index += 1) {
      repository.insert(
        row({ id: `log-${index}`, requestId: `req_${index}`, createdAt: at(index * 10) }),
      );
    }

    const deleted = repository.prune({ retainDays: 3650, retainRows: 2, now: NOW });

    expect(deleted).toBe(3);
    expect(ids()).toEqual(['log-0', 'log-1']);
  });

  it('两条规则在同一个事务里生效，返回删除总数', () => {
    repository.insert(row({ id: 'expired', requestId: 'req_0', createdAt: at(30 * 24 * 60 * 60) }));
    for (let index = 1; index <= 4; index += 1) {
      repository.insert(
        row({ id: `log-${index}`, requestId: `req_${index}`, createdAt: at(index * 10) }),
      );
    }

    // 天数删 1 行，行数再删 2 行（剩下 4 行留最新 2 行）。
    expect(repository.prune({ retainDays: 7, retainRows: 2, now: NOW })).toBe(3);
    expect(ids()).toEqual(['log-1', 'log-2']);
  });

  it('retainRows 为 0 表示一条不留（配置允许 0）', () => {
    repository.insert(row({ id: 'a', requestId: 'req_a', createdAt: at(60) }));

    expect(repository.prune({ retainDays: 3650, retainRows: 0, now: NOW })).toBe(1);
    expect(total()).toBe(0);
  });

  it('空表裁剪返回 0', () => {
    expect(repository.prune({ retainDays: 7, retainRows: 100, now: NOW })).toBe(0);
  });
});
