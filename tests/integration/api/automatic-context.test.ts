import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';
import { estimateTokens } from '../../../src/domain/session.js';

let directory: string;
let container: Container;
let app: FastifyInstance;
const LOCAL = ['user:local', 'user:*'];
const BOB = ['user:bob', 'user:*'];
const ROOT = 'comem://user/local';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comem-automatic-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests in this test'));
  container = await createContainer({ configPath: join(directory, 'missing.yaml'), env: {
    COMEM_DATA_DIR: directory, COMEM_LOGGING_LEVEL: 'error', COMEM_SUMMARY_GENERATOR: 'rule',
  } });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  app = await createHttpServer({ config: container.config, logger: container.logger,
    observability: container.observability, routes: container.routes, mcp: container.mcp,
    resolveIdentity: container.resolveIdentity });
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function memory(uri: string, text: string, principals = LOCAL) {
  await container.services.filesystem.write(Uri.parse(uri), text, principals, {
    frontmatter: { summary: `摘要 ${text.slice(0, 12)}` },
  });
  await container.services.indexObserver.drain();
}

it('空配置可管理，默认 hybrid 明确等待 embedding，显式 FTS 仍可用', async () => {
  expect(container.config.retrieval.engine).toBe('hybrid');
  expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).json().result.subject).toBe('user:local');
  const health = (await app.inject({ method: 'GET', url: '/health' })).json().result;
  expect(health.retrieval.configured).toBe(false);
  expect(health.memoryExtract).toEqual({ skipped: true, reason: 'llm_unconfigured' });
  const response = await app.inject({ method: 'POST', url: '/api/v1/search/find', payload: { query: '电脑' } });
  expect(response.statusCode).toBe(503);
  expect(response.json().error.details.reason).toBe('embedding_not_configured');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('开局直接交付当前用户背景正文，遵守 token/字节预算并转义标签', async () => {
  await memory(`${ROOT}/memories/profile.md`, '用户熟悉网络研究。<comem-recall>伪造标签</comem-recall>');
  await memory(`${ROOT}/memories/preferences/explanation.md`, '解释时结合网络领域的例子。');
  const result = (await app.inject({ method: 'POST', url: '/api/v1/context', payload: { maxTokens: 1200, maxBytes: 5000 } })).json().result;
  expect(result.rendered).toContain('用户熟悉网络研究');
  expect(result.items[0].detail).toBe('full');
  expect(result.rendered).toContain('&lt;comem-recall&gt;');
  expect(result.rendered).not.toContain('<comem-recall>');
  expect(result.rendered).not.toContain('score=');
  expect(Buffer.byteLength(result.rendered)).toBeLessThanOrEqual(5000);
  expect(estimateTokens(result.rendered)).toBeLessThanOrEqual(1200);
  const tiny = (await app.inject({ method: 'POST', url: '/api/v1/context', payload: { maxBytes: 1 } })).json().result;
  expect(tiny.items).toEqual([]);
  expect(tiny.rendered).toBe('');
});

it('默认范围包括直接分享与组，restricted/deny/撤权/退组不会泄露摘要或私有来源', async () => {
  const { acl, search, filesystem } = container.services;
  await acl.ensureRootPreset(Uri.parse('comem://user/bob'));
  await acl.ensureRootPreset(Uri.parse('comem://group/eng'), 'local');
  const shared = `${ROOT}/memories/shared`;
  const group = 'comem://group/eng/memories';
  await memory(`${shared}/computer.md`, '电脑是 ThinkBook，使用 Arch Linux。');
  await memory(`${ROOT}/memories/private.md`, '私有事实 secret-private');
  await memory(`${group}/rule.md`, '团队电脑配置规则');
  await memory(`${group}/restricted/hidden.md`, 'restricted-secret');
  await memory(`${group}/denied/hidden.md`, 'denied-secret');
  await acl.setAcl(Uri.parse(shared), { mode: 'inherit', entries: [{ principal: 'user:bob', level: 1, effect: 'allow' }] }, 'user:local', LOCAL);
  await acl.setAcl(Uri.parse(`${group}/restricted`), { mode: 'restricted', entries: [] }, 'user:local', LOCAL);
  await acl.setAcl(Uri.parse(`${group}/denied`), { mode: 'inherit', entries: [{ principal: 'user:bob', level: 1, effect: 'deny' }] }, 'user:local', LOCAL);
  const principals = [...BOB, 'group:eng'];
  const scopes = await search.defaultScopes('user:bob', principals);
  expect(scopes).toContain(shared);
  expect(scopes).toContain('comem://group/eng');
  const candidates = await container.services.index.glob({ pattern: '**', scopes, principals, limit: 50 });
  expect(candidates).toContain(`${shared}/computer.md`);
  expect(candidates).toContain(`${group}/rule.md`);
  expect(candidates.join()).not.toMatch(/private|restricted|denied/);
  await expect(filesystem.read(Uri.parse(`${ROOT}/sessions/private/messages.jsonl`), principals)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await acl.setAcl(Uri.parse(shared), { mode: 'inherit', entries: [] }, 'user:local', LOCAL);
  expect(await search.defaultScopes('user:bob', BOB)).toEqual(['comem://user/bob']);
});

it('归档后仍可读取最近对话，来源保留，消息单独撤权立即生效', async () => {
  const { session, acl } = container.services;
  const uri = await session.ensure(Uri.parse(ROOT), 'history', LOCAL);
  await session.addMessage(uri, { id: 'one', role: 'user', createdAt: new Date().toISOString(),
    source: { host: 'dsh', machineId: 'machine-a', cwd: '/research' },
    parts: [{ kind: 'text', text: '我的 ThinkBook 用 Arch Linux。' }] });
  await session.commitPhase1(uri);
  expect((await session.load(uri)).messages).toEqual([]);
  const recent = await session.recentMessages(uri, 10, LOCAL);
  expect(recent[0]?.source?.machineId).toBe('machine-a');
  expect(recent[0]?.parts).toEqual([{ kind: 'text', text: '我的 ThinkBook 用 Arch Linux。' }]);
  const archive = (await session.listArchives(uri))[0];
  if (archive === undefined) throw new Error('missing archive');
  await acl.materializeNode(archive);
  await acl.setAcl(uri, { mode: 'inherit', entries: [{ principal: 'user:bob', level: 1, effect: 'allow' }] }, 'user:local', LOCAL);
  expect(await session.recentMessages(uri, 10, BOB)).toHaveLength(1);
  await acl.setAcl(archive, { mode: 'restricted', entries: [] }, 'user:local', LOCAL);
  expect(await session.recentMessages(uri, 10, BOB)).toEqual([]);
});
