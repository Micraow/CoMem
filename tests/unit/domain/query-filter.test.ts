import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  applyQueryFilters,
  compileQueryFilter,
  compileQueryFilters,
} from '../../../src/domain/query-filter.js';

/** 架构文档 §8.8 的 YAML 示例，原样照抄。 */
const RULES = [
  's|^/\\w+.*$||',
  's|@[\\w/\\.\\-]+||g',
  's|```[\\s\\S]*?```||g',
  's|https?://\\S+||g',
  // §8.8 原文写的是 `s|^(ok|yes|继续|好|嗯)$||i`：分隔符与选择分支是同一个字符，
  // sed 语义下 pattern 里的 `|` 必须转义，否则无法确定 pattern 从哪结束。
  's|^(ok\\|yes\\|继续\\|好\\|嗯)$||i',
] as const;

function filter(rule: string): ReturnType<typeof compileQueryFilter> {
  return compileQueryFilter(rule);
}

function apply(rule: string, prompt: string): string {
  return applyQueryFilters(prompt, [filter(rule)]);
}

describe('compileQueryFilter', () => {
  it('编译 s|pattern|replacement|flags 形式', () => {
    const compiled = filter('s|foo|bar|g');
    expect(compiled.source).toBe('s|foo|bar|g');
    expect(compiled.replacement).toBe('bar');
    expect(compiled.pattern.flags).toContain('g');
  });

  it('分隔符可以是任意非字母数字字符', () => {
    expect(apply('s#foo#bar#', 'foo')).toBe('bar');
    expect(apply('s/foo/bar/', 'foo')).toBe('bar');
    expect(apply('s~foo~bar~g', 'foo foo')).toBe('bar bar');
    expect(apply('s%foo%bar%', 'foo')).toBe('bar');
  });

  it('没有 flags 时只替换第一处', () => {
    expect(apply('s|a|b|', 'aaa')).toBe('baa');
  });

  it('g 标志替换全部', () => {
    expect(apply('s|a|b|g', 'aaa')).toBe('bbb');
  });

  it('i 标志忽略大小写', () => {
    expect(apply('s|ok||i', 'OK')).toBe('');
    expect(apply('s|ok||', 'OK')).toBe('OK');
  });

  it('m 标志让 ^ 与 $ 匹配每一行', () => {
    expect(apply('s|^#|//|gm', '# a\n# b\nc')).toBe('// a\n// b\nc');
    // 只有 m 时 ^ 能匹配行首，但非 g 仍然只替换第一处。
    expect(apply('s|^#|//|m', '# a\n# b\nc')).toBe('// a\n# b\nc');
    // 只有 g 时 ^ 只锚定整串开头。
    expect(apply('s|^#|//|g', '# a\n# b\nc')).toBe('// a\n# b\nc');
  });

  it('替换串里的 $1 按 JS 语义透传', () => {
    expect(apply('s|(\\w+)@\\w+\\.com|$1|', 'alice@example.com')).toBe('alice');
  });

  it('替换串里的 $& 是整段命中', () => {
    expect(apply('s|b|[$&]|', 'abc')).toBe('a[b]c');
  });

  it('转义的分隔符还原后按 JS 正则语义解释', () => {
    // `\|` 还原成 `|`，在 JS 正则里是「选择分支」而不是字面量。
    expect(apply('s|a\\|b|X|g', 'ab')).toBe('XX');
    expect(apply('s|a\\|b|X|', 'ab')).toBe('Xb');
    // 字面量竖线写成字符类，两套语法的差异在这里收口。
    expect(apply('s|a[\\|]b|X|', 'a|b')).toBe('X');
    expect(apply('s|a[\\|]b|X|', 'ab')).toBe('ab');
  });

  it('非分隔符的转义原样保留', () => {
    expect(apply('s|\\d+|N|g', 'a1b22')).toBe('aNbN');
  });

  it('转义的分隔符在替换串里还原', () => {
    expect(apply('s|a|\\|b|', 'a')).toBe('|b');
  });

  describe('非法规则', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['', '规则不能为空'],
      ['x|a|b|', '规则必须以 s 开头'],
      ['s', '规则缺少分隔符'],
      ['saa', '分隔符不能是字母数字'],
      ['s\\a\\b\\', '分隔符不能是字母数字或反斜杠'],
      ['s|a', '分隔符'],
      ['s|a|b', '分隔符'],
      ['s|(|b|', '正则无法编译'],
      ['s|a|b|x', '不支持的标志'],
      ['s|a|b|y', '不支持的标志'],
      // §8.8 的第五行原文（分隔符没转义）：pattern 里出现未转义的 `|`，标志段就是
      // 剩下的全部内容，必须报错而不是猜一个切法。
      ['s|^(ok|yes|继续|好|嗯)$||i', '不支持的标志'],
    ];

    for (const [rule, expected] of cases) {
      it(`拒绝 ${JSON.stringify(rule)}`, () => {
        let caught: unknown;
        try {
          compileQueryFilter(rule);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ComemError);
        expect((caught as ComemError).code).toBe('INVALID_ARGUMENT');
        expect((caught as ComemError).message).toContain(expected);
      });
    }

    it('错误消息里带规则原文', () => {
      expect(() => compileQueryFilter('s|(|b|')).toThrow('s|(|b|');
      expect(() => compileQueryFilter('no-command')).toThrow('no-command');
    });
  });
});

