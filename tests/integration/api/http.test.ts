import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownloadUrl } from '../../../src/api/mcp/tools/download.js';
import { createHttpServer, PROMETHEUS_CONTENT_TYPE } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-http-'));
  container = await createContainer({
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
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
  await rm(dataDir, { recursive: true, force: true });
});

function inject(options: InjectOptions) {
  return app.inject(options);
}

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('error');
  return body['error'] as Record<string, unknown>;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function encode(uri: string): string {
  return encodeURIComponent(uri);
}

describe('封套与请求 ID', () => {
  it('成功响应是 {status:"ok", result}', async () => {
    const response = await inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(json(response)['status']).toBe('ok');
  });

  it('回显入站 x-request-id', async () => {
    const response = await inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-abc' },
    });
    expect(response.headers['x-request-id']).toBe('req-abc');
  });

  it('没有 x-request-id 时生成一个，并写进错误 details', async () => {
    const response = await inject({ method: 'GET', url: '/api/v1/fs/ls?uri=invalid' });
    const requestId = response.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    expect(requestId).not.toBe('');
    const error = errorOf(response);
    expect((error['details'] as Record<string, unknown>)['requestId']).toBe(requestId);
  });

  it('未知路由返回 NOT_FOUND 封套，不是纯文本', async () => {
    const response = await inject({ method: 'GET', url: '/no-such-route' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(errorOf(response)['code']).toBe('NOT_FOUND');
  });
});

