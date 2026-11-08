import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  DEFAULT_RECALL_LEDGER_OPTIONS,
  RecallLedger,
  scopeKeyOf,
} from '../../../src/services/recall-ledger.js';
import type {
  LedgerStore,
  RecallLedgerOptions,
} from '../../../src/services/recall-ledger.js';

class MemoryLedgerStore implements LedgerStore {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];

  async read(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.files.get(key) ?? null;
  }

  async write(key: string, text: string): Promise<void> {
    this.writes.push(key);
    this.files.set(key, text);
  }
}

class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  trace(): void {
    // 测试里不记录。
  }
  debug(): void {
    // 测试里不记录。
  }
  info(): void {
    // 测试里不记录。
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {
    // 测试里不记录。
  }
  child(): Logger {
    return this;
  }
}

const DATA_DIR = '/var/lib/comem';
const SCOPE = 'user_alice';
const SESSION = 'sess_a';

function createLedger(): {
  readonly ledger: RecallLedger;
  readonly store: MemoryLedgerStore;
  readonly logger: RecordingLogger;
} {
  const store = new MemoryLedgerStore();
  const logger = new RecordingLogger();
  return { ledger: new RecallLedger({ dataDir: DATA_DIR, store, logger }), store, logger };
}

function ledgerPath(scopeKey: string): string {
  return join(DATA_DIR, '_meta', 'recall', `${scopeKey}.recall_log.json`);
}

function options(overrides: Partial<RecallLedgerOptions> = {}): RecallLedgerOptions {
  return { ...DEFAULT_RECALL_LEDGER_OPTIONS, ...overrides };
}

describe('scopeKeyOf', () => {
  it('取 URI 的作用域部分', () => {
    expect(scopeKeyOf(Uri.parse('comem://user/alice/memories/m1'))).toBe('user_alice');
    expect(scopeKeyOf(Uri.parse('comem://group/eng/projects/comem/x'))).toBe('group_eng');
  });
});

describe('RecallLedger.load', () => {
  it('文件不存在时返回空账本', async () => {
    const { ledger, store } = createLedger();

    await expect(ledger.load(SCOPE)).resolves.toEqual({ version: 1, entries: [] });
    expect(store.reads).toEqual([ledgerPath(SCOPE)]);
  });

  it('损坏的 JSON 按空账本处理并记 warn', async () => {
    const { ledger, store, logger } = createLedger();
    store.files.set(ledgerPath(SCOPE), '{not json');

    await expect(ledger.load(SCOPE)).resolves.toEqual({ version: 1, entries: [] });
    expect(logger.warnings).toHaveLength(1);
  });

  it('结构不合法时同样按空账本处理', async () => {
    const { ledger, store, logger } = createLedger();
    store.files.set(ledgerPath(SCOPE), JSON.stringify({ version: 2, entries: [] }));

    await expect(ledger.load(SCOPE)).resolves.toEqual({ version: 1, entries: [] });
    expect(logger.warnings).toHaveLength(1);
  });

  it('拒绝会拼出越界文件名的 scopeKey', async () => {
    const { ledger, store } = createLedger();

    for (const unsafe of ['../evil', 'a/b', '..', '.hidden', 'user\u0000alice', '']) {
      await expect(ledger.load(unsafe)).rejects.toBeInstanceOf(ComemError);
    }
    expect(store.reads).toEqual([]);
  });
});

