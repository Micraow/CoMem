import { describe, expect, it } from 'vitest';

import { segmentCjk } from '../../../src/domain/text.js';

describe('segmentCjk', () => {
  it('每个 CJK 字符两侧补空格', () => {
    expect(segmentCjk('记忆')).toBe('记 忆');
    expect(segmentCjk('上下文记忆数据库的设计')).toBe('上 下 文 记 忆 数 据 库 的 设 计');
  });

  it('幂等：切分两次与一次相同', () => {
    const inputs = [
      '上下文记忆数据库的设计',
      'TypeScript 严格模式',
      '混合 TypeScript 严格 模式',
      '，。：；！？「」',
      'カタカナ と ひらがな',
      '𠀀𠀁',
      '',
      '   ',
      'a\tb\n c ',
    ];
    for (const input of inputs) {
      const once = segmentCjk(input);
      expect(segmentCjk(once)).toBe(once);
    }
  });

  it('非 CJK 文本原样返回（只合并空白）', () => {
    expect(segmentCjk('TypeScript strict mode')).toBe('TypeScript strict mode');
    expect(segmentCjk('  a \t b\n\n c ')).toBe('a b c');
    expect(segmentCjk('a"b*c(x)-y')).toBe('a"b*c(x)-y');
  });

  it('空串与纯空白返回空串', () => {
    expect(segmentCjk('')).toBe('');
    expect(segmentCjk(' \n\t ')).toBe('');
  });

  it('全角标点不是 CJK 字符，不切分', () => {
    expect(segmentCjk('，。：；！？「」')).toBe('，。：；！？「」');
    expect(segmentCjk('记忆，数据库。')).toBe('记 忆 ， 数 据 库 。');
  });

  it('覆盖假名、扩展 A、兼容区', () => {
    expect(segmentCjk('カタカナ')).toBe('カ タ カ ナ');
    // U+3400 是扩展 A 的第一个字符。
    expect(segmentCjk('㐀㐁')).toBe('㐀 㐁');
    // U+F900 是兼容区汉字。
    expect(segmentCjk('豈更')).toBe('豈 更');
    // 补充平面（扩展 B）不在四个区间里，原样保留。
    expect(segmentCjk('𠀀')).toBe('𠀀');
  });

  it('混合中英按字符切分，英文单词保持完整', () => {
    expect(segmentCjk('TypeScript 严格模式')).toBe('TypeScript 严 格 模 式');
    expect(segmentCjk('用 FTS5 建索引')).toBe('用 FTS5 建 索 引');
  });
});
