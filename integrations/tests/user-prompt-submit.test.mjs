import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { contextEpoch } from '../lib/context-epoch.mjs';
import { handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';

const EVENT = { event: 'user_prompt_submit', sessionId: 'one', prompt: '我的电脑如何配置', cwd: '/repo', contextEpoch: 'epoch' };

function deps(result, extra = {}) {
  const calls = [];
  return {
    config: { ...DEFAULT_CONFIG, queryFilters: ['s|^ok$||'], tmpDir: '/tmp' }, env: {}, calls,
    http: { post: async (path, body) => { calls.push({ path, body }); return result; } },
    ...extra,
  };
}

test('直接交付服务端上下文，身份和范围由服务端决定', async () => {
  const settings = deps({ rendered: '<memory>Arch Linux</memory>', degradation: null });
  const result = await handleUserPromptSubmit(EVENT, settings);
  assert.equal(result.context, '<comem-recall>\n<memory>Arch Linux</memory>\n</comem-recall>');
  const call = settings.calls.find((entry) => entry.path === '/api/v1/context');
  assert.equal(call.body.query, EVENT.prompt);
  assert.equal(call.body.contextEpoch, 'epoch');
  assert.equal(call.body.sessionId, 'one');
  assert.equal(call.body.scopes, undefined);
  assert.equal(call.body.userId, undefined);
  assert.ok(call.body.maxBytes < 9500);
});

test('空结果、空查询、bypass 均不注入', async () => {
  const settings = deps({ rendered: '' });
  assert.equal(await handleUserPromptSubmit(EVENT, settings), undefined);
  settings.calls.length = 0;
  assert.equal(await handleUserPromptSubmit({ ...EVENT, prompt: 'ok' }, settings), undefined);
  assert.equal(settings.calls.length, 0);
  assert.equal(await handleUserPromptSubmit(EVENT, deps({}, { env: { COMEM_NO_RECALL: '1' } })), undefined);
});

test('供应商降级记录原因，故障不阻塞宿主', async () => {
  const warnings = [];
  const settings = deps({ rendered: '有用的 FTS 结果', degradation: 'embedding timeout' }, { warn: (...args) => warnings.push(args) });
  assert.ok(await handleUserPromptSubmit(EVENT, settings));
  assert.match(JSON.stringify(warnings), /embedding timeout/);
  settings.http.post = async () => { throw new Error('offline'); };
  assert.equal(await handleUserPromptSubmit(EVENT, settings), undefined);
  assert.match(JSON.stringify(warnings), /offline/);
});

test('上下文重置按服务地址与会话隔离，并原子更新 epoch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-epoch-'));
  try {
    const config = { ...DEFAULT_CONFIG, tmpDir: directory };
    assert.equal(await contextEpoch(config, 'one'), 'default');
    const first = await contextEpoch(config, 'one', true);
    assert.equal(await contextEpoch(config, 'one'), first);
    assert.equal(await contextEpoch(config, 'two'), 'default');
    assert.notEqual(await contextEpoch(config, 'one', true), first);
    assert.equal(await contextEpoch({ ...config, baseUrl: 'http://other' }, 'one'), 'default');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
