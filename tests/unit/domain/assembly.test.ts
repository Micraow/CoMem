import { describe, expect, it } from 'vitest';

import { assembleContext, QUOTA_BY_PRESET } from '../../../src/domain/assembly.js';
import type {
  AssemblyCandidate,
  AssemblyOptions,
  AssemblyPorts,
} from '../../../src/domain/assembly.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import { renderAll, renderItem } from '../../../src/domain/render.js';
import type { ContextDetail } from '../../../src/domain/render.js';

class TestLogger implements Logger {
  trace(): void {
    // 测试里不记录。
  }
  debug(): void {
    // 测试里不记录。
  }
  info(): void {
    // 测试里不记录。
  }
  warn(): void {
    // 测试里不记录。
  }
  error(): void {
    // 测试里不记录。
  }
  child(): Logger {
    return this;
  }
}

interface PortsFixture {
  readonly ports: AssemblyPorts;
  readonly overviewCalls: readonly string[];
  readonly bodyCalls: readonly string[];
  peakConcurrency(): number;
}

interface PortsFixtureOptions {
  readonly overviews?: Readonly<Record<string, string | null>>;
  readonly bodies?: Readonly<Record<string, string | null>>;
  /** 默认按字符数算 token，测试里可以直接用长度推预算。 */
  readonly estimate?: (text: string) => number;
  readonly delayMs?: number;
}

function createPorts(options: PortsFixtureOptions = {}): PortsFixture {
  const overviews = options.overviews ?? {};
  const bodies = options.bodies ?? {};
  const estimate = options.estimate ?? ((text: string) => text.length);
  const delayMs = options.delayMs ?? 0;
  const overviewCalls: string[] = [];
  const bodyCalls: string[] = [];
  let active = 0;
  let peak = 0;

  const track = async <T>(calls: string[], uri: string, read: () => T): Promise<T> => {
    calls.push(uri);
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      return read();
    } finally {
      active -= 1;
    }
  };

  return {
    ports: {
      readOverview: (uri) => track(overviewCalls, uri, () => overviews[uri] ?? null),
      readBody: (uri) => track(bodyCalls, uri, () => bodies[uri] ?? null),
      estimateTokens: estimate,
      logger: new TestLogger(),
    },
    overviewCalls,
    bodyCalls,
    peakConcurrency: () => peak,
  };
}

interface CandidateOptions {
  readonly uri: string;
  readonly contextType?: ContextType;
  readonly memoryType?: string | null;
  readonly level?: Level;
  readonly score?: number;
  readonly abstract?: string | null;
}

function candidate(options: CandidateOptions): AssemblyCandidate {
  return {
    uri: options.uri,
    contextType: options.contextType ?? 'memory',
    memoryType: options.memoryType ?? null,
    level: options.level ?? 'L0',
    score: options.score ?? 1,
    abstract: options.abstract === undefined ? `摘要:${options.uri}` : options.abstract,
  };
}

const ESTIMATE = (text: string): number => text.length;

function costOf(
  target: AssemblyCandidate,
  detail: ContextDetail | null,
  text: string,
): number {
  return ESTIMATE(
    renderItem({
      uri: target.uri,
      contextType: target.contextType,
      score: target.score,
      detail,
      text,
    }),
  );
}

function options(overrides: Partial<AssemblyOptions> = {}): AssemblyOptions {
  return { maxTokens: 100_000, quotaPreset: 'chat', ...overrides };
}

function byUri<T extends { readonly uri: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((entry) => [entry.uri, entry] as const));
}

const ALICE = 'comem://user/alice';

describe('assembleContext 起始层', () => {
  it('events 从 L1 概览起投，其余从 L0 摘要起投', async () => {
    const event = candidate({
      uri: `${ALICE}/memories/events/architecture-decision`,
      memoryType: 'events',
      level: 'L1',
    });
    const preference = candidate({
      uri: `${ALICE}/memories/preferences/code-style`,
      memoryType: 'preferences',
    });
    const fixture = createPorts({ overviews: { [event.uri]: '一次架构决策的概览' } });

    const result = await assembleContext([event, preference], options(), fixture.ports);
    const items = byUri(result.items);

    expect(items.get(event.uri)?.detail).toBe('overview');
    expect(items.get(event.uri)?.text).toBe('一次架构决策的概览');
    expect(items.get(preference.uri)?.detail).toBe('abstract');
    expect(items.get(preference.uri)?.text).toBe(`摘要:${preference.uri}`);
    // 事件在起始投放时读概览；偏好条目要到升级轮次才读，且它没有概览文件。
    expect(fixture.overviewCalls).toEqual([event.uri, preference.uri]);
  });

  it('events 没有概览时继续降级到摘要', async () => {
    const event = candidate({
      uri: `${ALICE}/memories/events/e1`,
      memoryType: 'events',
      abstract: '事件摘要',
    });
    const fixture = createPorts({ overviews: { [event.uri]: null } });

    const result = await assembleContext([event], options(), fixture.ports);

    expect(result.items[0]?.detail).toBe('abstract');
    expect(result.items[0]?.text).toBe('事件摘要');
  });
});