describe('运维端点不需要认证', () => {
  it('/health 与 /metrics 在任意身份下都 200', async () => {
    for (const url of ['/health', '/metrics', '/api/v1/health', '/api/v1/metrics']) {
      const response = await inject({
        method: 'GET',
        url,
        headers: { 'x-comem-subject': 'user:someone-else' },
      });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('/metrics 的 Content-Type 与文本格式', async () => {
    const response = await inject({ method: 'GET', url: '/metrics' });
    expect(response.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(response.body).toContain('# HELP comem_http_request_duration_seconds');
    expect(response.body).toMatch(/comem_http_request_duration_seconds_count \d+/);
    // 每个非空行要么是注释，要么是「指标名 数值」。
    for (const line of response.body.trimEnd().split('\n')) {
      expect(line.startsWith('#') || /^\S+ \S+$/.test(line), line).toBe(true);
    }
  });

  it('/health 的字段与 §17.9 一致（规则摘要时 status 是 degraded）', async () => {
    // 测试容器配的是 `summary.generator: rule`（不碰模型）：摘要走降级路径，
    // 按 §17.9 的判定必须是 `degraded`——静默降级等于骗人。
    const result = resultOf(await inject({ method: 'GET', url: '/health' }));
    expect(result['status']).toBe('degraded');
    expect(result['index']).toEqual({ nodes: 0 });
    expect(result['queue']).toEqual({ pending: 0, processing: 0 });
    expect((result['summary'] as Record<string, unknown>)['degraded']).toBe(true);
    expect(result['version']).toBe('0.1.0');
  });
});

describe('权限与参数', () => {
  it('无权限时 403 PERMISSION_DENIED', async () => {
    const response = await inject({
      method: 'GET',
      url: `/api/v1/fs/ls?uri=${encode('comem://user/local')}`,
      headers: { 'x-comem-subject': SUBJECT },
    });
    // 根预置写的是 user:local，但 Access 需要先有物化行；这里用别人的根验证拒绝。
    const other = await inject({
      method: 'GET',
      url: `/api/v1/fs/ls?uri=${encode('comem://user/other')}`,
    });
    expect(response.statusCode).toBe(200);
    expect(other.statusCode).toBe(403);
    expect(errorOf(other)['code']).toBe('PERMISSION_DENIED');
  });

  it('身份与绑定身份不一致时 401', async () => {
    const response = await inject({
      method: 'GET',
      url: `/api/v1/fs/ls?uri=${encode(ROOT)}`,
      headers: { 'x-comem-subject': 'user:alice' },
    });
    expect(response.statusCode).toBe(401);
    expect(errorOf(response)['code']).toBe('UNAUTHENTICATED');
  });

  it('非法 URI 返回 400 INVALID_URI', async () => {
    for (const url of [
      '/api/v1/fs/ls?uri=not-a-uri',
      '/api/v1/fs/stat?uri=comem%3A%2F%2Fuser%2F..',
      '/api/v1/content/read?uri=',
    ]) {
      const response = await inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
      expect(errorOf(response)['code']).toBe('INVALID_URI');
    }
  });
});

describe('文件系统与内容', () => {
  it('mkdir → write → ls → tree → stat → read → edit → mv → cp → delete', async () => {
    const directory = `${ROOT}/memories`;
    const file = `${directory}/code-style.md`;

    expect(
      (await inject({ method: 'POST', url: '/api/v1/fs/mkdir', payload: { uri: directory } }))
        .statusCode,
    ).toBe(200);

    const written = await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: file, content: '用户偏好 TypeScript 严格模式。', mode: 'replace' },
    });
    expect(written.statusCode).toBe(200);
    expect(resultOf(written)['created']).toBe(true);

    const listed = resultOf(
      await inject({ method: 'GET', url: `/api/v1/fs/ls?uri=${encode(directory)}` }),
    );
    expect((listed['entries'] as Record<string, unknown>[]).map((entry) => entry['name'])).toEqual([
      'code-style.md',
    ]);

    const tree = resultOf(
      await inject({ method: 'GET', url: `/api/v1/fs/tree?uri=${encode(directory)}&depth=1` }),
    );
    expect((tree['entries'] as unknown[]).length).toBe(1);

    const stat = resultOf(
      await inject({ method: 'GET', url: `/api/v1/fs/stat?uri=${encode(file)}` }),
    );
    expect((stat['stat'] as Record<string, unknown>)['kind']).toBe('file');

    const read = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/read?uri=${encode(file)}` }),
    );
    expect(read['text']).toBe('用户偏好 TypeScript 严格模式。');

    const edited = await inject({
      method: 'POST',
      url: '/api/v1/content/edit',
      payload: {
        uri: file,
        blocks: [{ search: 'TypeScript', replace: 'JavaScript' }],
      },
    });
    expect(resultOf(edited)['applied']).toBe(1);

    const moved = `${directory}/renamed.md`;
    expect(
      (await inject({ method: 'POST', url: '/api/v1/fs/mv', payload: { from: file, to: moved } }))
        .statusCode,
    ).toBe(200);
    expect(await container.services.index.stat(file)).toBeNull();

    const copied = `${directory}/copy.md`;
    expect(
      (await inject({ method: 'POST', url: '/api/v1/fs/cp', payload: { from: moved, to: copied } }))
        .statusCode,
    ).toBe(200);
    expect((await container.services.filesystem.read(Uri.parse(copied))).text).toContain(
      'JavaScript',
    );

    const removed = await inject({
      method: 'DELETE',
      url: `/api/v1/fs?uri=${encode(directory)}`,
    });
    expect(resultOf(removed)['removedFiles']).toBeGreaterThan(0);
  });

  it('content/write 的 create 模式在目标存在时 409', async () => {
    const file = `${ROOT}/note.md`;
    await inject({ method: 'POST', url: '/api/v1/content/write', payload: { uri: file, content: 'a' } });
    const response = await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: file, content: 'b', mode: 'create' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['code']).toBe('ALREADY_EXISTS');
  });

  it('content/abstract 与 overview 返回目录摘要', async () => {
    const file = `${ROOT}/memories/note.md`;
    await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: file, content: '正文。' },
    });
    await container.services.indexObserver.drain();

    const directory = `${ROOT}/memories`;
    const abstract = resultOf(
      await inject({
        method: 'GET',
        url: `/api/v1/content/abstract?uri=${encode(directory)}`,
      }),
    );
    const overview = resultOf(
      await inject({
        method: 'GET',
        url: `/api/v1/content/overview?uri=${encode(directory)}`,
      }),
    );
    expect(typeof abstract['abstract']).toBe('string');
    expect(String(overview['overview'])).toContain('# memories');
    expect(abstract['source']).toBe('summary');
    expect(overview['source']).toBe('summary');
  });

  it('文件的 abstract 从索引读，不是摘要文件', async () => {
    // 文件的 L0 存在索引的 `abstract` 字段里（§6.7）。只读 `.abstract.md` 会让
    // 文件详情页永远显示「还没有摘要」，而摘要其实早就生成了。
    const file = `${ROOT}/memories/preferences/code-style.md`;
    await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: {
        uri: file,
        content: '---\nsummary: 严格模式与两空格缩进\n---\n\n正文。',
      },
    });
    await container.services.indexObserver.drain();

    const result = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/abstract?uri=${encode(file)}` }),
    );

    expect(result['source']).toBe('index');

    // 文件没有 L1 概览：概览是目录级的（§9.1）。
    const overview = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/overview?uri=${encode(file)}` }),
    );
    expect(overview['overview']).toBeNull();
    expect(overview['source']).toBe('none');
  });

  it('content/download 校验签名', async () => {
    const file = `${ROOT}/resource.md`;
    await inject({ method: 'POST', url: '/api/v1/content/write', payload: { uri: file, content: '附件' } });

    const url = new URL(createDownloadUrl(Uri.parse(file), container.config));
    const signed = await inject({ method: 'GET', url: `/api/v1/content/download${url.search}` });
    expect(signed.statusCode).toBe(200);
    expect(signed.body).toBe('附件');

    const forged = new URLSearchParams(url.search);
    forged.set('signature', 'forged');
    const rejected = await inject({
      method: 'GET',
      url: `/api/v1/content/download?${forged.toString()}`,
    });
    expect(rejected.statusCode).toBe(403);
    expect(errorOf(rejected)['code']).toBe('PERMISSION_DENIED');
  });
});

describe('检索', () => {
  it('find / search / grep / glob 四个面', async () => {
    const file = `${ROOT}/memories/note.md`;
    await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: file, content: '上下文记忆数据库的设计。' },
    });
    await container.services.indexObserver.drain();

    const find = resultOf(
      await inject({ method: 'POST', url: '/api/v1/search/find', payload: { query: '记忆' } }),
    );
    expect((find['hits'] as unknown[]).length).toBeGreaterThan(0);

    const search = resultOf(
      await inject({ method: 'POST', url: '/api/v1/search/search', payload: { query: '记忆' } }),
    );
    expect(search['plan']).toBeDefined();

    const grep = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/search/grep',
        payload: { uri: ROOT, pattern: '数据库' },
      }),
    );
    expect((grep['hits'] as unknown[]).length).toBeGreaterThan(0);

    const glob = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/search/glob',
        payload: { uri: ROOT, pattern: '**/*.md' },
      }),
    );
    expect(glob['files']).toContain(file);
  });
});

describe('会话与任务', () => {
  it('create → messages → get → list → commit → tasks', async () => {
    const created = resultOf(
      await inject({ method: 'POST', url: '/api/v1/sessions', payload: {} }),
    );
    const sessionUri = String(created['uri']);
    const sessionId = sessionUri.slice(sessionUri.lastIndexOf('/') + 1);

    const appended = await inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      // 批量形状是规范形状（Hook 一次补投多条），单条是它的退化形式。
      payload: { messages: [{ role: 'user', parts: [{ kind: 'text', text: '你好' }] }] },
    });
    expect(appended.statusCode).toBe(200);

    const loaded = resultOf(
      await inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` }),
    );
    expect((loaded['messages'] as unknown[]).length).toBe(1);

    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/sessions' }));
    expect((listed['sessions'] as unknown[]).length).toBe(1);

    const committed = resultOf(
      await inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/commit`, payload: {} }),
    );
    expect(typeof committed['taskId']).toBe('string');

    const tasks = resultOf(await inject({ method: 'GET', url: '/api/v1/tasks' }));
    const taskId = String(committed['taskId']);
    expect((tasks['tasks'] as Record<string, unknown>[]).map((task) => task['id'])).toContain(
      taskId,
    );

    const task = resultOf(await inject({ method: 'GET', url: `/api/v1/tasks/${taskId}` }));
    expect((task['task'] as Record<string, unknown>)['status']).toBe('pending');

    const retry = await inject({ method: 'POST', url: `/api/v1/tasks/${taskId}/retry` });
    expect(retry.statusCode).toBe(409);

    const missing = await inject({ method: 'GET', url: '/api/v1/tasks/nope' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('ACL 与记忆复核', () => {
  it('get → grant → get → revoke', async () => {
    const snapshot = resultOf(
      await inject({ method: 'GET', url: `/api/v1/acl?uri=${encode(ROOT)}` }),
    );
    expect(snapshot['mode']).toBe('inherit');
    expect((snapshot['entries'] as unknown[]).length).toBe(1);

    const granted = await inject({
      method: 'POST',
      url: '/api/v1/acl/grant',
      payload: { uri: ROOT, principal: 'user:bob', level: 1, effect: 'allow' },
    });
    expect(granted.statusCode).toBe(200);

    const after = resultOf(await inject({ method: 'GET', url: `/api/v1/acl?uri=${encode(ROOT)}` }));
    expect(
      (after['entries'] as Record<string, unknown>[]).some(
        (entry) => entry['principal'] === 'user:bob',
      ),
    ).toBe(true);

    const revoked = await inject({
      method: 'POST',
      url: '/api/v1/acl/revoke',
      payload: { uri: ROOT, principal: 'user:bob' },
    });
    expect(revoked.statusCode).toBe(200);

    const missing = await inject({
      method: 'POST',
      url: '/api/v1/acl/revoke',
      payload: { uri: ROOT, principal: 'user:nobody' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('pending → approve', async () => {
    const record = await container.services.memory.upsertMemory(
      Uri.parse(ROOT),
      (await import('../../../src/domain/memory-types/experiences.js')).experiencesMemoryType,
      { topic: 'monorepo', content: '迁移到 monorepo。' },
    );

    const pending = resultOf(
      await inject({ method: 'GET', url: `/api/v1/memories/pending?scopeUri=${encode(ROOT)}` }),
    );
    expect((pending['memories'] as unknown[]).length).toBe(1);

    const approved = await inject({
      method: 'POST',
      url: `/api/v1/memories/${encode(record.uri.toString())}/approve`,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect((await container.services.memory.read(record.uri))?.status).toBe('active');
  });
});

describe('资源与技能', () => {
  it('temp-upload 收原始字节并返回 uploadId', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/resources/temp-upload',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'spec.pdf' },
      payload: Buffer.from('PDF-BYTES'),
    });
    const result = resultOf(response);
    expect(result['size']).toBe(9);
    expect(typeof result['uploadId']).toBe('string');
  });

  it('add_resource 批量写入并建索引', async () => {
    const parentUri = `${ROOT}/resources`;
    const response = await inject({
      method: 'POST',
      url: '/api/v1/resources',
      payload: {
        parentUri,
        files: [{ path: 'docs/architecture.md', content: '架构说明。' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);
    expect((result['created'] as string[]).length).toBe(1);
    await container.services.indexObserver.drain();
    expect(await container.services.index.stat(`${parentUri}/docs/architecture.md`)).not.toBeNull();
  });

  it('add_skill 写入技能包并列出', async () => {
    const parentUri = `${ROOT}/skills`;
    const skill = [
      '---',
      'name: code-review',
      'description: 代码审查',
      '---',
      '',
      '# code-review',
    ].join('\n');
    const response = await inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: {
        parentUri,
        name: 'code-review',
        files: [{ path: 'SKILL.md', content: Buffer.from(skill).toString('base64') }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(resultOf(response)['fileCount']).toBe(1);

    const listed = resultOf(
      await inject({ method: 'GET', url: `/api/v1/skills?scopeUri=${encode(ROOT)}` }),
    );
    expect(listed['skills']).toEqual([
      { uri: `${parentUri}/code-review`, name: 'code-review' },
    ]);
  });
});

describe('MCP 挂载', () => {
  it('/mcp 接受 initialize 请求（Streamable HTTP）', async () => {
    const response = await inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = json(response);
    expect((body['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({
      name: 'comem',
    });
  });
});

describe('管理与遥测', () => {
  it('admin 的五个端点返回 501 NOT_IMPLEMENTED', async () => {
    const calls: InjectOptions[] = [
      { method: 'GET', url: '/api/v1/admin/users' },
      { method: 'POST', url: '/api/v1/admin/users', payload: {} },
      { method: 'GET', url: '/api/v1/admin/groups' },
      { method: 'POST', url: '/api/v1/admin/groups', payload: {} },
      { method: 'POST', url: '/api/v1/admin/groups/eng/members', payload: {} },
    ];
    for (const call of calls) {
      const response = await inject(call);
      expect(response.statusCode, String(call.url)).toBe(501);
      expect(errorOf(response)['code']).toBe('NOT_IMPLEMENTED');
    }
  });

  it('telemetry/hook 上报后 /metrics 里能看到', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/telemetry/hook',
      payload: {
        event: 'stop',
        sessionId: 'sess_1',
        phases: { processStartMs: 30, recallMs: 100, serializeMs: 5, captureMs: 5 },
      },
    });
    expect(response.statusCode).toBe(200);

    const metrics = await inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('comem_hook_overhead_total_seconds{event="stop"} 0.14');
    expect(metrics.body).toContain('comem_hook_overhead_seconds{event="stop",phase="recall"} 0.1');
  });

  it('telemetry/hook 拒绝非法阶段值', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/telemetry/hook',
      payload: {
        event: 'stop',
        phases: { processStartMs: 'x', recallMs: 0, serializeMs: 0, captureMs: 0 },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
  });
});
