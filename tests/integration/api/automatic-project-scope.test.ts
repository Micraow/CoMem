import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const ALICE = 'comem://user/alice';
const GROUP = 'comem://group/eng';
const LOCAL = ['user:local', 'user:*', 'group:eng'];
const ALICE_PRINCIPALS = ['user:alice', 'user:*'];
const BOB = ['user:bob', 'user:*'];

let directory: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comem-automatic-project-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests in this test'));
  container = await createContainer({
    configPath: join(directory, 'missing.yaml'),
    env: {
      COMEM_DATA_DIR: directory,
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_RETRIEVAL_ENGINE: 'fts5',
      COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS: '12000',
      COMEM_SUMMARY_GENERATOR: 'rule',
    },
  });
  container.services.identity.createUser({ id: 'alice', displayName: 'Alice' });
  container.services.identity.createGroup({
    id: 'eng',
    displayName: 'Engineering',
    ownerUserId: 'alice',
  });
  container.services.identity.addMember('eng', 'local');
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  await container.services.acl.ensureRootPreset(Uri.parse(ALICE), 'alice');
  await container.services.acl.ensureRootPreset(Uri.parse(GROUP), 'alice');
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function write(uri: string, text: string, principals = LOCAL): Promise<Uri> {
  const target = Uri.parse(uri);
  await container.services.filesystem.write(target, text, principals, {
    frontmatter: { summary: '概要' },
  });
  await container.services.indexObserver.drain();
  return target;
}

