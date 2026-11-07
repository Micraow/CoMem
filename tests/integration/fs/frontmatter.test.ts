import { describe, expect, it } from 'vitest';

import { parseDocument, serializeDocument } from '../../../src/adapters/fs/frontmatter.js';
import { ComemError } from '../../../src/domain/errors.js';

function expectInvalidArgument(run: () => unknown): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_ARGUMENT');
  return error;
}

describe('parseDocument', () => {
  it('没有 frontmatter 时整段都是正文', () => {
    const raw = '# 标题\n\n第一段。\n第二段。\n';
    const document = parseDocument(raw);

    expect(document.hasFrontmatter).toBe(false);
    expect(document.data).toEqual({});
    expect(document.body).toBe(raw);
  });

  it('拆出 frontmatter 与正文（架构文档 §6.6 的示例）', () => {
    const raw = [
      '---',
      'memory_type: preferences',
      'topic: code-style',
      'uri: comem://user/alice/memories/preferences/code-style',
      'status: active',
      'created_at: 2026-10-28T09:12:00Z',
      'updated_at: 2026-11-05T16:40:00Z',
      '---',
      '',
      '## content',
      '',
      '用户偏好 TypeScript 严格模式。',
      '',
    ].join('\n');

    const document = parseDocument(raw);

    expect(document.hasFrontmatter).toBe(true);
    expect(document.body).toBe('## content\n\n用户偏好 TypeScript 严格模式。\n');
    expect(document.data).toEqual({
      memory_type: 'preferences',
      topic: 'code-style',
      uri: 'comem://user/alice/memories/preferences/code-style',
      status: 'active',
      created_at: '2026-10-28T09:12:00Z',
      updated_at: '2026-11-05T16:40:00Z',
    });
  });

  it('空 frontmatter 合法，data 是空对象', () => {
    const document = parseDocument('---\n---\n正文');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({});
    expect(document.body).toBe('正文');
  });

  it('空 frontmatter 后面直接跟空行也合法', () => {
    const document = parseDocument('---\n---\n\n正文');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({});
    expect(document.body).toBe('正文');
  });

  it('只有 frontmatter 没有正文', () => {
    const document = parseDocument('---\nk: v\n---');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({ k: 'v' });
    expect(document.body).toBe('');
  });

  it('正文里的 --- 是 Markdown 水平线，不是 frontmatter 边界', () => {
    const document = parseDocument('---\nk: v\n---\n\nline1\n---\nline2');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({ k: 'v' });
    expect(document.body).toBe('line1\n---\nline2');
  });

  it('只认第一行的 ---', () => {
    const raw = '正文\n---\nk: v\n---\n正文2';
    const document = parseDocument(raw);

    expect(document.hasFrontmatter).toBe(false);
    expect(document.data).toEqual({});
    expect(document.body).toBe(raw);
  });

  it('没有闭合分隔符时整段都是正文', () => {
    const raw = '---\nk: v\n';
    const document = parseDocument(raw);

    expect(document.hasFrontmatter).toBe(false);
    expect(document.body).toBe(raw);
  });

  it('只有一行 --- 时不是 frontmatter', () => {
    const document = parseDocument('---');

    expect(document.hasFrontmatter).toBe(false);
    expect(document.body).toBe('---');
  });

  it('CRLF 原样保留，不归一化成 LF', () => {
    const document = parseDocument('---\r\nk: v\r\n---\r\n\r\nline1\r\nline2');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({ k: 'v' });
    expect(document.body).toBe('line1\r\nline2');
  });

  it('剥掉开头的 BOM', () => {
    const document = parseDocument('\uFEFF---\nk: v\n---\nbody');

    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({ k: 'v' });
    expect(document.body).toBe('body');
  });

  it('正文里的 BOM 保留（只剥开头一个）', () => {
    expect(parseDocument('\uFEFF\uFEFFbody').body).toBe('\uFEFFbody');
    expect(parseDocument('body\uFEFF').body).toBe('body\uFEFF');
  });

  it('YAML 语法错误抛 INVALID_ARGUMENT，消息里带文件行号', () => {
    const error = expectInvalidArgument(() => parseDocument('---\na: 1\nb: [\n---\nbody'));

    // YAML 文档从文件第 2 行开始，解析器报第 2 行 → 文件第 3 行。
    expect(error.message).toContain('第 3 行');
    expect(error.details).toMatchObject({ line: 3 });
  });

  it('frontmatter 不是键值对时抛 INVALID_ARGUMENT', () => {
    const error = expectInvalidArgument(() => parseDocument('---\njust a scalar\n---\nbody'));

    expect(error.message).toContain('frontmatter 必须是键值对');
  });

  it('frontmatter 是数组时抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => parseDocument('---\n- a\n- b\n---\nbody'));
  });
});