describe('assembleContext 降级', () => {
  it('概览放不下时降到摘要', async () => {
    const event = candidate({
      uri: `${ALICE}/memories/events/e1`,
      memoryType: 'events',
      abstract: '事件摘要',
    });
    const fixture = createPorts({ overviews: { [event.uri]: '一段很长的概览' } });

    const result = await assembleContext(
      [event],
      options({ maxTokens: costOf(event, 'abstract', '事件摘要') }),
      fixture.ports,
    );

    expect(result.items[0]?.detail).toBe('abstract');
    expect(result.tokensUsed).toBeLessThanOrEqual(costOf(event, 'abstract', '事件摘要'));
  });

  it('摘要也放不下时只剩 URI', async () => {
    const event = candidate({
      uri: `${ALICE}/memories/events/e1`,
      memoryType: 'events',
      abstract: '事件摘要',
    });
    const fixture = createPorts({ overviews: { [event.uri]: '一段很长的概览' } });

    const result = await assembleContext(
      [event],
      options({ maxTokens: costOf(event, null, '') }),
      fixture.ports,
    );

    expect(result.items[0]?.detail).toBeNull();
    expect(result.items[0]?.text).toBe('');
    expect(result.items[0]?.tokens).toBe(costOf(event, null, ''));
    expect(result.dropped).toBe(0);
    expect(result.rendered).toContain(' />');
    expect(result.rendered).not.toContain('\n');
  });

  it('只剩 URI 也放不下时丢弃，并且一次文件都没读', async () => {
    const first = candidate({ uri: `${ALICE}/memories/m1`, score: 2, abstract: '摘要一' });
    const second = candidate({ uri: `${ALICE}/memories/m2`, score: 1, abstract: '摘要二' });
    const fixture = createPorts();

    const result = await assembleContext(
      [first, second],
      options({ maxTokens: costOf(first, null, '') }),
      fixture.ports,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uri).toBe(first.uri);
    expect(result.dropped).toBe(1);
    expect(fixture.overviewCalls).toEqual([]);
    expect(fixture.bodyCalls).toEqual([]);
  });
});

