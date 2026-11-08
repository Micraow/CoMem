import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDownloadUrl } from '../../../src/api/mcp/tools/download.js';
import { createHttpServer, PROMETHEUS_CONTENT_TYPE } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';

/**
 * LLM 供应商地址：**显式**指向一个不可能成功的回环端口。
 *
 * 这两个用例（`find/search/grep/glob` 与 `mode` 缺省快照）测的是「意图分析不可用
 * 时的降级行为」。不写这个覆盖时，配置默认值是 `https://api.example.com/v1`——
 * 测试会真的连外网，5 秒超时；而贡献者不设 `COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL`
 * 时测试就红。**测试不能依赖本机环境**（同一个坑在 `config.yaml` 上踩过一次）。
 *
 * 回环端口 1 只是「意图」的书面说明：真正的隔离靠下面的 `fetch` 替身——它一定
 * 抛错，不打开任何 socket。两者一起保证「没有一条真实网络请求」。
 */
const UNREACHABLE_LLM_BASE_URL = 'http://127.0.0.1:1/v1';

/** 替身拦下的请求 URL。用于断言请求目标只可能是那个回环地址。 */
const blockedFetchUrls: string[] = [];

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  blockedFetchUrls.length = 0;
  // 网络边界替身：任何一次 `fetch` 都立即失败，不产生真实连接。
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request): Promise<Response> => {
      blockedFetchUrls.push(String(input));
      throw new TypeError('fetch failed: 集成测试不发起真实网络请求。');
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-http-'));
  container = await createContainer({
    // **配置从临时目录读，不是仓库根。**
    //
    // 缺省时 `loadConfig` 读 cwd 的 `config.yaml`——那是开发者本机的配置，
    // 可能指向真实远程网关。测试一旦读它就不再是孤立的：网络抖动、配额、
    // 甚至「今天没开代理」都会让测试红，而红的原因与代码无关。
    //
    // 临时目录里没有这个文件，所以走内置默认值。
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: UNREACHABLE_LLM_BASE_URL,
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
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * 意图分析降级必须**可解释**，而且请求目标只能是我们注入的回环地址。
 *
 * 只断言「测试没超时」不够：下一次有人把 `fetch` 替身删掉，测试可能靠本机能连上
 * 外网而继续绿。这里同时钉住 `analyzed === false`、`reason` 非空与「所有被拦下的
 * URL 都是 127.0.0.1」三个事实。
 */
function expectIntentAnalysisDegraded(plan: Record<string, unknown>): void {
  expect(plan['analyzed']).toBe(false);
  expect(String(plan['reason'])).toContain('意图分析失败');
  expect(blockedFetchUrls.length).toBeGreaterThan(0);
  for (const url of blockedFetchUrls) {
    expect(new URL(url).hostname).toBe('127.0.0.1');
  }
}

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

describe('身份绑定可配置', () => {
  /** 用独立临时容器验证 `server.subject` 真的决定服务图身份。 */
  async function withContainer(
    env: Record<string, string>,
    run: (created: Container) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-subject-'));
    const created = await createContainer({
      configPath: join(dir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: dir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        ...env,
      },
    });
    try {
      await run(created);
    } finally {
      await created.services.indexObserver.drain();
      await created.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('server.subject 决定容器绑定的主体', async () => {
    await withContainer({ COMEM_SERVER_SUBJECT: 'user:alice' }, async (created) => {
      await expect(created.resolveIdentity({})).resolves.toEqual({
        subject: 'user:alice',
        principals: ['user:alice', 'user:*'],
      });
    });
  });

  it('默认绑定 user:local', async () => {
    await withContainer({}, async (created) => {
      await expect(created.resolveIdentity({})).resolves.toEqual({
        subject: 'user:local',
        principals: ['user:local', 'user:*'],
      });
    });
  });

  it('GET /health 返回绑定主体与可寻址的根（控制台身份引导）', async () => {
    await withContainer({ COMEM_SERVER_SUBJECT: 'user:alice' }, async (created) => {
      const healthApp = await createHttpServer({
        config: created.config,
        logger: created.logger,
        observability: created.observability,
        routes: created.routes,
        mcp: created.mcp,
        resolveIdentity: created.resolveIdentity,
      });
      try {
        const result = resultOf(await healthApp.inject({ method: 'GET', url: '/health' }));
        // 控制台不再硬编码 `user:local`：主体与可寻址的根都来自这里（§18）。
        expect(result['subject']).toBe('user:alice');
        expect(result['scopes']).toEqual(['comem://user/alice']);
      } finally {
        await healthApp.close();
      }
    });
  });

  it('server.subject 是组主体时启动即拒绝（服务图只接受 user）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-subject-group-'));
    try {
      await expect(
        createContainer({
          configPath: join(dir, 'config.yaml'),
          env: {
            ...process.env,
            COMEM_DATA_DIR: dir,
            COMEM_SUMMARY_GENERATOR: 'rule',
            COMEM_LOGGING_LEVEL: 'error',
            COMEM_SERVER_SUBJECT: 'group:eng',
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('server.subject 非法时启动即抛 INVALID_ARGUMENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-subject-bad-'));
    try {
      await expect(
        createContainer({
          configPath: join(dir, 'config.yaml'),
          env: {
            ...process.env,
            COMEM_DATA_DIR: dir,
            COMEM_SUMMARY_GENERATOR: 'rule',
            COMEM_LOGGING_LEVEL: 'error',
            COMEM_SERVER_SUBJECT: 'alice',
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
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
    // 意图分析走的是注入的不可达 LLM 端口，降级必须写进 plan（§8.4）。
    expectIntentAnalysisDegraded(search['plan'] as Record<string, unknown>);

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

describe('检索 mode = context', () => {
  const FILE = `${ROOT}/memories/context-note.md`;

  /** 摘要进索引后，`context` 才有 L0 可投（§8.6 的起始层级）。 */
  async function seedMemory(): Promise<void> {
    await container.services.filesystem.write(
      Uri.parse(FILE),
      '# 标题\n\n上下文记忆数据库。',
      { frontmatter: { summary: '一句话摘要' } },
    );
    await container.services.indexObserver.drain();
  }

  async function createSession(): Promise<string> {
    const created = resultOf(
      await inject({ method: 'POST', url: '/api/v1/sessions', payload: {} }),
    );
    const uri = String(created['uri']);
    return uri.slice(uri.lastIndexOf('/') + 1);
  }

  async function appendMessage(sessionId: string): Promise<void> {
    await inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { messages: [{ role: 'user', parts: [{ kind: 'text', text: '继续' }] }] },
    });
  }

  function contextBody(sessionId?: string): Record<string, unknown> {
    return { query: '记忆', mode: 'context', ...(sessionId === undefined ? {} : { sessionId }) };
  }

  it('mode 缺省时响应形状与改动前一致（快照）', async () => {
    await seedMemory();

    const result = resultOf(
      await inject({ method: 'POST', url: '/api/v1/search/search', payload: { query: '记忆' } }),
    );

    // `elapsedMs` 是墙钟；`reason` 的文案取决于降级原因，两者归一化。其余字段
    // （含分数）必须逐字相同。降级本身由上面的 `expectIntentAnalysisDegraded`
    // 显式钉住——不依赖本机能不能连上模型。
    const plan = result['plan'] as Record<string, unknown>;
    expectIntentAnalysisDegraded(plan);
    expect({
      ...result,
      plan: {
        ...plan,
        elapsedMs: 0,
        reason: plan['reason'] === null ? null : '<degraded>',
      },
    }).toMatchSnapshot();
  });

  it('mode=context 返回分层条目与可直接注入的文本', async () => {
    await seedMemory();

    const result = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/search/search',
        payload: contextBody(),
      }),
    );

    expect(Object.keys(result).sort()).toEqual(['dropped', 'items', 'rendered', 'usedTokens']);
    const items = result['items'] as Record<string, unknown>[];
    expect(items.map((item) => item['uri'])).toContain(FILE);
    // 预算允许时会从 abstract 升到 full（§8.6 的三轮升级）；关键是拿到了正文。
    expect(items[0]?.['detail']).not.toBeNull();
    expect(String(items[0]?.['text'] ?? '').length).toBeGreaterThan(0);
    expect(String(result['rendered'])).toContain('<memory');
    expect(Number(result['usedTokens'])).toBeGreaterThan(0);
  });

  it('连续两次 mode=context：第二次不重复投放第一次给过的条目', async () => {
    await seedMemory();
    const sessionId = await createSession();

    const first = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/search/search',
        payload: contextBody(sessionId),
      }),
    );
    expect((first['items'] as unknown[]).length).toBeGreaterThan(0);

    // 推进一轮：轮次时钟取消息总数（§8.7）。
    await appendMessage(sessionId);

    const second = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/search/search',
        payload: contextBody(sessionId),
      }),
    );
    expect(second['items']).toEqual([]);
    expect(second['rendered']).toBe('');
  });

  it('MCP search 工具支持 mode=context', async () => {
    await seedMemory();

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
        method: 'tools/call',
        params: { name: 'search', arguments: { query: '记忆', mode: 'context' } },
      },
    });

    const body = json(response);
    const content = (body['result'] as Record<string, unknown>)['content'] as {
      readonly text: string;
    }[];
    expect(content[0]?.text).toContain('token(s)');
    expect(content[0]?.text).toContain('<memory');
  });

  it('非法 mode 抛 INVALID_ARGUMENT', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/search/search',
      payload: { query: '记忆', mode: 'deep' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
  });
});

describe('会话与任务', () => {
  it('create 之后 GET /sessions 立刻能列出它（不靠后续写入补权限）', async () => {
    const created = resultOf(
      await inject({ method: 'POST', url: '/api/v1/sessions', payload: {} }),
    );
    const sessionUri = String(created['uri']);

    // 会话服务直接写 `ContentStore`，观察者收不到通知。不物化时 `GET /sessions`
    // 的 `list(sessions/)` 会因为缺 `node_permission` 行返回空——建成功了，列表里
    // 却没有，要等用户点进某个会话 URI 才补出来。
    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/sessions' }));
    expect((listed['sessions'] as Record<string, unknown>[]).map((session) => session['uri'])).toEqual([
      sessionUri,
    ]);
  });

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

    // 写记忆时把 L0 摘要写进 frontmatter 的 `summary`：`IndexObserver` 把它当
    // `abstract` 索引，检索侧的重排直接读它，不需要为了重排再打开文件。
    const indexed = await container.services.index.stat(record.uri.toString());
    expect(indexed?.abstract).toBe('迁移到 monorepo。');

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

    // 写后物化：资源服务直接写 `ContentStore`，不走观察者。不物化时 `list` 会因为
    // 缺 `node_permission` 行把新文件整个过滤掉——写成功了，树里什么都没有。
    const listed = await container.services.filesystem.list(Uri.parse(parentUri));
    expect(listed.map((entry) => entry.uri.name)).toEqual(['docs']);
    const documents = await container.services.filesystem.list(Uri.parse(`${parentUri}/docs`));
    expect(documents.map((entry) => entry.uri.toString())).toEqual([
      `${parentUri}/docs/architecture.md`,
    ]);
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

    // 写后物化：技能目录没有自己的 `node_permission` 行时，上面的 `listSkills`
    // 会把它整个过滤掉。
    const directories = await container.services.filesystem.list(Uri.parse(parentUri));
    expect(directories.map((entry) => entry.uri.name)).toEqual(['code-review']);
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
  it('admin 端点不再是 501 占位', async () => {
    // 详细语义在 `tests/integration/api/admin.test.ts`；这里只钉住「控制台打开时
    // 不会看到一片 501」这个部署事实。
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/groups']) {
      const response = await inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(json(response)['status']).toBe('ok');
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

describe('指标开关', () => {
  /** 用独立的临时容器验证配置真的生效（不改外层 beforeEach 的默认装配）。 */
  async function withApp(
    env: Record<string, string>,
    run: (app: FastifyInstance, created: Container) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-metrics-'));
    const created = await createContainer({
      configPath: join(dir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: dir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        ...env,
      },
    });
    const createdApp = await createHttpServer({
      config: created.config,
      logger: created.logger,
      observability: created.observability,
      routes: created.routes,
      mcp: created.mcp,
      resolveIdentity: created.resolveIdentity,
    });
    try {
      await run(createdApp, created);
    } finally {
      await created.services.indexObserver.drain();
      await createdApp.close();
      await created.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('metrics.enabled=false 时 /metrics 返回 404 并说明原因', async () => {
    await withApp({ COMEM_TELEMETRY_METRICS_ENABLED: 'false' }, async (app) => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response)['message']).toContain('指标已关闭');
    });
  });

  it('includeAccountLabel 打开后请求耗时按账号拆标签', async () => {
    await withApp({ COMEM_TELEMETRY_METRICS_INCLUDE_ACCOUNT_LABEL: 'true' }, async (app, created) => {
      // 直接喂一条请求记录：`onResponse` 是异步的，注入端点读不到确定的写入时刻。
      await created.observability.recordRequest({
        requestId: 'req-metrics',
        method: 'GET',
        path: '/health',
        statusCode: 200,
        durationMs: 12,
        errorCode: null,
        subject: 'user:local',
      });

      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body).toContain(
        'comem_http_request_duration_seconds_count{account="user:local"} 1',
      );
      // 同一指标族不能混着有无标签的样本，否则 Prometheus 抓取整段失败。
      expect(metrics.body).not.toContain('comem_http_request_duration_seconds_count 1');
    });
  });
});

describe('重排接线', () => {
  it('retrieval.rerank.enabled 打开后 find 真的调用重排供应商', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-rerank-'));
    let capturedUrl = '';
    let capturedBody: unknown = null;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body === undefined ? null : JSON.parse(String(init.body));
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.99 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const created = await createContainer({
      configPath: join(dir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: dir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        COMEM_RETRIEVAL_RERANK_ENABLED: 'true',
        COMEM_PROVIDERS_RERANK_TYPE: 'http',
        COMEM_PROVIDERS_RERANK_BASE_URL: 'https://rerank.example.test/v1',
        COMEM_PROVIDERS_RERANK_MODEL: 'test-reranker',
        COMEM_PROVIDERS_RERANK_API_KEY: 'test-key',
      },
    });

    try {
      const file = `${ROOT}/memories/rerank.md`;
      await created.services.filesystem.write(Uri.parse(file), '上下文记忆数据库。', {
        frontmatter: { summary: '一句话摘要' },
      });
      // 没有 frontmatter 摘要的普通文档（存量记忆、非记忆文件都是这种形态）。
      // 重排必须降级用正文，否则空文本候选会被 `applyRerank` 全部跳过。
      const bodyOnly = `${ROOT}/memories/rerank-body.md`;
      await created.services.filesystem.write(
        Uri.parse(bodyOnly),
        '上下文记忆数据库的正文兜底。',
      );
      await created.services.indexObserver.drain();

      const hits = await created.services.search.find('记忆', {
        scopes: [ROOT],
        subject: SUBJECT,
        principals: [SUBJECT, 'user:*'],
      });

      expect(hits).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe('https://rerank.example.test/v1/rerank');
      const documents = (capturedBody as { readonly documents: readonly string[] }).documents;
      // 摘要优先（索引里就有，零 I/O），摘不到时用正文前 512 字符兜底。
      expect(documents).toContain('一句话摘要');
      expect(documents).toContain('上下文记忆数据库的正文兜底。');
      // 模型的分数直接成为最终分数（不 clamp、不与融合分混合）。
      expect(hits[0]?.score).toBe(0.99);
    } finally {
      vi.unstubAllGlobals();
      await created.services.indexObserver.drain();
      await created.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
