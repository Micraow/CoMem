/**
 * `UserPromptSubmit`：召回并注入（架构文档 §15.2、§15.9、§8.8）。
 *
 * §15.9 的三条前提必须同时成立，任何一条不成立，200ms 的预热开销就是纯亏：
 * 召回为空不注入、低于阈值不注入、过滤后为空不检索。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRecallBlock, handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';

const RULES = ['s|^/\\w+.*$||', 's|```[\\s\\S]*?```||g', 's|^(ok\\|yes\\|继续)$||i'];

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
      recallScoreThreshold: 0.5,
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
  assert.match(result.context, /^<comem-recall>/);
  assert.match(result.context, /- \[profile 0\.82\] comem:\/\/user\/alice\/memories\/profile\.md/);
  assert.match(result.context, /\n  后端工程师\n/);
  assert.match(result.context, /<\/comem-recall>$/);
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

test('低分命中不注入（§15.9 的三条前提之二）', () => {
  assert.equal(
    formatRecallBlock([{ uri: 'comem://x', score: 0.3, memoryType: null, contextType: null, abstract: null }], 0.5),
    undefined,
  );
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
