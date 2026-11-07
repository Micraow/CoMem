import { describe, expect, it } from 'vitest';

import {
  ABSTRACT_MAX_CHARS,
  DEFAULT_FRESHNESS_THRESHOLDS,
  OVERVIEW_MAX_CHARS,
  consumeChanges,
  extractAbstract,
  recordChange,
  shouldRecompute,
  truncateToChars,
  type SummaryFreshness,
} from '../../../src/domain/summary.js';

const OVERVIEW = [
  '# alice 的长期记忆',
  '',
  'alice 的代码风格偏好、正在做的 CoMem 项目，以及最近一次架构决策的记录。',
  '',
  '## 快速导航',
  '',
  '- `profile.md` —— 基本信息与角色',
  '- `preferences/` —— 按话题组织的偏好',
].join('\n');

function freshness(overrides: Partial<SummaryFreshness> = {}): SummaryFreshness {
  return { baseline: 'digest', pendingChanges: 0, totalEntries: 100, ...overrides };
}

describe('extractAbstract', () => {
  it('取 H1 之后、第一个 ## 之前的段落', () => {
    expect(extractAbstract(OVERVIEW)).toBe(
      'alice 的代码风格偏好、正在做的 CoMem 项目，以及最近一次架构决策的记录。',
    );
  });

  it('没有 H1 时从正文开头取', () => {
    expect(extractAbstract('一句话摘要\n\n第二段。\n\n## 快速导航\n\n- 条目')).toBe(
      '一句话摘要\n\n第二段。',
    );
  });

  it('H1 后直接跟 ## 时返回空串', () => {
    expect(extractAbstract('# 标题\n## 快速导航\n\n- 条目')).toBe('');
  });

  it('保留多个段落之间的空行', () => {
    expect(extractAbstract('# 标题\n\n第一段。\n\n第二段。\n\n## 详细说明\n\n正文')).toBe(
      '第一段。\n\n第二段。',
    );
  });

  it('空正文返回空串', () => {
    expect(extractAbstract('')).toBe('');
  });

  it('只有 H1 标题时返回空串', () => {
    expect(extractAbstract('# 标题')).toBe('');
  });

  it('兼容 CRLF 与末尾空行', () => {
    expect(extractAbstract('# 标题\r\n\r\n摘要。\r\n\r\n## 导航\r\n- 条目\r\n')).toBe('摘要。');
  });

  it('把 ### 也当作第一个二级标题截断', () => {
    expect(extractAbstract('# 标题\n\n摘要。\n\n### 更深的标题\n\n正文')).toBe('摘要。');
  });
});

describe('truncateToChars', () => {
  it('正好等于上限时原样返回', () => {
    expect(truncateToChars('abcde', 5)).toBe('abcde');
  });

  it('超一个字符时截掉最后一个', () => {
    expect(truncateToChars('abcdef', 5)).toBe('abcde');
  });

  it('按码点截断，不切碎 emoji 的代理对', () => {
    const truncated = truncateToChars('😀😀😀', 2);

    expect(truncated).toBe('😀😀');
    expect(Array.from(truncated)).toHaveLength(2);
    // 两个完整代理对是 4 个 UTF-16 码元；切碎会留下 3 个。
    expect(truncated).toHaveLength(4);
  });

  it('组合字符按码点计数，预算够时保留组合记号', () => {
    // `e` + U+0301（组合尖音符）+ `x`，共三个码点。
    expect(truncateToChars('e\u0301x', 2)).toBe('e\u0301');
    expect(truncateToChars('e\u0301x', 1)).toBe('e');
  });

  it('上限为 0 或负数时返回空串', () => {
    expect(truncateToChars('abc', 0)).toBe('');
    expect(truncateToChars('abc', -1)).toBe('');
  });

  it('上限大于长度时返回原文', () => {
    expect(truncateToChars('abc', 10)).toBe('abc');
  });

  it('常量与架构文档 §9.1 一致', () => {
    expect(ABSTRACT_MAX_CHARS).toBe(256);
    expect(OVERVIEW_MAX_CHARS).toBe(4000);
    expect(truncateToChars('字'.repeat(ABSTRACT_MAX_CHARS + 1), ABSTRACT_MAX_CHARS)).toHaveLength(
      ABSTRACT_MAX_CHARS,
    );
  });
});

describe('shouldRecompute', () => {
  it('没有基线时立刻重算', () => {
    expect(shouldRecompute(freshness({ baseline: null, pendingChanges: 0, totalEntries: 1000 }))).toBe(
      true,
    );
  });

  it('条目数不多于 32 时立刻重算', () => {
    expect(shouldRecompute(freshness({ totalEntries: 32, pendingChanges: 0 }))).toBe(true);
    expect(shouldRecompute(freshness({ totalEntries: 33, pendingChanges: 0 }))).toBe(false);
  });

  it('待刷新占比达到 10% 时立刻重算', () => {
    expect(shouldRecompute(freshness({ totalEntries: 100, pendingChanges: 10 }))).toBe(true);
    expect(shouldRecompute(freshness({ totalEntries: 100, pendingChanges: 9 }))).toBe(false);
  });

  it('大目录且占比不足时只记脏', () => {
    expect(shouldRecompute(freshness({ totalEntries: 1000, pendingChanges: 99 }))).toBe(false);
  });

  it('空目录不会除零，走立刻重算', () => {
    expect(shouldRecompute(freshness({ totalEntries: 0, pendingChanges: 0 }))).toBe(true);
  });

  it('阈值可以覆盖', () => {
    expect(
      shouldRecompute(freshness({ totalEntries: 10, pendingChanges: 1 }), {
        immediateEntryLimit: 5,
        ratioThreshold: 0.5,
      }),
    ).toBe(false);
    expect(DEFAULT_FRESHNESS_THRESHOLDS).toEqual({ immediateEntryLimit: 32, ratioThreshold: 0.1 });
  });
});

describe('consumeChanges', () => {
  it('消费时减而非清零：生成期间到达的改动保留', () => {
    // 生成开始快照 5，生成期间又来 3 条，写回时 pending 从 8 减到 3。
    expect(consumeChanges(freshness({ pendingChanges: 8 }), 5).pendingChanges).toBe(3);
  });

  it('正好消费完时归零', () => {
    expect(consumeChanges(freshness({ pendingChanges: 5 }), 5).pendingChanges).toBe(0);
  });

  it('快照大于当前计数时不会变成负数', () => {
    expect(consumeChanges(freshness({ pendingChanges: 2 }), 5).pendingChanges).toBe(0);
  });

  it('保留基线与条目数', () => {
    const consumed = consumeChanges(
      freshness({ baseline: 'abc', pendingChanges: 4, totalEntries: 300 }),
      1,
    );

    expect(consumed).toEqual({ baseline: 'abc', pendingChanges: 3, totalEntries: 300 });
  });
});

describe('recordChange', () => {
  it('每次改动加一，不改其它字段', () => {
    expect(recordChange(freshness({ pendingChanges: 5, totalEntries: 300 }))).toEqual({
      baseline: 'digest',
      pendingChanges: 6,
      totalEntries: 300,
    });
  });
});
