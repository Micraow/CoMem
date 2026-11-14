import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';

let directory: string | undefined;
let container: Container | undefined;
let app: FastifyInstance | undefined;
let model: FakeLlmHttp | undefined;

afterEach(async () => {
  await container?.services.indexObserver.drain();
  await app?.close();
  await container?.close();
  await model?.close();
  vi.restoreAllMocks();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

it('捕获→归档→抽取→合并→embedding→新会话召回→纠正→重置，并保留团队 ACL', async () => {
  directory = await mkdtemp(join(tmpdir(), 'comem-personal-flow-'));
  model = await startFakeLlmHttp((body) => {
    if (body.includes('经验归纳器')) return JSON.stringify({ experiences: [] });
    const corrected = body.includes('改成 Fedora');
    return JSON.stringify({ operations: [{ kind: 'upsert', pageId: 100, type: 'entities',
      identity: { name: 'personal-thinkbook' }, operations: [
        { kind: 'replace', field: 'kind', value: 'device' },
        { kind: 'replace', field: 'content', value: `用户的 ThinkBook 主力电脑使用 ${corrected ? 'Fedora' : 'Arch Linux'}。` },
      ] }] });
  });
  const nativeFetch = globalThis.fetch;
  const embeddingInputs: string[] = [];
  let slowQuery = false;
  let aborted = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('http://embedding.invalid/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    embeddingInputs.push(...body.input);
    if (slowQuery) await new Promise((_resolve, reject) => {
      const abort = () => { aborted = true; reject(init?.signal?.reason ?? new Error('aborted')); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
    return new Response(JSON.stringify({ object: 'list', model: 'synthetic', data: body.input.map((text, index) => ({
      object: 'embedding', index, embedding: /电脑|机器|Arch|Fedora|ThinkBook/.test(text) ? [1, 0] : [0, 1],
    })), usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  });
  const configPath = join(directory, 'config.yaml');
  await writeFile(configPath, [
    `dataDir: ${directory}`, 'logging:', '  level: error', 'summary:', '  generator: rule',
    'providers:', '  llm:', '    default:', `      baseUrl: ${model.baseUrl}`, '      model: fake', '      apiKey: synthetic',
    '  embedding:', '    type: openai-compatible', '    baseUrl: http://embedding.invalid/v1',
    '    model: synthetic', '    dimension: 2', '    apiKey: synthetic',
  ].join('\n'));
  container = await createContainer({ configPath, env: {} });
  const { services } = container;
  app = await createHttpServer({ config: container.config, logger: container.logger,
    observability: container.observability, routes: container.routes, mcp: container.mcp,
    resolveIdentity: container.resolveIdentity });
  const http = app;
  const runner = container.commitRunner;
  const root = Uri.parse('comem://user/local');
  const principals = ['user:local', 'user:*'];
  const personalUri = `${root.toString()}/memories/entities/personal-thinkbook.md`;
  const append = async (sessionId: string, id: string, text: string) => {
    const response = await http.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/messages`, payload: {
      messages: [{ id, role: 'user', createdAt: new Date().toISOString(), source: {
        host: 'dsh', machineId: 'synthetic-machine', cwd: '/repo',
      }, parts: [{ kind: 'text', text }] }],
    } });
    expect(response.statusCode).toBe(200);
  };
  const commit = async (sessionId: string) => {
    const response = await http.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/commit`, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    await runner.tick();
    await services.indexObserver.drain();
    expect(services.taskStore.countByStatus('failed')).toBe(0);
  };
  const recall = async (epoch = 'one') => {
    const response = await http.inject({ method: 'POST', url: '/api/v1/context', payload: {
      query: '那在我这台机器上呢', sessionId: 'new-session', contextEpoch: epoch,
    } });
    expect(response.statusCode).toBe(200);
    const result = response.json().result as { rendered: string; items: { uri: string }[]; deliveryToken: string | null };
    if (result.deliveryToken !== null) {
      const ack = await http.inject({ method: 'POST', url: '/api/v1/context/ack', payload: { deliveryToken: result.deliveryToken } });
      expect(ack.statusCode).toBe(200);
    }
    return result;
  };
  await services.session.ensure(root, 'old-session', principals);
  await append('old-session', 'old-one', '我的 ThinkBook 主力电脑使用 Arch Linux。');
  await commit('old-session');
  expect((await services.memory.read(Uri.parse(personalUri)))?.sources).toHaveLength(1);
  await services.session.ensure(root, 'new-session', principals);
  await append('new-session', 'new-one', '正在讨论 Linux 电脑上的安装方式。');
  await commit('new-session');
  embeddingInputs.length = 0;
  const first = await recall();
  expect(first.rendered).toContain('Arch Linux');
  expect(first.rendered).not.toContain('score=');
  expect(embeddingInputs.some((input) => input.includes('正在讨论 Linux 电脑上的安装方式') && input.includes('那在我这台机器上呢'))).toBe(true);
  expect((await recall()).rendered).toBe('');
  await append('old-session', 'old-two', '我的 ThinkBook 系统改成 Fedora 了。');
  await commit('old-session');
  const corrected = await recall();
  expect(corrected.rendered).toContain('Fedora');
  expect(corrected.rendered).not.toContain('Arch Linux');
  expect((await services.memory.read(Uri.parse(personalUri)))?.sources).toHaveLength(3);
  expect((await recall('after-compaction')).rendered).toContain('Fedora');
  slowQuery = true;
  const startedAt = Date.now();
  const slow = await http.inject({ method: 'POST', url: '/api/v1/context', payload: {
    query: 'ThinkBook', sessionId: 'slow-session', contextEpoch: 'slow', budgetMs: 300,
  } });
  expect(slow.statusCode, slow.body).toBe(200);
  expect(Date.now() - startedAt).toBeLessThan(2000);
  expect(slow.json().result.degradation).not.toBeNull();
  expect(slow.json().result.rendered).toContain('Fedora');
  expect(aborted).toBe(true);
  slowQuery = false;
  const retry = await http.inject({ method: 'POST', url: '/api/v1/context', payload: {
    query: 'ThinkBook', sessionId: 'slow-session', contextEpoch: 'slow',
  } });
  expect(retry.json().result.rendered).toContain('Fedora');
  expect((await services.index.glob({ pattern: '**', scopes: [root.toString()], principals: ['user:bob', 'user:*'], limit: 50 }))).toEqual([]);
  await services.acl.ensureRootPreset(Uri.parse('comem://group/eng'), 'local');
  await services.acl.ensureRootPreset(Uri.parse('comem://user/bob'));
  const sharedUri = Uri.parse('comem://group/eng/memories/entities/team-workstation.md');
  await services.filesystem.write(sharedUri, '团队电脑使用 Ubuntu。', principals);
  await services.indexObserver.drain();
  const teamIdentity = { subject: 'user:bob', principals: ['user:bob', 'user:*', 'group:eng'] };
  const shared = await services.search.automaticContext('电脑系统', { ...teamIdentity,
    scopes: await services.search.defaultScopes(teamIdentity.subject, teamIdentity.principals), maxBytes: 9000 });
  expect(shared.rendered).toContain('团队电脑使用 Ubuntu');
  expect(shared.rendered).not.toContain('Fedora');
  await services.acl.setAcl(Uri.parse('comem://group/eng/memories/entities'), { mode: 'inherit', entries: [{ principal: 'user:bob', level: 1, effect: 'deny' }] }, 'user:local', principals);
  const denied = await services.search.automaticContext('电脑系统', { ...teamIdentity,
    scopes: await services.search.defaultScopes(teamIdentity.subject, teamIdentity.principals), maxBytes: 9000 });
  expect(denied.rendered).not.toContain('Ubuntu');
});
