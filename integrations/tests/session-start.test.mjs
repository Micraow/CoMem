import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { handleSessionStart } from '../servers/session-start.mjs';

const EVENT = { event: 'session_start', sessionId: 'one', cwd: '/repo', contextEpoch: 'reset' };

test('开局只请求有界正文，不逐条读取摘要，也不要求 userId', async () => {
  const calls = [];
  const http = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { rendered: '<memory>网络研究背景</memory>' };
    },
  };
  const result = await handleSessionStart(EVENT, {
    config: DEFAULT_CONFIG,
    http,
    env: {},
  });
  assert.match(result.context, /<comem-profile>\n<memory>网络研究背景/);
  const request = calls.find((call) => call.path === '/api/v1/context');
  assert.equal(request.body.query, undefined);
  assert.equal(request.body.contextEpoch, 'reset');
  assert.equal(request.body.maxTokens, DEFAULT_CONFIG.profileBudgetTokens);
  assert.deepEqual(
    calls.filter((call) => call.path !== '/api/v1/telemetry/hook').map((call) => call.path),
    ['/api/v1/context'],
  );
});

test('背景不可读时不输出空块', async () => {
  const warnings = [];
  const http = { post: async () => { throw new Error('offline'); } };
  const deps = { config: DEFAULT_CONFIG, http, env: {}, warn: (...args) => warnings.push(args) };
  assert.equal(await handleSessionStart(EVENT, deps), undefined);
  assert.ok(warnings.length >= 1);
});

test('宿主总字节上限生效', async () => {
  const http = { post: async () => ({ rendered: '画像'.repeat(1000) }) };
  const result = await handleSessionStart(EVENT, {
    config: DEFAULT_CONFIG,
    http,
    env: {},
    maxContextBytes: 100,
    warn: () => {},
  });
  assert.ok(result === undefined || Buffer.byteLength(result.context) <= 100);
});