describe('assembleContext 升级', () => {
  it('第一轮升到概览；原文读一次后按预算放弃', async () => {
    const target = candidate({ uri: `${ALICE}/memories/m1`, abstract: '摘要' });
    const overview = '概览';
    const body = '原'.repeat(400);
    const fixture = createPorts({ overviews: { [target.uri]: overview }, bodies: { [target.uri]: body } });

    const maxTokens = costOf(target, 'abstract', '摘要') + costOf(target, 'overview', overview) + 5;
    const result = await assembleContext([target], options({ maxTokens }), fixture.ports);

    expect(result.items[0]?.detail).toBe('overview');
    expect(result.items[0]?.text).toBe(overview);
    // 第二轮读原文发现放不下；第三轮复用缓存，不再读。
    expect(fixture.bodyCalls).toEqual([target.uri]);
    expect(result.dropped).toBe(0);
  });

  it('第二轮升到 full，受单条上限放宽后的总预算约束', async () => {
    const target = candidate({ uri: `${ALICE}/memories/m1`, abstract: '摘要' });
    const body = '原'.repeat(50);
    const fixture = createPorts({
      overviews: { [target.uri]: '概览' },
      bodies: { [target.uri]: body },
    });

    const result = await assembleContext(
      [target],
      options({ maxTokens: costOf(target, 'full', body) + 10 }),
      fixture.ports,
    );

    expect(result.items[0]?.detail).toBe('full');
    expect(result.items[0]?.text).toBe(body);
    expect(result.items[0]?.tokens).toBe(costOf(target, 'full', body));
  });

  it('单条上限挡住第二轮，第三轮无上限时仍能升到 full', async () => {
    // 三条摘要长度相同，token 成本只由长度决定，所以一条探针就能代表全部。
    const abstracts = [0, 1, 2].map((index) => `摘要摘要摘要摘要摘要${index}`);
    const body = '原'.repeat(200);
    const targets = [3, 2, 1].map((score, index) =>
      candidate({ uri: `${ALICE}/memories/m${index}`, score, abstract: abstracts[index] ?? '' }),
    );
    const fixture = createPorts({
      overviews: Object.fromEntries(targets.map((target) => [target.uri, null])),
      bodies: Object.fromEntries(targets.map((target) => [target.uri, body])),
    });

    const probe = candidate({ uri: `${ALICE}/memories/m0`, score: 3, abstract: abstracts[0] ?? '' });
    const abstractCost = costOf(probe, 'abstract', abstracts[0] ?? '');
    const fullCost = costOf(probe, 'full', body);
    // 3 条候选时单条上限 = maxTokens / 3 × 2，取一个让 fullCost 超过上限、
    // 但总预算又装得下一条 full 的值。
    const maxTokens = 2 * abstractCost + fullCost + 10;

    const result = await assembleContext(targets, options({ maxTokens }), fixture.ports);

    expect(result.items.map((item) => item.detail)).toEqual(['full', 'abstract', 'abstract']);
    expect(result.tokensUsed).toBeLessThanOrEqual(maxTokens);
    expect(fixture.bodyCalls).toHaveLength(3);
    expect(result.dropped).toBe(0);
  });

  it('技能不会升到 full：不会读原文', async () => {
    const skill = candidate({
      uri: `${ALICE}/skills/typescript/SKILL`,
      contextType: 'skill',
      abstract: '技能摘要',
    });
    const fixture = createPorts({
      overviews: { [skill.uri]: '技能概览' },
      bodies: { [skill.uri]: '几万字的技能正文' },
    });

    const result = await assembleContext([skill], options(), fixture.ports);

    expect(result.items[0]?.detail).toBe('overview');
    expect(result.items[0]?.text).toBe('技能概览');
    expect(fixture.bodyCalls).toEqual([]);
  });

  it('会话停在天花板 abstract，不读概览也不读原文', async () => {
    const session = candidate({
      uri: `${ALICE}/sessions/s1`,
      contextType: 'session',
      abstract: '上一轮聊到上下文组装',
    });
    const fixture = createPorts({
      overviews: { [session.uri]: '会话概览' },
      bodies: { [session.uri]: '会话原文' },
    });

    const result = await assembleContext([session], options(), fixture.ports);

    expect(result.items[0]?.detail).toBe('abstract');
    expect(fixture.overviewCalls).toEqual([]);
    expect(fixture.bodyCalls).toEqual([]);
  });
});

describe('assembleContext 去重', () => {
  it('渲染后正文相同的条目只留分数最高的', async () => {
    const uri = `${ALICE}/memories/m1`;
    const l0 = candidate({ uri, level: 'L0', score: 1, abstract: '同一段正文' });
    const l2 = candidate({ uri, level: 'L2', score: 2, abstract: '同一段正文' });
    const fixture = createPorts();

    const result = await assembleContext([l0, l2], options(), fixture.ports);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.score).toBe(2);
    expect(result.items[0]?.level).toBe('L2');
    // 去重不是「预算或配额」的丢弃。
    expect(result.dropped).toBe(0);
  });

  it('只剩 URI 的条目按 URI 去重，不把不同地址误判成重复', async () => {
    const first = candidate({ uri: `${ALICE}/memories/m1`, score: 2, abstract: null });
    const second = candidate({ uri: `${ALICE}/memories/m2`, score: 1, abstract: null });
    const fixture = createPorts();

    const result = await assembleContext([first, second], options(), fixture.ports);

    expect(result.items.map((item) => item.uri)).toEqual([first.uri, second.uri]);
  });
});

