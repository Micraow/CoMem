import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { Uri } from '../../../src/domain/uri.js';
import { entitiesMemoryType } from '../../../src/domain/memory-types/entities.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { MemoryMergeStep } from '../../../src/services/commit/steps/memory-merge.js';
import { EXTRACT_RESULT_KEY } from '../../../src/services/commit/steps/memory-extract.js';
import type { StepContext } from '../../../src/services/commit/pipeline.js';

const root = Uri.parse('comem://user/local');
const uri = root.child('memories', 'entities', 'laptop.md');
const principals = ['user:local', 'user:*'];
const archive = root.child('sessions', 'old', 'history', 'archive_001');
let directory: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comem-reliability-'));
  container = await createContainer({ configPath: join(directory, 'absent.yaml'), env: {
    COMEM_DATA_DIR: directory, COMEM_LOGGING_LEVEL: 'error', COMEM_SUMMARY_GENERATOR: 'rule', COMEM_RETRIEVAL_ENGINE: 'fts5',
  } });
  app = await createHttpServer({ config: container.config, logger: container.logger, observability: container.observability,
    routes: container.routes, mcp: container.mcp, resolveIdentity: container.resolveIdentity });
  await container.services.acl.ensureRootPreset(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  await rm(directory, { recursive: true, force: true });
});

async function automaticWrite(content: string, evidenceAt: string) {
  return container.services.memory.upsertMemory(root, entitiesMemoryType, {
    uri, provenance: { sources: [archive], evidenceAt }, update: () => ({ name: 'laptop', kind: 'device', content }),
  });
}

