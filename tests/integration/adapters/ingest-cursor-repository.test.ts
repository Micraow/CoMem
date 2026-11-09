import { describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { IngestCursorRepository } from '../../../src/adapters/sqlite/ingest-cursor-repository.js';
import type { Logger } from '../../../src/domain/log.js';

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

function createRepository(): IngestCursorRepository {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return new IngestCursorRepository({ db, logger: createLogger() });
}

const ROW = {
  harness: 'claude-code' as const,
  nativeSessionId: 'native-1',
  sessionUri: 'comem://user/alice/sessions/sess_1',
  cursorKind: 'byte_offset' as const,
  cursorValue: '1234',
  messageCount: 9,
  updatedAt: '2026-11-08T00:00:00.000Z',
};

describe('IngestCursorRepository', () => {
  it('首次插入后能按 (harness, nativeSessionId) 读回', () => {
    const repository = createRepository();
    repository.upsert(ROW);
    expect(repository.get('claude-code', 'native-1')).toEqual(ROW);
    expect(repository.get('codex', 'native-1')).toBeNull();
  });

  it('主键冲突时更新游标与会话 URI，不产生第二行', () => {
    const repository = createRepository();
    repository.upsert(ROW);
    repository.upsert({
      ...ROW,
      sessionUri: 'comem://user/alice/sessions/sess_2',
      cursorValue: '9999',
      messageCount: 12,
      updatedAt: '2026-11-08T01:00:00.000Z',
    });

    expect(repository.get('claude-code', 'native-1')).toEqual({
      ...ROW,
      sessionUri: 'comem://user/alice/sessions/sess_2',
      cursorValue: '9999',
      messageCount: 12,
      updatedAt: '2026-11-08T01:00:00.000Z',
    });
  });

  it('同一原生 ID 在不同宿主互不覆盖', () => {
    const repository = createRepository();
    repository.upsert(ROW);
    repository.upsert({ ...ROW, harness: 'codex', sessionUri: 'comem://user/alice/sessions/sess_2' });

    expect(repository.get('claude-code', 'native-1')).toEqual(ROW);
    expect(repository.get('codex', 'native-1')).toEqual({
      ...ROW,
      harness: 'codex',
      sessionUri: 'comem://user/alice/sessions/sess_2',
    });
  });
});