describe('serializeDocument', () => {
  it('没有键时不写空块', () => {
    expect(serializeDocument('正文', {})).toBe('正文');
  });

  it('按架构文档 §6.6 的格式输出', () => {
    expect(serializeDocument('正文', { k: 'v' })).toBe('---\nk: v\n---\n\n正文');
  });

  it('保持 Object.keys 顺序，不排序', () => {
    const text = serializeDocument('正文', { z: 1, a: 2, m: 3 });

    // 重排会让同一份 frontmatter 产生不同字节，摘要 digest 会永远对不上。
    expect(text.indexOf('z: 1')).toBeLessThan(text.indexOf('a: 2'));
    expect(text.indexOf('a: 2')).toBeLessThan(text.indexOf('m: 3'));
  });

  it('长值不被折行', () => {
    const uri = `comem://user/alice/${'very-long-segment-'.repeat(8)}end.md`;
    const text = serializeDocument('正文', { uri });

    expect(text).toContain(uri);
    // `---` / `uri: ...` / `---` / 空行 / 正文
    expect(text.split('\n')).toHaveLength(5);
  });

  it('未知键原样保留，类型不变', () => {
    const data = {
      uri: 'comem://user/alice/memories',
      generated_by: 'summary.service',
      generated_at: '2026-11-05T16:41:02Z',
      freshness: { total_entries: 6, pending_changes: 0 },
      summary_state: 'fresh',
      tags: ['a', 'b'],
      enabled: true,
      nullValue: null,
    };

    const document = parseDocument(serializeDocument('正文', data));

    expect(document.data).toEqual(data);
    expect(document.body).toBe('正文');
  });
});

/**
 * 确定性线性同余伪随机（Numerical Recipes 的 LCG 参数）：测试失败可以原样复现。
 */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** 正文里最容易踩到边界的片段：分隔符、换行风格、BOM、标题、emoji。 */
const BODY_TOKENS = [
  '---',
  '\n',
  '\r\n',
  '\r',
  ' ',
  '\t',
  '#',
  '## 标题',
  '中文正文',
  '😀',
  '- 列表项',
  '> 引用',
  '`code`',
  '\\',
  '\uFEFF',
  'a',
  '\n---\n',
];

const ROUND_TRIP_DATA = {
  memory_type: 'preferences',
  uri: 'comem://user/alice/memories/preferences/code-style',
  status: 'active',
  created_at: '2026-10-28T09:12:00Z',
  freshness: { total_entries: 6, pending_changes: 0 },
  summary_state: 'stale',
  tags: ['typescript', '严格模式'],
};

function randomBody(random: () => number): string {
  const tokenCount = Math.floor(random() * 12);
  let body = '';
  for (let index = 0; index < tokenCount; index += 1) {
    body += BODY_TOKENS[Math.floor(random() * BODY_TOKENS.length)] ?? '';
  }
  return body;
}

describe('parseDocument(serializeDocument(...)) 往返稳定', () => {
  it('随机正文 20 个用例逐字节稳定', () => {
    const random = createRandom(20261105);

    for (let index = 0; index < 20; index += 1) {
      const body = randomBody(random);
      const document = parseDocument(serializeDocument(body, ROUND_TRIP_DATA));

      expect(document.body, `第 ${index + 1} 个用例的正文`).toBe(body);
      expect(document.data, `第 ${index + 1} 个用例的 frontmatter`).toEqual(ROUND_TRIP_DATA);
      expect(document.hasFrontmatter).toBe(true);
    }
  });

  it('极端正文逐字节稳定', () => {
    const bodies = [
      '',
      '\n',
      '\n\n',
      '\r\n',
      '---',
      '---\n---',
      '---\nkey: value\n---',
      '正文\n---\n正文',
      '\uFEFF',
      '\uFEFF---\n',
      '中文 😀\r\n第二行\n\n\n第三行',
    ];

    for (const body of bodies) {
      const document = parseDocument(serializeDocument(body, { k: 'v' }));

      expect(document.body, JSON.stringify(body)).toBe(body);
      expect(document.data).toEqual({ k: 'v' });
    }
  });

  it('空 data 的往返也不丢正文', () => {
    for (const body of ['', '\n', '---\n', '正文']) {
      const document = parseDocument(serializeDocument(body, {}));

      expect(document.body, JSON.stringify(body)).toBe(body);
      expect(document.data).toEqual({});
      expect(document.hasFrontmatter).toBe(false);
    }
  });
});
