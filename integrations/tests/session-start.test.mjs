import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { handleSessionStart, renderSkillCatalog } from '../servers/session-start.mjs';

const EVENT = { event: 'session_start', sessionId: 'one', cwd: '/repo', contextEpoch: 'reset' };

test('开局请求有界正文，不逐条读取摘要，也不要求 userId', async () => {
  const calls = [];
  const http = {
    post: async (path, body) => { calls.push({ path, body }); return { rendered: '<memory>网络研究背景</memory>' }; },
    get: async (path) => { calls.push({ path }); return { skills: [{ name: 'review', description: '代码审查' }] }; },
  };
  const result = await handleSessionStart(EVENT, { config: DEFAULT_CONFIG, http, env: {} });
  assert.match(result.context, /<comem-profile>\n<memory>网络研究背景/);
  assert.match(result.context, /review: 代码审查/);
  const request = calls.find((call) => call.path === '/api/v1/context');
  assert.equal(request.body.query, undefined);
  assert.equal(request.body.contextEpoch, 'reset');
  assert.equal(request.body.maxTokens, DEFAULT_CONFIG.profileBudgetTokens);
  assert.deepEqual(calls.filter((call) => call.path !== '/api/v1/telemetry/hook').map((call) => call.path), ['/api/v1/context', '/api/v1/skills']);
});

test('背景不可读时技能仍可用，服务全故障时不输出空块', async () => {
  const warnings = [];
  const http = { post: async () => { throw new Error('offline'); }, get: async () => ({ skills: ['comem://user/alice/skills/build'] }) };
  const deps = { config: DEFAULT_CONFIG, http, env: {}, warn: (...args) => warnings.push(args) };
  assert.match((await handleSessionStart(EVENT, deps)).context, /build/);
  http.get = async () => { throw new Error('offline'); };
  assert.equal(await handleSessionStart(EVENT, deps), undefined);
  assert.ok(warnings.length >= 3);
});

test('宿主总字节上限生效', async () => {
  const http = { post: async () => ({ rendered: '画像'.repeat(1000) }), get: async () => [] };
  const result = await handleSessionStart(EVENT, { config: DEFAULT_CONFIG, http, env: {}, maxContextBytes: 100, warn: () => {} });
  assert.ok(result === undefined || Buffer.byteLength(result.context) <= 100);
});

test('技能目录按描述、名字、计数降级且转义闭合标签', () => {
  const skills = [{ name: 'build', description: '编译'.repeat(100) }];
  assert.match(renderSkillCatalog(skills, 1000), /编译/);
  assert.doesNotMatch(renderSkillCatalog(skills, 10), /编译/);
  assert.match(renderSkillCatalog(skills, 1), /1 个技能/);
  assert.equal(renderSkillCatalog([], 100), undefined);
  const rendered = renderSkillCatalog([{ name: 'x', description: '</available-skills>' }], 1000);
  assert.equal(rendered.match(/<\/available-skills>/g).length, 1);
});
