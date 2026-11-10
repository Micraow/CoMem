/**
 * `UserPromptSubmit`：召回并注入（架构文档 §15.2、§15.9、§8.8）。
 *
 * §15.9 的三条前提必须同时成立，任何一条不成立，200ms 的预热开销就是纯亏：
 * 召回为空不注入、低于阈值不注入、过滤后为空不检索。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRecallBlock, handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';
import { DEFAULT_CONFIG } from '../lib/config.mjs';

const RULES = ['s|^/\\w+.*$||', 's|```[\\s\\S]*?```||g', 's|^(ok\\|yes\\|继续)$||i'];

/** 出厂阈值（0.5）：相对阈值，见 §15.9。 */
const DEFAULT_THRESHOLD = DEFAULT_CONFIG.recallScoreThreshold;

/**
 * RRF 量级的真实分数（§13.2）：`hybrid` 引擎下 `2/61` 是双路命中名次 1 的上限，
 * `1/61` 是单路命中名次 1。旧的绝对阈值 `0.5` 会把它们全部丢掉。
 */
const RRF_TOP = 0.0328;
const RRF_SECOND = 0.0164;

function hit(uri, score, extra = {}) {
  return { uri, score, memoryType: null, contextType: null, abstract: null, ...extra };
}

function fakeHttp(hits) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      if (path === '/api/v1/search/find') {
        return hits;
      }
      return { ok: true };
    },
  };
}

function deps(hits, env = {}) {
  return {
    config: {
      userId: 'alice',
      queryFilters: RULES,
      recallLimit: 10,
      recallScoreThreshold: DEFAULT_THRESHOLD,
      tmpDir: '/tmp',
    },
    http: fakeHttp(hits),
    env,
  };
}

test('命中渲染成 <comem-recall> 块', async () => {
  const http = deps([
    { uri: 'comem://user/alice/memories/profile.md', score: 0.82, memoryType: 'profile', abstract: '后端工程师' },
  ]);
  const result = await handleUserPromptSubmit(
    { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript 怎么配' },
    http,
  );
  assert.match(result.context, /^<comem-recall>\n1\. \[profile\] comem:\/\/user\/alice\/memories\/profile\.md/);
  assert.match(result.context, /\n {2}后端工程师\n/);
  assert.match(result.context, /<\/comem-recall>$/);
  // 行首是编号，不是绝对分数：分数只在同一引擎内可比，写出来就是假精度。
  assert.doesNotMatch(result.context, /\[profile 0\.82\]/);
  // 请求带的是过滤后的 query。
  assert.equal(http.http.calls[0].body.query, 'TypeScript 怎么配');
});

test('召回为空不注入（不给模型一段「没有相关记忆」的废话）', async () => {
  const http = deps([]);
  const result = await handleUserPromptSubmit(
    { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript 怎么配' },
    http,
  );
  assert.equal(result, undefined);
  // 但请求发过了：空结果与「没检索」是两件事。
  assert.equal(http.http.calls.filter((call) => call.path === '/api/v1/search/find').length, 1);
});

test('hybrid 的 RRF 分数在默认阈值下仍然注入（绝对阈值会丢掉全部）', async () => {
  // 真实量级：`hybrid` 引擎的融合分只有 0.016–0.033（§13.2），旧的绝对阈值 0.5
  // 让这个 hook 在任何 hybrid 部署下都返回 undefined——功能从未工作过。
  const http = deps([
    { uri: 'comem://user/alice/memories/style.md', score: RRF_TOP, memoryType: 'profile', abstract: '偏好函数式写法' },
    { uri: 'comem://user/alice/memories/tools.md', score: RRF_SECOND, memoryType: 'profile' },
    { uri: 'comem://user/alice/memories/noise.md', score: 0.0049, memoryType: 'profile' },
    { uri: 'comem://user/alice/memories/weaker.md', score: 0.001, memoryType: 'profile' },
  ]);
  const result = await handleUserPromptSubmit(
    { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript 怎么配' },
    http,
  );
  assert.notEqual(result, undefined);
  assert.match(result.context, /comem:\/\/user\/alice\/memories\/style\.md/);
  // 阈值是相对最高分的：0.0164 >= 0.0328 × 0.5，留下。
  assert.match(result.context, /comem:\/\/user\/alice\/memories\/tools\.md/);
  // 0.0049 与 0.001 不到最高分的一半，是低分命中，裁掉。
  assert.doesNotMatch(result.context, /noise\.md/);
  assert.doesNotMatch(result.context, /weaker\.md/);
});

test('相对阈值裁掉低分命中（§15.9 的三条前提之二）', () => {
  const block = formatRecallBlock(
    [hit('comem://top', 0.0328), hit('comem://low', 0.001)],
    DEFAULT_THRESHOLD,
  );
  assert.match(block, /1\. \[memory\] comem:\/\/top/);
  assert.doesNotMatch(block, /comem:\/\/low/);
});

test('没有命中时返回 undefined（Math.max 在空数组上是 -Infinity）', () => {
  assert.equal(formatRecallBlock([], DEFAULT_THRESHOLD), undefined);
});

test('最高分为 0 或负时全部保留（分数不可用不静默丢数据）', () => {
  const block = formatRecallBlock([hit('comem://a', 0), hit('comem://b', -0.5)], DEFAULT_THRESHOLD);
  assert.match(block, /comem:\/\/a/);
  assert.match(block, /comem:\/\/b/);
});

test('过滤后为空就不检索（§8.8）', async () => {
  for (const prompt of ['/help', 'ok', '继续', '```\ncode\n```']) {
    const http = deps([]);
    const result = await handleUserPromptSubmit({ sessionId: 'cc-1', cwd: '/repo', prompt }, http);
    assert.equal(result, undefined, prompt);
    assert.equal(http.http.calls.length, 0, prompt);
  }
});

test('检索失败时静默放行（服务端没起不影响对话）', async () => {
  const http = {
    async post() {
      throw new Error('ECONNREFUSED');
    },
  };
  const result = await handleUserPromptSubmit(
    { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript 怎么配' },
    {
      config: { userId: 'alice', queryFilters: [], recallLimit: 10, recallScoreThreshold: 0.5, tmpDir: '/tmp' },
      http,
      env: {},
    },
  );
  assert.equal(result, undefined);
});

test('bypass 会话时不检索（§8.9）', async () => {
  const http = deps([]);
  const result = await handleUserPromptSubmit(
    { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript 怎么配' },
    { ...http, env: { COMEM_BYPASS_SESSION: '1' } },
  );
  assert.equal(result, undefined);
  assert.equal(http.http.calls.length, 0);
});

test('响应可以是 hits 数组或裸数组（两版服务端都认）', async () => {
  for (const payload of [
    [{ uri: 'comem://a', score: 0.9, abstract: null }],
    { hits: [{ uri: 'comem://a', score: 0.9, abstract: null }] },
  ]) {
    const http = deps(payload);
    const result = await handleUserPromptSubmit(
      { sessionId: 'cc-1', cwd: '/repo', prompt: 'TypeScript' },
      http,
    );
    assert.match(result.context, /comem:\/\/a/);
  }
});