describe('RecallLedger.save', () => {
  it('写盘再读回是同一份账本', async () => {
    const { ledger, store } = createLedger();
    const data = {
      version: 1 as const,
      entries: [
        {
          uri: 'comem://user/alice/memories/m1',
          sessionId: SESSION,
          turn: 4,
          detail: 'abstract' as const,
        },
      ],
    };

    await ledger.save(SCOPE, data);

    expect(store.writes).toEqual([ledgerPath(SCOPE)]);
    await expect(ledger.load(SCOPE)).resolves.toEqual(data);
  });

  it('拒绝不安全的 scopeKey', async () => {
    const { ledger } = createLedger();

    await expect(
      ledger.save('../evil', { version: 1, entries: [] }),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

describe('RecallLedger.record', () => {
  it('只记账真的给了正文的条目', async () => {
    const { ledger } = createLedger();

    await ledger.record(
      SCOPE,
      SESSION,
      3,
      [
        { uri: 'comem://user/alice/memories/m1', detail: 'abstract' },
        { uri: 'comem://user/alice/memories/m2', detail: null },
        { uri: 'comem://user/alice/memories/m3', detail: 'full' },
      ],
      options(),
    );

    const data = await ledger.load(SCOPE);
    expect(data.entries).toEqual([
      { uri: 'comem://user/alice/memories/m1', sessionId: SESSION, turn: 3, detail: 'abstract' },
      { uri: 'comem://user/alice/memories/m3', sessionId: SESSION, turn: 3, detail: 'full' },
    ]);
  });

  it('按 turn - 4 × dedupTurns 裁剪，更早的记录被丢弃', async () => {
    const { ledger } = createLedger();

    await ledger.record(
      SCOPE,
      SESSION,
      1,
      [{ uri: 'comem://user/alice/memories/old', detail: 'abstract' }],
      options(),
    );
    await ledger.record(
      SCOPE,
      SESSION,
      20,
      [{ uri: 'comem://user/alice/memories/new', detail: 'abstract' }],
      options(),
    );

    const data = await ledger.load(SCOPE);
    expect(data.entries.map((entry) => entry.uri)).toEqual(['comem://user/alice/memories/new']);
  });

  it('按条数裁剪时保留最新的记录', async () => {
    const { ledger } = createLedger();

    for (const turn of [1, 2, 3, 4, 5, 6]) {
      await ledger.record(
        SCOPE,
        SESSION,
        turn,
        [{ uri: `comem://user/alice/memories/p${turn}`, detail: 'abstract' }],
        options({ maxEntries: 3 }),
      );
    }

    const data = await ledger.load(SCOPE);
    expect(data.entries.map((entry) => entry.turn)).toEqual([4, 5, 6]);
  });

  it('turn 不合法时抛 INVALID_ARGUMENT', async () => {
    const { ledger } = createLedger();

    await expect(ledger.record(SCOPE, SESSION, -1, [], options())).rejects.toBeInstanceOf(
      ComemError,
    );
    await expect(ledger.record(SCOPE, SESSION, 1.5, [], options())).rejects.toBeInstanceOf(
      ComemError,
    );
  });

  it('sessionId 为空时抛 INVALID_ARGUMENT', async () => {
    const { ledger } = createLedger();

    await expect(ledger.record(SCOPE, '', 1, [], options())).rejects.toBeInstanceOf(ComemError);
  });

  it('裁剪参数不合法时抛 INVALID_ARGUMENT', async () => {
    const { ledger } = createLedger();

    await expect(
      ledger.record(SCOPE, SESSION, 1, [], { dedupTurns: -1, maxEntries: 500 }),
    ).rejects.toBeInstanceOf(ComemError);
    await expect(
      ledger.record(SCOPE, SESSION, 1, [], { dedupTurns: 3, maxEntries: 0 }),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

describe('RecallLedger.recentlyDelivered', () => {
  async function seed(ledger: RecallLedger): Promise<void> {
    for (const turn of [5, 6, 7, 8]) {
      await ledger.record(
        SCOPE,
        SESSION,
        turn,
        [{ uri: `comem://user/alice/memories/p${turn}`, detail: 'abstract' }],
        options(),
      );
    }
  }

  it('只返回窗口内的 URI', async () => {
    const { ledger } = createLedger();
    await seed(ledger);

    const delivered = await ledger.recentlyDelivered(SCOPE, SESSION, 10, options());

    expect([...delivered]).toEqual(['comem://user/alice/memories/p8']);
  });

  it('窗口边界严格大于 turn - dedupTurns', async () => {
    const { ledger } = createLedger();
    await seed(ledger);

    // turn = 9 时窗口是 (6, 9]，7 与 8 在窗口内，6 出窗。
    expect([...(await ledger.recentlyDelivered(SCOPE, SESSION, 9, options()))]).toEqual([
      'comem://user/alice/memories/p7',
      'comem://user/alice/memories/p8',
    ]);
    // turn = 8 时窗口是 (5, 8]，第 5 轮投过的应该还能再投。
    expect([...(await ledger.recentlyDelivered(SCOPE, SESSION, 8, options()))]).toEqual([
      'comem://user/alice/memories/p6',
      'comem://user/alice/memories/p7',
      'comem://user/alice/memories/p8',
    ]);
  });

  it('dedupTurns = 0 时窗口为空', async () => {
    const { ledger } = createLedger();
    await seed(ledger);

    expect(await ledger.recentlyDelivered(SCOPE, SESSION, 10, options({ dedupTurns: 0 }))).toEqual(new Set());
  });

  it('空账本返回空集合', async () => {
    const { ledger } = createLedger();

    expect(await ledger.recentlyDelivered(SCOPE, SESSION, 10, options())).toEqual(new Set());
  });

  it('sessionId 为空时抛 INVALID_ARGUMENT', async () => {
    const { ledger } = createLedger();

    await expect(ledger.recentlyDelivered(SCOPE, '', 10, options())).rejects.toBeInstanceOf(
      ComemError,
    );
  });

  it('同一作用域下另一个会话投过的 URI 不参与本次去重', async () => {
    const { ledger } = createLedger();
    const uriA = 'comem://user/alice/memories/from-session-a';
    const uriB = 'comem://user/alice/memories/from-session-b';

    await ledger.record(SCOPE, 'sess_a', 5, [{ uri: uriA, detail: 'abstract' }], options());
    await ledger.record(SCOPE, 'sess_b', 5, [{ uri: uriB, detail: 'abstract' }], options());

    // 会话 A 跑到第 6 轮时只看得到自己投过的 a；账本文件是共用的，条目不是。
    expect([...(await ledger.recentlyDelivered(SCOPE, 'sess_a', 6, options()))]).toEqual([uriA]);
    expect([...(await ledger.recentlyDelivered(SCOPE, 'sess_b', 6, options()))]).toEqual([uriB]);
  });

  it('比当前轮次更晚的记录被排除（未来轮次不参与去重）', async () => {
    const { ledger } = createLedger();
    const future = 'comem://user/alice/memories/future';

    await ledger.record(SCOPE, SESSION, 10, [{ uri: future, detail: 'abstract' }], options());

    // turn = 9 的窗口是 (6, 9]，第 10 轮在窗口之后，不是「刚投过」。
    expect(await ledger.recentlyDelivered(SCOPE, SESSION, 9, options())).toEqual(new Set());
    // 上界是闭区间：第 10 轮本身在窗口内。
    expect([...(await ledger.recentlyDelivered(SCOPE, SESSION, 10, options()))]).toEqual([future]);
  });

  it('没有 sessionId 的旧条目被忽略，不抛错', async () => {
    const { ledger, store } = createLedger();
    store.files.set(
      ledgerPath(SCOPE),
      JSON.stringify({
        version: 1,
        entries: [{ uri: 'comem://user/alice/memories/legacy', turn: 9, detail: 'abstract' }],
      }),
    );

    expect(await ledger.recentlyDelivered(SCOPE, SESSION, 10, options())).toEqual(new Set());
  });
});

describe('DEFAULT_RECALL_LEDGER_OPTIONS', () => {
  it('采用 §18 的 assembly.dedupTurns 与 §8.7 的上限', () => {
    expect(DEFAULT_RECALL_LEDGER_OPTIONS).toEqual({ dedupTurns: 3, maxEntries: 500 });
  });
});