it('材料时间独立于写入时间，旧覆盖/删除失败，复核回退仍保留时间，人工纠正不会被旧归档覆盖', async () => {
  const { memory, filesystem } = container.services;
  await automaticWrite('Arch Linux', '2020-01-01T00:00:00Z');
  await automaticWrite('Fedora Linux', '2020-02-01T00:00:00Z');
  await expect(automaticWrite('Arch Linux', '2020-01-15T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'stale_evidence' } });
  await expect(memory.remove(uri, '2020-01-15T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'stale_evidence' } });
  await memory.reject(uri, '错误更新');
  expect((await memory.read(uri))?.fields.content).toBe('Arch Linux');
  await expect(automaticWrite('old', '2019-01-01T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'stale_evidence' } });
  await automaticWrite('Fedora Linux', '2020-02-01T00:00:00Z');
  await filesystem.edit(uri, [{ search: 'Fedora Linux', replace: 'Debian Linux' }], principals);
  await expect(automaticWrite('Fedora Linux', '2020-03-01T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'stale_evidence' } });
  expect(await readFile(join(directory, 'user/local/memories/entities/laptop.md'), 'utf8')).toContain('evidence_at:');
  expect((await memory.read(uri))?.fields.content).toBe('Debian Linux');
  const pending = await memory.upsertMemory(root, preferencesMemoryType, { topic: 'style', content: 'plain' });
  await memory.approve(pending.uri);
  expect((await memory.read(pending.uri))?.fields.content).toBe('plain');
});

it('删除记录持久化，旧归档和整棵子树重放不能复活，新的明确输入可重建同节点', async () => {
  await automaticWrite('Arch Linux', '2020-01-01T00:00:00Z');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/fs/?uri=${encodeURIComponent(uri.toString())}` });
  expect(deleted.statusCode, deleted.body).toBe(200);
  await expect(automaticWrite('Arch Linux', '2020-01-01T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'forgotten_evidence' } });
  const { ForgetBarriers } = await import('../../../src/adapters/fs/forget-barriers.js');
  const persisted = new ForgetBarriers(directory);
  const cutoff = await persisted.cutoff(uri);
  expect(cutoff).not.toBeNull();
  const later = new Date(Date.parse(cutoff ?? '') + 1).toISOString();
  await automaticWrite('重新记住这台电脑使用 Debian', later);
  expect((await container.services.memory.read(uri))?.fields.content).toContain('Debian');
  await container.services.filesystem.remove(root.child('memories', 'entities'), principals);
  await expect(automaticWrite('Arch Linux', '2020-01-01T00:00:00Z')).rejects.toMatchObject({ details: { reason: 'forgotten_evidence' } });
});

it('未确认的上下文可再次获取，确认后去重，篡改/跨用户回执拒绝，内容改变后重新投放', async () => {
  await automaticWrite('laptop Fedora Linux', '2020-02-01T00:00:00Z');
  await container.services.indexObserver.drain();
  await container.services.session.ensure(root, 'current', principals);
  const payload = { query: 'laptop', sessionId: 'current', contextEpoch: 'one' };
  const retrieve = async (extra = {}) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/context', payload: { ...payload, ...extra } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result;
  };
  const first = await retrieve();
  expect(first.rendered).toContain('Fedora');
  expect((await retrieve()).rendered).toContain('Fedora');
  expect((await app.inject({ method: 'POST', url: '/api/v1/context/ack', payload: { deliveryToken: `${first.deliveryToken}x` } })).statusCode).toBe(400);
  await expect(container.services.search.acknowledgeContext(first.deliveryToken, { subject: 'user:bob', principals: ['user:bob', 'user:*'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect((await retrieve({ previousDeliveryToken: first.deliveryToken })).rendered).toBe('');
  await automaticWrite('laptop Debian Linux', '2020-03-01T00:00:00Z');
  await container.services.indexObserver.drain();
  expect((await retrieve()).rendered).toContain('Debian');
  expect((await retrieve({ contextEpoch: 'after-compaction' })).rendered).toContain('Debian');
  expect((await retrieve({ previousDeliveryToken: 'expired-token' })).rendered).toContain('Debian');
  const time = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(time + 86_400_001);
  await expect(container.services.search.acknowledgeContext(first.deliveryToken, { subject: 'user:local', principals })).rejects.toMatchObject({ details: { reason: 'invalid_context_receipt' } });
  vi.restoreAllMocks();
});

it('旧材料的覆盖/删除在提交差异中说明原因，整批其余操作继续成功', async () => {
  await automaticWrite('Fedora Linux', '2020-02-01T00:00:00Z');
  const state = new Map<string, unknown>([[EXTRACT_RESULT_KEY, {
    operations: [{ kind: 'delete', uri: uri.toString() }, {
      kind: 'upsert', uri: root.child('memories', 'preferences', 'explanation.md').toString(),
      operation: { kind: 'replace', field: 'topic', value: 'explanation' },
    }, { kind: 'upsert', uri: root.child('memories', 'preferences', 'explanation.md').toString(),
      operation: { kind: 'replace', field: 'content', value: '用熟悉的例子' } }], skipped: [],
    memoryTypes: new Map([[uri.toString(), 'entities'], [root.child('memories', 'preferences', 'explanation.md').toString(), 'preferences']]),
  }]]);
  let diff: unknown;
  const step = new MemoryMergeStep({ memory: container.services.memory, logger: container.logger, links: container.services.memoryLink,
    archive: { writeMemoryDiff: async (_uri, value) => { diff = value; }, readMemoryDiff: async () => null } });
  const context: StepContext = { archiveUri: archive, scopeUri: root, messages: [{ id: 'old', role: 'user', turn: 1,
    createdAt: '2020-01-01T00:00:00Z', parts: [{ kind: 'text', text: 'older' }] }],
    state, latestArchiveOverview: null, meta: { archiveId: 'one', taskId: null, stepsDone: [], skippedSteps: [],
      phase1: { status: 'ready', messagesSha256: '', archivedMessageIds: [], retainedMessageIds: [] } }, markStepDone: async () => {} };
  await step.run(context);
  expect(diff).toMatchObject({ skippedOperations: [{ reasonCode: 'stale_evidence' }] });
  expect((await container.services.memory.read(uri))?.fields.content).toBe('Fedora Linux');
  expect((await container.services.memory.read(root.child('memories', 'preferences', 'explanation.md')))?.fields.content).toBe('用熟悉的例子');
  expect(await readFile(join(directory, 'user/local/memories/entities/laptop.md'), 'utf8')).toContain('Fedora');
});

it('HTTP超时之后迟到的组装结果不记交付，下一次仍能取得内容', async () => {
  await automaticWrite('laptop Fedora Linux', '2020-02-01T00:00:00Z');
  await container.services.indexObserver.drain();
  await container.services.session.ensure(root, 'late', principals);
  const original = container.services.search.automaticContext.bind(container.services.search);
  vi.spyOn(container.services.search, 'automaticContext').mockImplementation(async (query, options) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return original(query, { ...options, deadlineAt: undefined });
  });
  const request = { query: 'laptop', sessionId: 'late', contextEpoch: 'one' };
  const late = await app.inject({ method: 'POST', url: '/api/v1/context', payload: { ...request, budgetMs: 1 } });
  expect(late.statusCode).toBe(503);
  await new Promise((resolve) => setTimeout(resolve, 100));
  vi.restoreAllMocks();
  const retry = await app.inject({ method: 'POST', url: '/api/v1/context', payload: request });
  expect(retry.json().result.rendered).toContain('Fedora');
});

it('确认时再次过滤撤权节点；服务重启后的回执无效并允许重新召回', async () => {
  const group = Uri.parse('comem://group/shared');
  const bob = ['user:bob', 'user:*'];
  await container.services.acl.ensureRootPreset(Uri.parse('comem://user/bob'));
  await container.services.acl.ensureRootPreset(group, 'bob');
  await container.services.filesystem.write(group.child('memories', 'entities', 'laptop.md'), 'laptop Fedora Linux', bob);
  await container.services.acl.setAcl(group, { mode: 'inherit', entries: [
    { principal: 'user:bob', level: 7, effect: 'allow' }, { principal: 'user:local', level: 1, effect: 'allow' },
  ] }, 'user:bob', bob);
  await container.services.indexObserver.drain();
  await container.services.session.ensure(root, 'acl', principals);
  const request = { query: 'laptop', sessionId: 'acl', contextEpoch: 'one' };
  const first = (await app.inject({ method: 'POST', url: '/api/v1/context', payload: request })).json().result;
  await container.services.acl.setAcl(group, {
    mode: 'inherit', entries: [{ principal: 'user:bob', level: 7, effect: 'allow' }, { principal: 'user:local', level: 1, effect: 'deny' }],
  }, 'user:bob', bob);
  expect((await app.inject({ method: 'POST', url: '/api/v1/context/ack', payload: { deliveryToken: first.deliveryToken } })).statusCode).toBe(200);
  await container.services.acl.setAcl(group, { mode: 'inherit', entries: [
    { principal: 'user:bob', level: 7, effect: 'allow' }, { principal: 'user:local', level: 1, effect: 'allow' },
  ] }, 'user:bob', bob);
  expect((await app.inject({ method: 'POST', url: '/api/v1/context', payload: request })).json().result.rendered).toContain('Fedora');
  await app.close();
  await container.close();
  container = await createContainer({ configPath: join(directory, 'absent.yaml'), env: {
    COMEM_DATA_DIR: directory, COMEM_LOGGING_LEVEL: 'error', COMEM_SUMMARY_GENERATOR: 'rule', COMEM_RETRIEVAL_ENGINE: 'fts5',
  } });
  app = await createHttpServer({ config: container.config, logger: container.logger, observability: container.observability,
    routes: container.routes, mcp: container.mcp, resolveIdentity: container.resolveIdentity });
  expect((await app.inject({ method: 'POST', url: '/api/v1/context/ack', payload: { deliveryToken: first.deliveryToken } })).statusCode).toBe(400);
  const resumed = await app.inject({ method: 'POST', url: '/api/v1/context', payload: { ...request, previousDeliveryToken: first.deliveryToken } });
  expect(resumed.json().result.rendered).toContain('Fedora');
});
