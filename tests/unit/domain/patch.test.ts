import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import { applyPatch, parsePatchBlocks } from '../../../src/domain/patch.js';

function expectInvalidArgument(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('INVALID_ARGUMENT');
    return;
  }
  throw new Error('期望抛出 ComemError');
}

function patchText(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('parsePatchBlocks', () => {
  it('解析单个块', () => {
    const text = patchText(['<<<<<<< SEARCH', 'old', '=======', 'new', '>>>>>>> REPLACE']);

    expect(parsePatchBlocks(text)).toEqual([{ search: 'old', replace: 'new' }]);
  });

  it('解析多个块并忽略块外文本', () => {
    const text = patchText([
      '先说明一下。',
      '<<<<<<< SEARCH',
      'a',
      '=======',
      'b',
      '>>>>>>> REPLACE',
      '块之间的说明。',
      '<<<<<<< SEARCH',
      'c',
      '=======',
      'd',
      '>>>>>>> REPLACE',
      '结束。',
    ]);

    expect(parsePatchBlocks(text)).toEqual([
      { search: 'a', replace: 'b' },
      { search: 'c', replace: 'd' },
    ]);
  });

  it('空文本返回空数组', () => {
    expect(parsePatchBlocks('')).toEqual([]);
  });

  it('CRLF 归一化成 LF', () => {
    const text = patchText([
      '<<<<<<< SEARCH',
      'old',
      '=======',
      'new',
      '>>>>>>> REPLACE',
    ]).replaceAll('\n', '\r\n');

    expect(parsePatchBlocks(text)).toEqual([{ search: 'old', replace: 'new' }]);
  });

  it('空 SEARCH 解析为空字符串', () => {
    const text = patchText(['<<<<<<< SEARCH', '=======', 'appended', '>>>>>>> REPLACE']);

    expect(parsePatchBlocks(text)).toEqual([{ search: '', replace: 'appended' }]);
  });

  it('空 REPLACE 解析为空字符串', () => {
    const text = patchText(['<<<<<<< SEARCH', 'removed', '=======', '>>>>>>> REPLACE']);

    expect(parsePatchBlocks(text)).toEqual([{ search: 'removed', replace: '' }]);
  });

  it('块内容里的 ======= 字面量不会被误判为分隔符', () => {
    const text = patchText([
      '<<<<<<< SEARCH',
      "const divider = '=======';",
      '  =======',
      '======= 带后缀',
      '=======',
      'const divider = "---";',
      '>>>>>>> REPLACE',
    ]);

    expect(parsePatchBlocks(text)).toEqual([
      {
        search: ["const divider = '=======';", '  =======', '======= 带后缀'].join('\n'),
        replace: 'const divider = "---";',
      },
    ]);
  });

  it('缺少分隔符时抛 INVALID_ARGUMENT', () => {
    const text = patchText(['<<<<<<< SEARCH', 'old', '>>>>>>> REPLACE']);
    expectInvalidArgument(() => parsePatchBlocks(text));
  });

  it('缺少结束标记时抛 INVALID_ARGUMENT', () => {
    const text = patchText(['<<<<<<< SEARCH', 'old', '=======']);
    expectInvalidArgument(() => parsePatchBlocks(text));
  });

  it('块内嵌套开始标记时抛 INVALID_ARGUMENT', () => {
    const text = patchText([
      '<<<<<<< SEARCH',
      'old',
      '<<<<<<< SEARCH',
      '=======',
      'new',
      '>>>>>>> REPLACE',
    ]);
    expectInvalidArgument(() => parsePatchBlocks(text));
  });

  it('REPLACE 段里出现 SEARCH 开始标记时抛 INVALID_ARGUMENT', () => {
    const text = patchText([
      '<<<<<<< SEARCH',
      'old',
      '=======',
      'new',
      '<<<<<<< SEARCH',
      '>>>>>>> REPLACE',
    ]);
    expectInvalidArgument(() => parsePatchBlocks(text));
  });
});

describe('applyPatch', () => {
  it('唯一命中时替换', () => {
    expect(applyPatch('hello world', [{ search: 'world', replace: 'there' }])).toEqual({
      ok: true,
      content: 'hello there',
      appliedCount: 1,
    });
  });

  it('零命中返回 not_found', () => {
    expect(applyPatch('hello', [{ search: 'world', replace: 'x' }])).toEqual({
      ok: false,
      reason: 'not_found',
      blockIndex: 0,
      matches: 0,
    });
  });

  it('多处命中返回 ambiguous', () => {
    expect(applyPatch('foo foo', [{ search: 'foo', replace: 'bar' }])).toEqual({
      ok: false,
      reason: 'ambiguous',
      blockIndex: 0,
      matches: 2,
    });
  });

  it('重叠命中也算多处', () => {
    expect(applyPatch('aaa', [{ search: 'aa', replace: 'b' }])).toEqual({
      ok: false,
      reason: 'ambiguous',
      blockIndex: 0,
      matches: 2,
    });
  });

  it('多块按顺序应用：后一块匹配前一块的结果', () => {
    expect(
      applyPatch('one two', [
        { search: 'one', replace: '1' },
        { search: '1 two', replace: 'uno dos' },
      ]),
    ).toEqual({ ok: true, content: 'uno dos', appliedCount: 2 });
  });

  it('块之间有重叠文本时按顺序匹配', () => {
    expect(
      applyPatch('abc', [
        { search: 'ab', replace: 'x' },
        { search: 'xc', replace: 'y' },
      ]),
    ).toEqual({ ok: true, content: 'y', appliedCount: 2 });
  });

  it('后面的块失败时返回失败块的下标', () => {
    expect(
      applyPatch('one two', [
        { search: 'one', replace: '1' },
        { search: 'missing', replace: 'x' },
      ]),
    ).toEqual({ ok: false, reason: 'not_found', blockIndex: 1, matches: 0 });
  });

  it('空 SEARCH 追加到末尾并补换行', () => {
    expect(applyPatch('first', [{ search: '', replace: 'second' }])).toEqual({
      ok: true,
      content: 'first\nsecond',
      appliedCount: 1,
    });
    expect(applyPatch('first\n', [{ search: '', replace: 'second' }])).toEqual({
      ok: true,
      content: 'first\nsecond',
      appliedCount: 1,
    });
  });

  it('空正文上的空 SEARCH 直接写入', () => {
    expect(applyPatch('', [{ search: '', replace: 'only' }])).toEqual({
      ok: true,
      content: 'only',
      appliedCount: 1,
    });
  });

  it('多个空 SEARCH 保持顺序', () => {
    expect(
      applyPatch('first', [
        { search: '', replace: 'second' },
        { search: '', replace: 'third' },
      ]),
    ).toEqual({ ok: true, content: 'first\nsecond\nthird', appliedCount: 2 });
  });

  it('空 SEARCH + 空 REPLACE 不改正文', () => {
    expect(applyPatch('first', [{ search: '', replace: '' }])).toEqual({
      ok: true,
      content: 'first',
      appliedCount: 1,
    });
  });

  it('CRLF 正文与 LF 块能匹配，输出使用 LF', () => {
    expect(applyPatch('one\r\ntwo', [{ search: 'one\ntwo', replace: 'uno\ndos' }])).toEqual({
      ok: true,
      content: 'uno\ndos',
      appliedCount: 1,
    });
  });

  it('块体里的 CRLF 也归一化', () => {
    expect(
      applyPatch('one\ntwo', [{ search: 'one\r\ntwo', replace: 'uno\r\ndos' }]),
    ).toEqual({ ok: true, content: 'uno\ndos', appliedCount: 1 });
  });

  it('没有块时只做换行归一化', () => {
    expect(applyPatch('a\r\nb', [])).toEqual({ ok: true, content: 'a\nb', appliedCount: 0 });
  });

  it('SEARCH 可以跨行', () => {
    expect(applyPatch('a\nb\nc', [{ search: 'a\nb', replace: 'x' }])).toEqual({
      ok: true,
      content: 'x\nc',
      appliedCount: 1,
    });
  });

  it('REPLACE 为空字符串表示删除', () => {
    expect(applyPatch('remove me', [{ search: 'remove ', replace: '' }])).toEqual({
      ok: true,
      content: 'me',
      appliedCount: 1,
    });
  });

  it('SEARCH 命中开头与结尾', () => {
    expect(applyPatch('abc', [{ search: 'a', replace: 'x' }])).toEqual({
      ok: true,
      content: 'xbc',
      appliedCount: 1,
    });
    expect(applyPatch('abc', [{ search: 'c', replace: 'x' }])).toEqual({
      ok: true,
      content: 'abx',
      appliedCount: 1,
    });
  });

  it('块内容里的 ======= 字面量能正常应用', () => {
    const text = patchText([
      '<<<<<<< SEARCH',
      "const divider = '=======';",
      '=======',
      'const divider = "---";',
      '>>>>>>> REPLACE',
    ]);
    const blocks = parsePatchBlocks(text);

    expect(applyPatch("const divider = '=======';\n", blocks)).toEqual({
      ok: true,
      content: 'const divider = "---";\n',
      appliedCount: 1,
    });
  });
});
