/**
 * 捕获侧剥离（架构文档 §15.10、`lib/sanitize.mjs`）。
 *
 * 这一层是**纯函数**：不起服务端、不碰 httpx 替身，输入输出就是字符串。
 * 用例的重点不是「能删」，而是**删的边界**：块与块之间的正文必须留下。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeCapturedMessages, sanitizeCapturedText } from '../lib/sanitize.mjs';

const RECALL = '<comem-recall>\n1. [profile] comem://user/alice/memories/a.md\n   后端工程师\n</comem-recall>';

test('四个块标签各自整段剥掉', () => {
  for (const tag of ['comem-recall', 'comem-profile', 'comem-preferences', 'system-reminder']) {
    const text = `before\n<${tag}>\n任意内容\n</${tag}>\nafter`;
    assert.equal(sanitizeCapturedText(text), 'before\n\nafter', tag);
  }
});

test('块与块之间的正文保留（贪婪正则会连正文一起吃掉）', () => {
  const text = `${RECALL}\n用户真正说的一句话\n${RECALL}`;
  assert.equal(sanitizeCapturedText(text), '用户真正说的一句话');
});

test('嵌套的块：按开标签之后的第一个闭标签剥，且不留孤立标签', () => {
  const text = '<comem-recall>外层开始 <comem-recall>内层</comem-recall> 尾巴</comem-recall>保留';
  // 第一次剥到内层闭标签（最近的那个），外层开标签之后没有闭标签，吃到末尾；
  // 残留的孤立闭标签被清掉。关键性质有两条：块外那一段「保留」必须还在，且
  // 剥完的文本里不再有任何 CoMem 块标签。
  const sanitized = sanitizeCapturedText(text);
  assert.equal(sanitized, '尾巴保留');
  assert.doesNotMatch(sanitized, /<\/?comem-/);
});

test('同一标签的三个块之间夹着正文，正文一条不少', () => {
  const text = `${RECALL}\n第一句\n${RECALL}\n第二句\n${RECALL}`;
  assert.equal(sanitizeCapturedText(text), '第一句\n\n第二句');
});

test('开标签没有闭标签时吃到末尾（留半截块比多删更糟）', () => {
  assert.equal(sanitizeCapturedText('用户的话\n<comem-recall>\n1. [profile] comem://x'), '用户的话');
});

test('行首时间戳被剥掉，行内的保留', () => {
  const text = '[2024-01-01T00:00:00Z] 用户问了一个问题\n他说 [2024-01-01T00:00:00Z] 在句子中间';
  assert.equal(sanitizeCapturedText(text), '用户问了一个问题\n他说 [2024-01-01T00:00:00Z] 在句子中间');
});

test('裸 epoch 只在块剥完之后处理：块内的数字随之消失，普通数字保留', () => {
  // 块里的 10 位数字属于被剥掉的内容，不该影响「块外正常数字」的判断。
  // 替换成空串（不是空格），所以原来的两个空格会留下——抽取器对空白不敏感。
  const text = '端口 8080 与版本 20240101 保留\n<comem-recall>1700000000</comem-recall>\n订单 1700000000 被吃掉';
  assert.equal(sanitizeCapturedText(text), '端口 8080 与版本 20240101 保留\n\n订单  被吃掉');
});

test('只由注入块组成的消息返回空串（调用方整条丢弃）', () => {
  assert.equal(sanitizeCapturedText(RECALL), '');
  assert.equal(sanitizeCapturedText('\n\n<system-reminder>提示</system-reminder>\n\n'), '');
});

test('普通消息只去掉首尾空白，内容一个字不改', () => {
  assert.equal(sanitizeCapturedText(' 你好，帮我看看这个 bug '), '你好，帮我看看这个 bug');
  assert.equal(sanitizeCapturedText('多行\n\n正文'), '多行\n\n正文');
});

test('消息列表：整条剥空的消息丢弃，其余保留文本 part', () => {
  const messages = [
    { id: 'u1', role: 'user', parts: [{ kind: 'text', text: RECALL }], createdAt: 't1' },
    { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '好的' }], createdAt: 't2' },
  ];
  const sanitized = sanitizeCapturedMessages(messages);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].id, 'a1');
  assert.deepEqual(sanitized[0].parts, [{ kind: 'text', text: '好的' }]);
});

test('消息列表：同一消息的多个 text part 各自剥，全空才丢', () => {
  const messages = [
    {
      id: 'u1',
      role: 'user',
      parts: [
        { kind: 'text', text: RECALL },
        { kind: 'text', text: '真正的问题' },
      ],
      createdAt: 't1',
    },
  ];
  const sanitized = sanitizeCapturedMessages(messages);
  assert.deepEqual(sanitized[0].parts, [{ kind: 'text', text: '真正的问题' }]);
});

test('非文本 part 原样保留，不因为它是唯一的 part 就丢消息', () => {
  const messages = [{ id: 't1', role: 'user', parts: [{ kind: 'tool', toolName: 'Read' }], createdAt: 't' }];
  const sanitized = sanitizeCapturedMessages(messages);
  assert.equal(sanitized.length, 1);
  assert.deepEqual(sanitized[0].parts, [{ kind: 'tool', toolName: 'Read' }]);
});

test('不修改入参（诊断还要用剥离前的消息）', () => {
  const messages = [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: RECALL }], createdAt: 't' }];
  sanitizeCapturedMessages(messages);
  assert.equal(messages[0].parts[0].text, RECALL);
});

/**
 * 性能：剥离在 `Stop` 的 worker 里跑，但 transcript 可以有几百 KB。这里用 1MB
 * 输入量一次，日志里留实测值——正则换成贪婪匹配或 `[\s\S]*?` 时耗时会长一个
 * 数量级，这条用例就是那道门。
 */
test('1MB 输入的剥离耗时', () => {
  const unit = `${RECALL}\n[2024-01-01T00:00:00Z] 用户说：这段是正文，1700000000 是 epoch。\n`;
  const text = unit.repeat(Math.ceil(1_048_576 / unit.length));
  assert.ok(text.length >= 1_048_576, `输入只有 ${text.length} 字符`);

  const startedAt = process.hrtime.bigint();
  const sanitized = sanitizeCapturedText(text);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  console.log(`[sanitize] ${(text.length / 1_048_576).toFixed(2)}MB 剥离耗时：${elapsedMs.toFixed(1)}ms`);
  // 输出必须变短（真的剥了），且没有把正文吃掉。
  assert.ok(sanitized.length < text.length);
  assert.match(sanitized, /用户说：这段是正文/);
  assert.doesNotMatch(sanitized, /<comem-recall>/);
  // 500ms 是「1MB 输入」的宽松上限：实测在个位数毫秒，跨环境留两个数量级。
  assert.ok(elapsedMs < 500, `1MB 输入耗时 ${elapsedMs.toFixed(1)}ms，超过 500ms`);
});