describe('compileQueryFilters', () => {
  it('按输入顺序编译', () => {
    const compiled = compileQueryFilters(['s|a|1|', 's|b|2|']);
    expect(compiled.map((entry) => entry.source)).toEqual(['s|a|1|', 's|b|2|']);
  });

  it('空数组返回空数组', () => {
    expect(compileQueryFilters([])).toEqual([]);
  });

  it('任意一条非法就整体失败', () => {
    expect(() => compileQueryFilters(['s|a|b|', 'bad'])).toThrow(ComemError);
  });
});

describe('applyQueryFilters 的 §8.8 五条规则', () => {
  const filters = compileQueryFilters(RULES);

  it('去掉斜杠命令', () => {
    expect(applyQueryFilters('/help', filters)).toBe('');
    expect(applyQueryFilters('/model opus', filters)).toBe('');
    // 没有 m 标志时 ^ 只锚定整串开头，行内斜杠不动。
    expect(applyQueryFilters('看下 /help 这段', filters)).toBe('看下 /help 这段');
  });

  it('去掉 @文件提及', () => {
    expect(applyQueryFilters('@src/foo.ts', filters)).toBe('');
    expect(applyQueryFilters('看下 @src/foo.ts 这个', filters)).toBe('看下  这个');
    // 多处的 g 语义。
    expect(applyQueryFilters('@a.md @b.md 都看', filters)).toBe('  都看');
  });

  it('去掉代码块', () => {
    expect(applyQueryFilters('```js\nconst a = 1;\n```', filters)).toBe('');
    expect(applyQueryFilters('报错了：\n```\nTypeError: x\n```\n怎么办', filters)).toBe(
      '报错了：\n\n怎么办',
    );
  });

  it('去掉无实质内容', () => {
    for (const prompt of ['ok', 'OK', 'yes', '继续', '好', '嗯']) {
      expect(applyQueryFilters(prompt, filters)).toBe('');
    }
    expect(applyQueryFilters('继续吧', filters)).toBe('继续吧');
  });

  it('去掉 URL', () => {
    expect(applyQueryFilters('https://example.com/x', filters)).toBe('');
    expect(applyQueryFilters('看 https://example.com/x 这个', filters)).toBe('看  这个');
    expect(applyQueryFilters('http://a.b/c?d=e', filters)).toBe('');
  });

  it('多规则串联，顺序作用', () => {
    const prompt = '看下 @src/foo.ts 的实现，参考 https://example.com/x 和 ```const a = 1;``` 这段';
    expect(applyQueryFilters(prompt, filters)).toBe('看下  的实现，参考  和  这段');
  });

  it('没有规则时原样返回（除 NFC 规范化）', () => {
    expect(applyQueryFilters('abc', [])).toBe('abc');
  });
});

describe('applyQueryFilters 的空结果', () => {
  it('过滤后为空返回空串', () => {
    const filters = compileQueryFilters(['s|^(ok\\|yes\\|继续\\|好\\|嗯)$||i']);
    expect(applyQueryFilters('继续', filters)).toBe('');
  });

  it('规则把内容全删掉时返回空串', () => {
    expect(apply('s|.*||', '随便什么')).toBe('');
  });

  it('只剩空白时也按空串处理', () => {
    expect(apply('s|@[\\w/\\.\\-]+||g', '@src/foo.ts')).toBe('');
    expect(apply('s|@[\\w/\\.\\-]+||g', '   @src/foo.ts   ')).toBe('');
    expect(apply('s|@[\\w/\\.\\-]+||g', '看 @src/foo.ts')).toBe('看 ');
  });

  it('空串输入返回空串', () => {
    expect(applyQueryFilters('', compileQueryFilters(RULES))).toBe('');
  });
});

describe('applyQueryFilters 的 NFC 规范化', () => {
  it('分解形态的输入按合成形态匹配', () => {
    expect(apply('s|café|X|', 'cafe\u0301')).toBe('X');
  });

  it('即使没有规则，输出也是 NFC 形态', () => {
    expect(applyQueryFilters('cafe\u0301', [])).toBe('café');
  });

  it('全角输入按全角匹配', () => {
    expect(apply('s|ＡＢＣ|Ｘ|', 'ＡＢＣＤ')).toBe('ＸＤ');
    // NFC 不折叠全角：半角模式匹配不到全角输入。
    expect(apply('s|ABC|X|', 'ＡＢＣ')).toBe('ＡＢＣ');
  });
});