async function context(payload: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/context',
    payload: {
      query: 'recallmarker',
      maxTokens: 12000,
      maxBytes: 60000,
      limit: 30,
      ...payload,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as { readonly rendered: string };
}

describe('POST /context 项目范围', () => {
  it('显式组根授权无需成员关系即可进入自动召回与手动范围，未授权组仍被 ACL 挡住', async () => {
    const { acl, search, identity } = container.services;
    identity.createUser({ id: 'bob', displayName: 'Bob' });
    await identity.ensureUserNamespace('bob');
    identity.createGroup({ id: 'shared', displayName: '共享团队', ownerUserId: 'local' });
    identity.createGroup({ id: 'private', displayName: '私有团队', ownerUserId: 'local' });
    const sharedRoot = Uri.parse('comem://group/shared');
    const privateRoot = Uri.parse('comem://group/private');
    await acl.ensureRootPreset(sharedRoot, 'local');
    await acl.ensureRootPreset(privateRoot, 'local');
    await acl.setAcl(sharedRoot, {
      mode: 'inherit',
      entries: [
        { principal: 'group:shared', level: 3, effect: 'allow' },
        { principal: 'user:local', level: 7, effect: 'allow' },
        { principal: 'user:bob', level: 1, effect: 'allow' },
      ],
    }, 'user:local', LOCAL);

    await write(`${sharedRoot.toString()}/memories/granted.md`, 'grantmarker 显式组授权');
    await write(`${privateRoot.toString()}/memories/secret.md`, 'privatemarker 未授权内容');

    const automaticScopes = await search.defaultScopes('user:bob', BOB);
    expect(automaticScopes).toContain(sharedRoot.toString());
    expect(automaticScopes).not.toContain(privateRoot.toString());

    const automatic = await search.automaticContext('grantmarker', {
      subject: 'user:bob',
      principals: BOB,
      scopes: [],
      maxBytes: 5000,
      maxTokens: 1200,
      limit: 20,
    });
    expect(automatic.rendered).toContain('显式组授权');
    expect(automatic.rendered).not.toContain('未授权内容');

    const manualShared = await search.find('grantmarker', {
      subject: 'user:bob',
      principals: BOB,
      scopes: [sharedRoot.toString()],
      limit: 20,
    });
    expect(manualShared.map((hit) => hit.uri)).toContain(
      `${sharedRoot.toString()}/memories/granted.md`,
    );

    const manualPrivate = await search.find('privatemarker', {
      subject: 'user:bob',
      principals: BOB,
      scopes: [privateRoot.toString()],
      limit: 20,
    });
    expect(manualPrivate).toEqual([]);
  });

  it('只召回个人直属内容、当前项目和可读团队同项目范围', async () => {
    await write(`${ROOT}/memories/preferences/global.md`, 'recallmarker personal-preference-always');
    await write(`${ROOT}/resources/personal.md`, 'recallmarker personal-resource');
    await write(`${ROOT}/projects/A/memories/current.md`, 'recallmarker personal-project-a');
    await write(`${ROOT}/projects/A/resources/spec.md`, 'recallmarker personal-project-a-resource');
    await write(`${ROOT}/projects/B/memories/sibling.md`, 'recallmarker personal-project-b');

    await write(`${GROUP}/memories/team.md`, 'recallmarker team-direct');
    await write(`${GROUP}/projects/A/memories/current.md`, 'recallmarker team-project-a');
    await write(`${GROUP}/projects/B/memories/sibling.md`, 'recallmarker team-project-b');
    await write(`${GROUP}/memories/denied/secret.md`, 'recallmarker group-denied-secret');
    await container.services.acl.setAcl(
      Uri.parse(`${GROUP}/memories/denied`),
      {
        mode: 'inherit',
        entries: [{ principal: 'user:local', level: 1, effect: 'deny' }],
      },
      'user:alice',
      ALICE_PRINCIPALS,
    );

    await write(`${ALICE}/projects/A/resources/shared.md`, 'recallmarker shared-project-a', ALICE_PRINCIPALS);
    await write(`${ALICE}/projects/B/memories/private.md`, 'recallmarker shared-project-b-private', ALICE_PRINCIPALS);
    await container.services.acl.setAcl(
      Uri.parse(`${ALICE}/projects/A`),
      {
        mode: 'inherit',
        entries: [{ principal: 'user:local', level: 1, effect: 'allow' }],
      },
      'user:alice',
      ALICE_PRINCIPALS,
    );
    await container.services.acl.setAcl(
      Uri.parse(`${ALICE}/projects/B`),
      {
        mode: 'inherit',
        entries: [{ principal: 'user:local', level: 1, effect: 'allow' }],
      },
      'user:alice',
      ALICE_PRINCIPALS,
    );
    await container.services.indexObserver.drain();

    const scopes = [
      `${ROOT}/memories`,
      `${ROOT}/resources`,
      `${ROOT}/projects/A/memories`,
      `${ROOT}/projects/A/resources`,
      `${GROUP}/memories`,
      `${GROUP}/resources`,
      `${GROUP}/projects/A/memories`,
      `${GROUP}/projects/A/resources`,
      `${ALICE}/projects/A/resources`,
    ];
    const hits = await container.services.search.find('recallmarker', {
      scopes,
      subject: 'user:local',
      principals: LOCAL,
      limit: 30,
    });
    expect(hits.map((hit) => hit.uri)).toContain(`${ROOT}/projects/A/memories/current.md`);

    const result = await context({ projectId: 'A' });
    expect(result.rendered).toContain('personal-preference-always');
    expect(result.rendered).toContain('personal-resource');
    expect(result.rendered).toContain('personal-project-a');
    expect(result.rendered).toContain('personal-project-a-resource');
    expect(result.rendered).toContain('team-direct');
    expect(result.rendered).toContain('team-project-a');
    expect(result.rendered).toContain('shared-project-a');
    expect(result.rendered).not.toContain('personal-project-b');
    expect(result.rendered).not.toContain('team-project-b');
    expect(result.rendered).not.toContain('group-denied-secret');
    expect(result.rendered).not.toContain('shared-project-b-private');
  });

  it('无项目时只查个人与团队直属 memories/resources，不扫描历史项目', async () => {
    await write(`${ROOT}/memories/preferences/global.md`, 'recallmarker personal-preference-always');
    await write(`${ROOT}/projects/A/memories/history.md`, 'recallmarker historical-project-a');
    await write(`${ROOT}/projects/B/memories/history.md`, 'recallmarker historical-project-b');
    await write(`${GROUP}/memories/team.md`, 'recallmarker team-direct');
    await write(`${GROUP}/projects/A/memories/history.md`, 'recallmarker team-historical-project');
    await container.services.indexObserver.drain();

    const result = await context({});
    expect(result.rendered).toContain('personal-preference-always');
    expect(result.rendered).toContain('team-direct');
    expect(result.rendered).not.toContain('historical-project');
  });

  it('显式项目 ID 必须是单个合法路径段', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/context',
      payload: { query: 'automatic', projectId: 'A/B' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ARGUMENT');
  });

  it('已绑定 session 自动采用原项目，显式切换返回冲突', async () => {
    await write(`${ROOT}/projects/A/memories/current.md`, 'recallmarker bound-project-a');
    await write(`${ROOT}/projects/B/memories/sibling.md`, 'recallmarker bound-project-b');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { sessionId: 'bound', projectId: 'A' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().result.projectId).toBe('A');

    const inherited = await context({ sessionId: 'bound' });
    expect(inherited.rendered).toContain('bound-project-a');
    expect(inherited.rendered).not.toContain('bound-project-b');

    const switchProject = await app.inject({
      method: 'POST',
      url: '/api/v1/context',
      payload: { query: 'recallmarker', sessionId: 'bound', projectId: 'B' },
    });
    expect(switchProject.statusCode).toBe(409);
    expect(switchProject.json().error.code).toBe('CONFLICT');
  });
});
