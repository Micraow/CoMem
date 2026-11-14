import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';
import { entitiesMemoryType } from '../../../src/domain/memory-types/entities.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { MemoryStructureIndex } from '../../../src/adapters/sqlite/memory-structure.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { runReindex } from '../../../src/commands/reindex.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { migrateMemoryLinks } from '../../../src/bootstrap/container/migrate-memory-links.js';
import { parseMemoryDocument } from '../../../src/services/memory/document.js';

const root = Uri.parse('comem://user/local');
const principals = ['user:local', 'user:*'];
const options = { scopes: [root.toString()], subject: 'user:local', principals };
let directory: string;
let container: Container;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comem-file-first-'));
  container = await createContainer({ configPath: join(directory, 'absent.yaml'), env: {
    COMEM_DATA_DIR: directory, COMEM_LOGGING_LEVEL: 'error', COMEM_SUMMARY_GENERATOR: 'rule', COMEM_RETRIEVAL_ENGINE: 'fts5',
  } });
  await container.services.acl.ensureRootPreset(root);
});

afterEach(async () => {
  await container.close();
  await rm(directory, { recursive: true, force: true });
});

async function laptop(name = 'laptop', aliases = ['ThinkBook']) {
  const write = await container.services.memory.upsertMemory(root, entitiesMemoryType,
    { name, aliases, kind: 'device', content: '用户的主力笔记本，当前使用 Arch Linux。' });
  const record = await container.services.memory.read(write.uri);
  expect(record?.entityId).toMatch(/^[0-9a-f-]{36}$/);
  return { uri: write.uri, id: record?.entityId ?? '' };
}

async function experience(id: string, topic = 'installation') {
  const uri = root.child('memories', 'experiences', `${topic}.md`);
  await container.services.memory.upsertMemory(root, experiencesMemoryType, { uri, structure: { entityRefs: [id] },
    update: () => ({ topic, content: '安装时需要先关闭固件的 RAID 模式。' }) });
  await container.services.memory.approve(uri);
  return uri;
}

it('稳定身份、别名、完整引用在更新、复核、引用清除与拒绝回退中保留', async () => {
  const { id, uri } = await laptop();
  const memory = container.services.memory;
  const event = await experience(id);
  await memory.upsertMemory(root, experiencesMemoryType, { uri: event, structure: { entityRefs: [] },
    update: () => ({ content: '安装时需要先关闭固件的 RAID 模式。' }) });
  expect((await memory.read(event))?.entityRefs).toEqual([]);
  await memory.reject(event, '错误的解绑');
  expect((await memory.read(event))?.entityRefs).toEqual([id]);
  await memory.upsertMemory(root, entitiesMemoryType, { name: 'laptop', content: '当前使用 Fedora Linux。' });
  expect((await memory.read(uri))?.entityId).toBe(id);
  expect((await memory.read(uri))?.fields.aliases).toEqual(['ThinkBook']);
  await memory.reject(uri, '错误系统');
  expect((await memory.read(uri))?.entityId).toBe(id);
  expect((await memory.read(uri))?.fields.content).toContain('Arch');
  await expect(memory.upsertMemory(root, entitiesMemoryType, { uri, structure: { entityId: '11111111-1111-4111-8111-111111111111' },
    update: () => ({ content: 'bad' }) })).rejects.toMatchObject({ details: { reason: 'entity_identity_conflict' } });
});

it('实体名称帮助找回没有名称的经验，当前实体和历史经验保留各自正文，预算和过滤生效', async () => {
  const { id, uri } = await laptop();
  const event = await experience(id);
  await container.services.indexObserver.drain();
  const hits = await container.services.search.find('ThinkBook 安装', options);
  expect(hits.map((hit) => hit.uri)).toContain(event.toString());
  expect(hits.map((hit) => hit.uri)).toContain(uri.toString());
  expect((await container.services.search.find('ThinkBook 安装', { ...options, limit: 1 })).length).toBe(1);
  const filtered = await container.services.search.find('ThinkBook 安装', { ...options, memoryTypes: ['rules'] });
  expect(filtered).toEqual([]);
  const context = await container.services.search.automaticContext('ThinkBook 安装', { ...options, maxTokens: 300, maxBytes: 1800 });
  expect(context.tokensUsed).toBeLessThanOrEqual(300);
  expect(Buffer.byteLength(context.rendered)).toBeLessThanOrEqual(1800);
});

it('改名保留编号和引用，之后抽取仍能更新目标；删除后旧身份不能通过新路径或引用重放', async () => {
  const { id, uri } = await laptop();
  const event = await experience(id);
  const renamed = uri.parent()?.child('workstation.md');
  if (renamed === undefined) throw new Error('missing parent');
  await container.services.filesystem.move(uri, renamed, principals);
  expect((await container.services.memory.read(renamed))?.entityId).toBe(id);
  expect((await container.services.memory.read(renamed))?.fields.name).toBe('workstation');
  expect((await container.services.memory.read(event))?.entityRefs).toEqual([id]);
  await container.services.memory.upsertMemory(root, entitiesMemoryType, { name: 'workstation', content: 'Fedora Linux' });
  await container.services.filesystem.remove(renamed, principals);
  const provenance = { sources: [root.child('sessions', 'old')], evidenceAt: '2000-01-01T00:00:00Z' };
  await expect(container.services.memory.upsertMemory(root, entitiesMemoryType, { uri, structure: { entityId: id }, provenance,
    update: () => ({ name: 'laptop', content: '旧电脑' }) })).rejects.toMatchObject({ details: { reason: 'forgotten_evidence' } });
  await expect(container.services.memory.upsertMemory(root, experiencesMemoryType, { uri: event, structure: { entityRefs: [id] }, provenance,
    update: () => ({ content: '旧经验' }) })).rejects.toMatchObject({ details: { reason: 'forgotten_evidence' } });
});