describe('assembleContext 配额', () => {
  const categories: readonly ContextType[] = ['memory', 'resource', 'skill', 'session'];

  function quotaFixture(): AssemblyCandidate[] {
    const candidates: AssemblyCandidate[] = [];
    for (const contextType of categories) {
      const count = contextType === 'memory' ? 5 : contextType === 'resource' ? 6 : 3;
      for (let index = 0; index < count; index += 1) {
        candidates.push(
          candidate({
            uri: `${ALICE}/${contextType}/${index}`,
            contextType,
            score: 100 - candidates.length,
          }),
        );
      }
    }
    return candidates;
  }

  function countByType(
    items: readonly { readonly contextType: ContextType }[],
  ): Record<ContextType, number> {
    const counts: Record<ContextType, number> = { memory: 0, resource: 0, skill: 0, session: 0 };
    for (const item of items) {
      counts[item.contextType] += 1;
    }
    return counts;
  }

  it('chat 预设：记忆 5 / 资源 3 / 技能 2 / 会话 2', async () => {
    const fixture = createPorts();
    const result = await assembleContext(
      quotaFixture(),
      options({ quotaPreset: 'chat' }),
      fixture.ports,
    );

    expect(countByType(result.items)).toEqual({ memory: 5, resource: 3, skill: 2, session: 2 });
    expect(result.dropped).toBe(5);
  });

  it('coding 预设：记忆 3 / 资源 5 / 技能 2 / 会话 2', async () => {
    const fixture = createPorts();
    const result = await assembleContext(
      quotaFixture(),
      options({ quotaPreset: 'coding' }),
      fixture.ports,
    );

    expect(countByType(result.items)).toEqual({ memory: 3, resource: 5, skill: 2, session: 2 });
    expect(result.dropped).toBe(5);
  });

  it('配额表就是 §8.6 的表格', () => {
    expect(QUOTA_BY_PRESET.chat).toEqual({ memory: 5, resource: 3, skill: 2, session: 2 });
    expect(QUOTA_BY_PRESET.coding).toEqual({ memory: 3, resource: 5, skill: 2, session: 2 });
  });
});

describe('assembleContext 边界', () => {
  it('空候选返回空结果', async () => {
    const fixture = createPorts();

    const result = await assembleContext([], options(), fixture.ports);

    expect(result).toEqual({ items: [], rendered: '', dropped: 0, tokensUsed: 0 });
    expect(fixture.overviewCalls).toEqual([]);
    expect(fixture.bodyCalls).toEqual([]);
  });

  it('excludedUris 里的候选直接跳过，不计入 dropped', async () => {
    const kept = candidate({ uri: `${ALICE}/memories/m1`, score: 2 });
    const excluded = candidate({ uri: `${ALICE}/memories/m2`, score: 1 });
    const fixture = createPorts();

    const result = await assembleContext(
      [kept, excluded],
      options({ excludedUris: new Set([excluded.uri]) }),
      fixture.ports,
    );

    expect(result.items.map((item) => item.uri)).toEqual([kept.uri]);
    expect(result.dropped).toBe(0);
  });

  it('rendered 与 items 的渲染结果一致，tokensUsed 是各条之和', async () => {
    const targets = [2, 1].map((score, index) =>
      candidate({ uri: `${ALICE}/memories/m${index}`, score }),
    );
    const fixture = createPorts();

    const result = await assembleContext(targets, options(), fixture.ports);

    expect(result.rendered).toBe(renderAll(result.items));
    expect(result.tokensUsed).toBe(result.items.reduce((sum, item) => sum + item.tokens, 0));
    expect(result.tokensUsed).toBeLessThanOrEqual(100_000);
    expect(result.rendered).toContain('<memory ');
  });

  it('maxTokens 非法时抛 INVALID_ARGUMENT', async () => {
    const fixture = createPorts();

    await expect(
      assembleContext([candidate({ uri: `${ALICE}/memories/m1` })], options({ maxTokens: -1 }), fixture.ports),
    ).rejects.toBeInstanceOf(ComemError);
    await expect(
      assembleContext(
        [candidate({ uri: `${ALICE}/memories/m1` })],
        options({ maxTokens: Number.NaN }),
        fixture.ports,
      ),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

describe('assembleContext 读取成本', () => {
  it('同一 URI 只读一次概览', async () => {
    const uri = `${ALICE}/memories/m1`;
    // 两条同 URI 不同层级的记录：去重前会对同一个 URI 各尝试一次升级。
    const l0 = candidate({ uri, level: 'L0', score: 1, abstract: '摘要甲' });
    const l1 = candidate({ uri, level: 'L1', score: 2, abstract: '摘要乙' });
    const fixture = createPorts({
      overviews: { [uri]: '概览' },
      bodies: { [uri]: '原文' },
    });

    await assembleContext([l0, l1], options(), fixture.ports);

    expect(fixture.overviewCalls).toEqual([uri]);
  });

  it('并发峰值不超过 8', async () => {
    const targets = Array.from({ length: 20 }, (_, index) =>
      candidate({ uri: `${ALICE}/memories/m${index}`, score: 100 - index }),
    );
    const fixture = createPorts({
      overviews: Object.fromEntries(targets.map((target) => [target.uri, '概览'])),
      bodies: Object.fromEntries(targets.map((target) => [target.uri, '原文'])),
      delayMs: 2,
    });

    await assembleContext(targets, options(), fixture.ports);

    expect(fixture.peakConcurrency()).toBeLessThanOrEqual(8);
    expect(fixture.peakConcurrency()).toBe(8);
    expect(fixture.overviewCalls).toHaveLength(20);
  });
});
