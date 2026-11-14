import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { contextDelivery } from '../lib/context-delivery.mjs';
import { createRunHook } from '../lib/hook-runner.mjs';
import { handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';

test('上下文仅在写给宿主后保存回执，下轮携带；输出失败时可以再次获取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-delivery-'));
  try {
    const config = { ...DEFAULT_CONFIG, tmpDir: directory };
    const event = { event: 'user_prompt_submit', sessionId: 'session', contextEpoch: 'one', cwd: '/repo', prompt: '电脑' };
    const calls = [];
    const http = { remainingMs: () => 1000, post: async (path, body) => {
      calls.push({ path, body }); return { rendered: 'Fedora Linux', deliveryToken: 'signed-receipt' };
    } };
    const handler = async () => handleUserPromptSubmit(event, { config, http });
    const first = await handler();
    assert.equal((await contextDelivery(config, 'session', 'one')).previousDeliveryToken, undefined);
    const run = createRunHook({ hostLabel: 'fixture', normalizeEvent: (input) => input,
      formatOutput: (_event, result) => ({ context: result.context }) });
    await run(async () => first, { read: async () => event, write: async () => { throw new Error('broken stdout'); } });
    assert.equal((await contextDelivery(config, 'session', 'one')).previousDeliveryToken, undefined);
    const lines = [];
    await run(handler, { read: async () => event, write: async (line) => { lines.push(line); } });
    assert.match(lines[0], /Fedora/);
    assert.equal((await contextDelivery(config, 'session', 'one')).previousDeliveryToken, 'signed-receipt');
    await handler();
    const contextCalls = calls.filter((call) => call.path === '/api/v1/context');
    assert.equal(contextCalls.at(-1).body.previousDeliveryToken, 'signed-receipt');
    assert.equal(contextCalls.at(-1).body.budgetMs, 800);
    assert.equal((await contextDelivery(config, 'session', 'one')).previousDeliveryToken, undefined);
    assert.equal((await contextDelivery(config, 'session', 'two')).previousDeliveryToken, undefined);
    await (await contextDelivery(config, 'session', 'one')).delivered('receipt');
    assert.equal((await contextDelivery({ ...config, token: 'other-identity' }, 'session', 'one')).previousDeliveryToken, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('监控上报挂起不会阻止已召回内容交给宿主', async () => {
  const result = await handleUserPromptSubmit({ event: 'user_prompt_submit', sessionId: 'telemetry',
    contextEpoch: 'one', cwd: '/repo', prompt: '电脑' }, { config: DEFAULT_CONFIG,
    http: { post: async (path) => path === '/api/v1/context' ? { rendered: 'Fedora' } : new Promise(() => {}) } });
  assert.match(result.context, /Fedora/);
});