it('同名实体保持独立，重复编号停止展开，团队或无读权限的引用不会外泄', async () => {
  const first = await laptop();
  const event = await experience(first.id);
  await laptop('other-laptop');
  const structure = new MemoryStructureIndex(container.db);
  const readable = [first.uri.toString(), root.child('memories', 'entities', 'other-laptop.md').toString(), event.toString()];
  expect(structure.neighborhood('ThinkBook', readable, 10).entities).toEqual([]);
  expect(structure.neighborhood('laptop', [...readable, event.toString()], 10).memories).toContain(event.toString());
  const store = new ContentStore({ dataDir: directory, logger: container.logger });
  const duplicate = root.child('memories', 'entities', 'duplicate.md');
  await store.writeBytes(duplicate, await store.readBytes(first.uri));
  await container.services.indexObserver.onNodeWritten(duplicate, 'file');
  expect(structure.neighborhood('laptop', [...readable, duplicate.toString()], 10).entities).toEqual([]);
  const foreign = await container.services.search.find('ThinkBook 安装', { ...options, principals: ['user:bob', 'user:*'], subject: 'user:bob' });
  expect(foreign).toEqual([]);
});

it('个人和团队空间的同名实体各自保留，授权范围决定哪些经历可召回', async () => {
  const personal = await laptop('personal-laptop', ['ThinkBook']);
  const group = Uri.parse('comem://group/eng');
  await container.services.acl.ensureRootPreset(group, 'local');
  const identity = ['user:local', 'user:*', 'group:eng'];
  const shared = await container.services.memory.upsertMemory(group, entitiesMemoryType,
    { name: 'team-laptop', aliases: ['ThinkBook'], kind: 'device', content: '团队演示电脑运行 Ubuntu。' });
  const sharedRecord = await container.services.memory.read(shared.uri);
  if (sharedRecord?.entityId === undefined) throw new Error('shared entity id was not assigned');
  const event = group.child('memories', 'experiences', 'team-installation.md');
  await container.services.memory.upsertMemory(group, experiencesMemoryType, { uri: event, structure: { entityRefs: [sharedRecord.entityId] },
    update: () => ({ topic: 'team-installation', content: '团队电脑安装时使用 Ubuntu。' }) });
  await container.services.memory.approve(event);
  await container.services.indexObserver.drain();

  const options = { scopes: [root.toString(), group.toString()], subject: 'user:local', principals: identity };
  const readable = await container.services.index.glob({ pattern: '**', scopes: options.scopes, principals: identity, limit: 100 });
  expect(new MemoryStructureIndex(container.db).neighborhood('ThinkBook 安装', readable, 10).entities).toEqual([]);
  const ambiguous = await container.services.search.find('ThinkBook 安装', options);
  expect(ambiguous.map((hit) => hit.uri)).not.toContain(event.toString());
  const hits = await container.services.search.find('ThinkBook 安装', { ...options, scopes: [group.toString()] });
  expect(hits.map((hit) => hit.uri)).toContain(event.toString());
  expect(hits.map((hit) => hit.uri)).not.toContain(personal.uri.toString());
  const denied = await container.services.search.find('ThinkBook 安装', { ...options, principals: ['user:bob', 'user:*'] });
  expect(denied).toEqual([]);
});

it('结构索引仅凭文件离线恢复，旧关联先完整导出，孤立起点保留在导出与旧数据库', async () => {
  const { id, uri } = await laptop();
  const event = await experience(id);
  await container.services.memoryLink.addLinks(event, [{ toUri: uri, linkType: 'related', weight: 2, matchText: '固件', description: '安装原因' }]);
  container.db.prepare(`INSERT INTO memory_link VALUES(?,?,?,?,?,?,?,?)`).run('comem://user/local/memories/missing.md', uri.toString(), 'references', 3, 'x', 'orphan', '', '');
  container.db.exec('DELETE FROM memory_structure_migration');
  const store = new ContentStore({ dataDir: directory, logger: container.logger });
  await migrateMemoryLinks(container.db, directory, store, createPathLockManager({ dataDir: directory, logger: container.logger }), container.logger);
  const exports = await readdir(join(directory, '_meta', 'migration'));
  expect(JSON.parse(await readFile(join(directory, '_meta', 'migration', exports[0] ?? ''), 'utf8')).links).toHaveLength(2);
  expect(parseMemoryDocument(await readFile(toDiskPath(directory, event), 'utf8'))?.links?.[0]).toContain('安装原因');
  await container.services.indexObserver.drain();
  container.db.exec('DELETE FROM memory_alias; DELETE FROM memory_entity; DELETE FROM memory_entity_ref; DELETE FROM memory_link;');
  const result = await runReindex({ dataDir: directory, configPath: join(directory, 'absent.yaml'), only: 'index', env: { COMEM_LOGGING_LEVEL: 'error' }, argv: [] });
  expect(result.failed).toBe(0);
  expect(container.db.prepare('SELECT entity_id FROM memory_entity WHERE uri = ?').get(uri.toString())?.entity_id).toBe(id);
  expect(container.db.prepare('SELECT entity_id FROM memory_entity_ref WHERE uri = ?').get(event.toString())?.entity_id).toBe(id);
  expect(container.services.memoryLink.linksOf(event)).toMatchObject([{ linkType: 'related', weight: 2, description: '安装原因' }]);
});
