/**
 * 查询过滤（架构文档 §8.8）。
 *
 * 五条规则逐条钉住：任何一条失效，噪音都会进检索，或者反过来把正常 prompt
 * 削成空串导致「这轮没有记忆」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ComemHookError } from '../lib/http.mjs';
import { applyQueryFilters, compileQueryFilter, compileQueryFilters } from '../lib/filter.mjs';

/** §8.8 的五条默认规则，原样抄自架构文档。 */
const RULES = [
  's|^/\\w+.*$||',
  's|@[\\w/\\.\\-]+||g',
  's|```[\\s\\S]*?```||g',
  's|https?://\\S+||g',
  's|^(ok\\|yes\\|继续\\|好\\|嗯)$||i',
];

test('斜杠命令整行被去掉', () => {
  // 规则是 `^/\w+.*$`：整行都算命令的一部分（`/model opus` 的参数也在里面）。
  assert.equal(applyQueryFilters('/help', RULES), '');
  assert.equal(applyQueryFilters('/model opus 怎么配置', RULES), '');
});

test('文件提及被去掉，保留其余文本', () => {
  assert.equal(applyQueryFilters('看看 @src/foo.ts 里的实现', RULES), '看看  里的实现');
  assert.equal(applyQueryFilters('@src/foo.ts', RULES), '');
});

test('代码块整段被去掉', () => {
  const prompt = '这段报错是什么\n```ts\nconst a: number = 1;\n```\n怎么修';
  assert.equal(applyQueryFilters(prompt, RULES), '这段报错是什么\n\n怎么修');
});

test('URL 被去掉', () => {
  assert.equal(applyQueryFilters('看 https://example.com/x 这个', RULES), '看  这个');
  assert.equal(applyQueryFilters('https://example.com/x', RULES), '');
});

test('无实质内容的整句被去掉（大小写不敏感）', () => {
  for (const prompt of ['继续', 'OK', 'yes', '好', '嗯']) {
    assert.equal(applyQueryFilters(prompt, RULES), '', prompt);
  }
  // 只匹配整句：带别的内容时保留。
  assert.equal(applyQueryFilters('继续 上次那个配置', RULES), '继续 上次那个配置');
});

test('规则按顺序作用，不是各自独立', () => {
  // 先去掉文件提及，再判断剩余是否为空。
  assert.equal(applyQueryFilters('@src/foo.ts', RULES), '');
  assert.equal(applyQueryFilters('@src/foo.ts 继续说', RULES), ' 继续说');
});

test('过滤后为空返回空串（调用方据此不检索）', () => {
  assert.equal(applyQueryFilters('```\ncode\n```', RULES), '');
  assert.equal(applyQueryFilters('   ', RULES), '');
  assert.equal(applyQueryFilters('', RULES), '');
});

test('过滤前后都做 NFC 规范化', () => {
  // `e` + U+0301（分解形态）应被 NFC 折叠成 `é`，规则才能命中。
  const decomposed = 'cafe\u0301 用 @src/x.ts';
  assert.equal(applyQueryFilters(decomposed, RULES), 'café 用 ');
});

test('非法规则抛出带原文的 HOOK_INVALID_ARGUMENT', () => {
  assert.throws(
    () => compileQueryFilter('s|foo'),
    (error) => {
      assert.ok(error instanceof ComemHookError);
      assert.equal(error.code, 'HOOK_INVALID_ARGUMENT');
      assert.match(error.message, /s\|foo/);
      return true;
    },
  );
  assert.throws(() => compileQueryFilter('x|foo|bar|'), /必须以 s 开头/);
  assert.throws(() => compileQueryFilter('s1foo1bar1'), /分隔符不能是字母数字/);
  assert.throws(() => compileQueryFilter('s|(|bar|'), /正则无法编译/);
  assert.throws(() => compileQueryFilter('s|foo|bar|z'), /不支持的标志：z/);
  assert.throws(() => compileQueryFilter(''), /规则不能为空/);
});

test('转义只保护分隔符本身：\\| 是选择分支，不是字面量竖线', () => {
  const filter = compileQueryFilter('s|^(ok\\|yes)$||i');
  // 还原后是 `^(ok|yes)$`：既匹配 ok 也匹配 yes。
  assert.equal('ok'.replace(filter.pattern, filter.replacement), '');
  assert.equal('yes'.replace(filter.pattern, filter.replacement), '');
  // 字面量竖线要写成字符集（§8.8 的 `[|]`），且必须换一个分隔符——`|` 作分隔符时
  // `[|]` 里的竖线会被当成规则的分隔符。
  const literal = compileQueryFilter('s/[|]//g');
  assert.equal('a|b'.replace(literal.pattern, literal.replacement), 'ab');
});

test('批量编译任意一条失败整体失败', () => {
  assert.throws(() => compileQueryFilters(['s|a|b|', 'broken']), /规则必须以 s 开头/);
});
