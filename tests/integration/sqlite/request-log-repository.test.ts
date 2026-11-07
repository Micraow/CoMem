import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  RequestLogRepository,
  type RequestLogRow,
} from '../../../src/adapters/sqlite/request-log-repository.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

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

describe('insert / list', () => {
  it('写入后按字段读回，phases 走 JSON 往返', () => {
    const log = row();

    repository.insert(log);

    expect(repository.list({ limit: 10 })).toEqual([log]);
  });

  it('按时间倒序，offset / limit 分页', () => {
    repository.insert(row({ id: 'old', requestId: 'req_old', createdAt: at(300) }));
    repository.insert(row({ id: 'new', requestId: 'req_new', createdAt: at(10) }));
    repository.insert(row({ id: 'mid', requestId: 'req_mid', createdAt: at(100) }));

    expect(repository.list({ limit: 10 }).map((log) => log.id)).toEqual(['new', 'mid', 'old']);
    expect(repository.list({ limit: 1, offset: 1 }).map((log) => log.id)).toEqual(['mid']);
    expect(repository.list({ limit: 10, offset: 10 })).toEqual([]);
  });

  it('同一毫秒内到达的请求用 id 做稳定次序', () => {
    repository.insert(row({ id: 'log-a', requestId: 'req_a' }));
    repository.insert(row({ id: 'log-b', requestId: 'req_b' }));

    expect(repository.list({ limit: 10 }).map((log) => log.id)).toEqual(['log-b', 'log-a']);
  });

  it('onlyErrors 只留 statusCode >= 400 或带错误码的行', () => {
    repository.insert(row({ id: 'ok', requestId: 'req_1', statusCode: 200 }));
    repository.insert(row({ id: 'denied', requestId: 'req_2', statusCode: 403 }));
    repository.insert(
      row({ id: 'failed', requestId: 'req_3', statusCode: 200, errorCode: 'PROVIDER_UNAVAILABLE' }),
    );

    expect(repository.list({ limit: 10, onlyErrors: true }).map((log) => log.id)).toEqual([
      'failed',
      'denied',
    ]);
    expect(repository.list({ limit: 10, onlyErrors: false })).toHaveLength(3);
  });

  it('phases 为 NULL 时原样返回 null', () => {
    repository.insert(row({ phases: null }));

    expect(repository.list({ limit: 10 })[0]?.phases).toBeNull();
  });

  it('phases 不是合法 JSON 时返回 null，不让整个查询失败', () => {
    db.prepare(
      `INSERT INTO request_log
         (id, request_id, method, path, status_code, duration_ms, phases, error_code, subject, created_at)
       VALUES ('broken', 'req_broken', 'GET', '/health', 200, 1, 'not-json', NULL, NULL, ?)`,
    ).run(NOW.toISOString());

    expect(repository.list({ limit: 10 })[0]).toMatchObject({ id: 'broken', phases: null });
  });

  it('phases 是 JSON 但不是对象时返回 null', () => {
    db.prepare(
      `INSERT INTO request_log
         (id, request_id, method, path, status_code, duration_ms, phases, error_code, subject, created_at)
       VALUES ('array', 'req_array', 'GET', '/health', 200, 1, '[1,2]', NULL, NULL, ?)`,
    ).run(NOW.toISOString());

    expect(repository.list({ limit: 10 })[0]?.phases).toBeNull();
  });

  it('phases 里非数字的条目按 null 处理（缺少的阶段就是没计时）', () => {
    repository.insert(row({ phases: { recall: 12, serialize: null, capture: 0 } }));

    expect(repository.list({ limit: 10 })[0]?.phases).toEqual({
      recall: 12,
      serialize: null,
      capture: 0,
    });
  });

  it('count 返回总行数', () => {
    expect(repository.count()).toBe(0);
    repository.insert(row({ id: 'a', requestId: 'req_a' }));
    repository.insert(row({ id: 'b', requestId: 'req_b' }));

    expect(repository.count()).toBe(2);
  });
});

describe('prune', () => {
  it('先按天数删：早于 retainDays 的行全部消失', () => {
    repository.insert(row({ id: 'stale', requestId: 'req_stale', createdAt: at(8 * 24 * 60 * 60) }));
    repository.insert(row({ id: 'recent', requestId: 'req_recent', createdAt: at(60) }));

    const deleted = repository.prune({ retainDays: 7, retainRows: 100, now: NOW });

    expect(deleted).toBe(1);
    expect(repository.list({ limit: 10 }).map((log) => log.id)).toEqual(['recent']);
  });

  it('再按行数删：只保留最新的 retainRows 条', () => {
    for (let index = 0; index < 5; index += 1) {
      repository.insert(
        row({ id: `log-${index}`, requestId: `req_${index}`, createdAt: at(index * 10) }),
      );
    }

    const deleted = repository.prune({ retainDays: 3650, retainRows: 2, now: NOW });

    expect(deleted).toBe(3);
    expect(repository.list({ limit: 10 }).map((log) => log.id)).toEqual(['log-0', 'log-1']);
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
    expect(repository.list({ limit: 10 }).map((log) => log.id)).toEqual(['log-1', 'log-2']);
  });

  it('retainRows 为 0 表示一条不留（配置允许 0）', () => {
    repository.insert(row({ id: 'a', requestId: 'req_a', createdAt: at(60) }));

    expect(repository.prune({ retainDays: 3650, retainRows: 0, now: NOW })).toBe(1);
    expect(repository.count()).toBe(0);
  });

  it('空表裁剪返回 0', () => {
    expect(repository.prune({ retainDays: 7, retainRows: 100, now: NOW })).toBe(0);
  });
});
