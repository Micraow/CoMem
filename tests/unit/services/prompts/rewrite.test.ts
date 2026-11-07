import { describe, expect, it } from 'vitest';

import {
  buildRewriteUserPrompt,
  REWRITE_SCHEMA,
  REWRITE_SYSTEM_PROMPT,
} from '../../../../src/services/prompts/rewrite.js';

/** 一条合法的模型产出。各用例只覆盖需要变化的字段。 */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: '用户的代码风格偏好',
    intent: 'preference',
    confidence: 0.9,
    derivedFrom: '编码规范',
    ...overrides,
  };
}

describe('REWRITE_SCHEMA', () => {
  it('解析合法输出', () => {
    const output = REWRITE_SCHEMA.parse({ queries: [draft()] });

    expect(output.queries).toEqual([
      {
        text: '用户的代码风格偏好',
        intent: 'preference',
        confidence: 0.9,
        derivedFrom: '编码规范',
      },
    ]);
  });

  it('空数组是合法输出', () => {
    expect(REWRITE_SCHEMA.parse({ queries: [] }).queries).toEqual([]);
  });

  it('超过 5 条被截断（§8.4 的 0–5 条）', () => {
    const queries = Array.from({ length: 8 }, (_, index) =>
      draft({ text: `查询 ${String(index)}`, confidence: 1 - index / 100 }),
    );

    const output = REWRITE_SCHEMA.parse({ queries });

    expect(output.queries).toHaveLength(5);
    expect(output.queries.map((query) => query.text)).toEqual([
      '查询 0',
      '查询 1',
      '查询 2',
      '查询 3',
      '查询 4',
    ]);
  });

  it('confidence 越界被 clamp 到 [0, 1]', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [draft({ confidence: 1.5 }), draft({ text: 'b', confidence: -0.2 })],
    });

    expect(output.queries.map((query) => query.confidence)).toEqual([1, 0]);
  });

  it('confidence 缺失或非数字落 0，数字字符串按数字解析', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [
        { text: 'a', intent: 'fact' },
        { text: 'b', intent: 'fact', confidence: '不是数字' },
        { text: 'c', intent: 'fact', confidence: '0.75' },
      ],
    });

    expect(output.queries.map((query) => query.confidence)).toEqual([0, 0, 0.75]);
  });

  it('text 为空的被丢弃', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [draft({ text: '' }), draft({ text: '   ' }), draft({ text: '有效' })],
    });

    expect(output.queries.map((query) => query.text)).toEqual(['有效']);
  });

  it('text 去掉首尾空白', () => {
    const output = REWRITE_SCHEMA.parse({ queries: [draft({ text: '  代码风格  ' })] });

    expect(output.queries[0]?.text).toBe('代码风格');
  });

  it('intent 非法值落到 other', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [draft({ text: 'a', intent: '感觉' }), draft({ text: 'b', intent: 'decision' })],
    });

    expect(output.queries.map((query) => query.intent)).toEqual(['other', 'decision']);
  });

  it('derivedFrom 缺失或空白落 null', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [{ text: 'a', intent: 'fact', confidence: 0.5 }, draft({ derivedFrom: '  ' })],
    });

    expect(output.queries.map((query) => query.derivedFrom)).toEqual([null, null]);
  });

  it('按 text 去重，保留置信度最高的那条', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [
        draft({ text: '代码风格', confidence: 0.4, derivedFrom: '低' }),
        draft({ text: '代码风格', confidence: 0.8, derivedFrom: '高' }),
        draft({ text: '  代码风格 ', confidence: 0.6 }),
      ],
    });

    expect(output.queries).toHaveLength(1);
    expect(output.queries[0]?.confidence).toBe(0.8);
    expect(output.queries[0]?.derivedFrom).toBe('高');
  });

  it('去重不看大小写', () => {
    const output = REWRITE_SCHEMA.parse({
      queries: [draft({ text: 'Code Style' }), draft({ text: 'code style', confidence: 0.3 })],
    });

    expect(output.queries).toHaveLength(1);
    expect(output.queries[0]?.text).toBe('Code Style');
  });
});

describe('REWRITE_SYSTEM_PROMPT', () => {
  it('写清「什么时候返回空数组」并给出理由', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('什么时候返回空数组');
    expect(REWRITE_SYSTEM_PROMPT).toContain('检索不到比检索错更浪费上下文');
    // 三类该返回空数组的输入必须逐条列出，否则模型只会按「通用知识」一条判断。
    expect(REWRITE_SYSTEM_PROMPT).toContain('寒暄');
    expect(REWRITE_SYSTEM_PROMPT).toContain('纯指令');
    expect(REWRITE_SYSTEM_PROMPT).toContain('通用知识');
  });

  it('写清「什么时候拆」与「什么时候不要拆」', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('什么时候拆成多条');
    expect(REWRITE_SYSTEM_PROMPT).toContain('什么时候不要拆');
    expect(REWRITE_SYSTEM_PROMPT).toContain('代码风格约定');
  });

  it('写清 derivedFrom 与「不要编造」', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('derivedFrom');
    expect(REWRITE_SYSTEM_PROMPT).toContain('原文片段');
    expect(REWRITE_SYSTEM_PROMPT).toContain('不能加入原 query 与历史里都没有的概念');
  });

  it('给出 JSON 结构、intent 取值与 5 条上限', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('"queries"');
    expect(REWRITE_SYSTEM_PROMPT).toContain('preference');
    expect(REWRITE_SYSTEM_PROMPT).toContain('procedure');
    expect(REWRITE_SYSTEM_PROMPT).toContain('最多 5 条');
  });
});

describe('buildRewriteUserPrompt', () => {
  it('渲染查询、历史与范围', () => {
    const prompt = buildRewriteUserPrompt({
      query: '那它呢',
      recentMessages: [
        { role: 'user', text: '我们讨论一下部署方案' },
        { role: 'assistant', text: '好，我建议用蓝绿部署' },
      ],
      knownScopes: ['comem://user/alice', 'comem://group/eng'],
    });

    expect(prompt).toContain('## 当前查询\n\n那它呢');
    expect(prompt).toContain('### user\n我们讨论一下部署方案');
    expect(prompt).toContain('### assistant\n好，我建议用蓝绿部署');
    expect(prompt).toContain('- comem://user/alice');
    expect(prompt).toContain('- comem://group/eng');
    expect(prompt).toContain('## 任务');
  });

  it('没有历史时明确说「没有」，不留空段', () => {
    const prompt = buildRewriteUserPrompt({
      query: '代码风格',
      recentMessages: [],
      knownScopes: ['comem://user/alice'],
    });

    expect(prompt).toContain('（这次没有历史消息。）');
  });

  it('没有范围时明确说「没有」', () => {
    const prompt = buildRewriteUserPrompt({
      query: '代码风格',
      recentMessages: [],
      knownScopes: [],
    });

    expect(prompt).toContain('（没有指定范围。）');
  });
});
