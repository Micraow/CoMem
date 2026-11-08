/**
 * 提示词 HTTP 端点的验收（架构文档 §14、§18）。
 *
 * 用真实容器 + `app.inject()`（进程内请求）：这一层要证明的是**接线**——路由拿到
 * 的是容器里那一份 `PromptService`，保存之后下一条请求读得到，而不是「服务层单测
 * 全绿但端点没挂上」。`check:config` 抓不到这一类（它只看配置读取）。
 *
 * 网络边界用 `fetch` 替身封住：容器会构造 LLM 相关服务，但不应该有真实请求。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';

/** 不可能连上的回环端口；真正的隔离靠 `fetch` 替身，它一定抛错。 */
const UNREACHABLE_LLM_BASE_URL = 'http://127.0.0.1:1/v1';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

interface OkBody<T> {
  readonly status: 'ok';
  readonly result: T;
}

interface ErrorBody {
  readonly status: 'error';
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (): Promise<Response> => {
    throw new TypeError('集成测试不发起真实网络请求。');
  });

  dataDir = await mkdtemp(join(tmpdir(), 'comem-prompts-'));
  container = await createContainer({
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

function okBody<T>(payload: unknown): T {
  const envelope = payload as OkBody<T>;
  expect(envelope.status).toBe('ok');
  return envelope.result;
}

function errorBody(payload: unknown): ErrorBody['error'] {
  const envelope = payload as ErrorBody;
  expect(envelope.status).toBe('error');
  return envelope.error;
}

describe('GET /prompts', () => {
  it('列出六条提示词，初始都没有覆盖', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prompts' });
    expect(response.statusCode).toBe(200);

    const result = okBody<{ prompts: readonly Record<string, unknown>[] }>(response.json());

    expect(result.prompts).toHaveLength(6);
    expect(result.prompts.map((prompt) => prompt['id'])).toEqual([
      'extract-system',
      'extract-user',
      'summarize-system',
      'summarize-user',
      'rewrite-system',
      'rewrite-user',
    ]);
    expect(result.prompts.every((prompt) => prompt['overridden'] === false)).toBe(true);
    expect(result.prompts.every((prompt) => prompt['stale'] === false)).toBe(true);
    // 列表不带正文：六条模板加起来十几 KB，列表用不到。
    expect(result.prompts.every((prompt) => !('body' in prompt))).toBe(true);
  });
});

describe('GET /prompts/:id', () => {
  it('返回当前正文与仓库默认正文', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prompts/extract-user' });
    expect(response.statusCode).toBe(200);

    const detail = okBody<Record<string, unknown>>(response.json());

    expect(detail['id']).toBe('extract-user');
    expect(detail['description']).toBe('记忆抽取 · 用户消息');
    expect(detail['overridden']).toBe(false);
    expect(detail['body']).toBe(detail['defaultBody']);
    expect(String(detail['body'])).toContain('{{pages}}');
    expect(detail['variables']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pages' })]),
    );
  });

  it('未知标识返回 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prompts/nope' });

    expect(response.statusCode).toBe(404);
    expect(errorBody(response.json()).code).toBe('NOT_FOUND');
  });
});

describe('PUT /prompts/:id', () => {
  it('保存之后列表显示已自定义，详情返回覆盖正文', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/extract-user',
      payload: { body: '## 已读记忆\n\n{{pages}}\n\n## 任务\n\n只输出 JSON。' },
    });
    expect(saved.statusCode).toBe(200);
    expect(okBody<Record<string, unknown>>(saved.json())['overridden']).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/prompts' });
    const overridden = okBody<{ prompts: readonly { id: string; overridden: boolean }[] }>(
      list.json(),
    ).prompts.filter((prompt) => prompt.overridden);

    expect(overridden.map((prompt) => prompt.id)).toEqual(['extract-user']);

    const detail = await app.inject({ method: 'GET', url: '/api/v1/prompts/extract-user' });
    expect(okBody<Record<string, unknown>>(detail.json())['body']).toContain('只输出 JSON。');
  });

  it('未知变量被拒绝，错误里带变量名与行号', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/extract-user',
      payload: { body: '## 已读记忆\n\n{{pagess}}' },
    });

    expect(response.statusCode).toBe(400);
    const error = errorBody(response.json());
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('pagess');
    expect((error.details as Record<string, unknown>)['variable']).toBe('pagess');
  });

  it('空正文被拒绝', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/extract-user',
      payload: { body: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.json()).code).toBe('INVALID_ARGUMENT');
  });

  it('未知标识返回 404，不写入任何覆盖', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/nope',
      payload: { body: '随便写点什么' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /prompts/:id', () => {
  it('删掉覆盖之后回到默认', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/summarize-user',
      payload: { body: '{{uri}}' },
    });

    const reset = await app.inject({ method: 'DELETE', url: '/api/v1/prompts/summarize-user' });

    expect(reset.statusCode).toBe(200);
    const detail = okBody<Record<string, unknown>>(reset.json());
    expect(detail['overridden']).toBe(false);
    expect(detail['updatedAt']).toBeNull();
  });

  it('没有覆盖时删除是幂等的', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/prompts/rewrite-user' });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /prompts/:id/preview', () => {
  it('返回渲染结果，没传的变量填中文说明', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prompts/rewrite-user/preview',
      payload: { variables: { query: '代码风格约定' } },
    });

    expect(response.statusCode).toBe(200);
    const result = okBody<{ text: string }>(response.json());

    expect(result.text).toContain('代码风格约定');
    expect(result.text).toContain('〔最近几轮对话，越靠后越新〕');
    expect(result.text).not.toContain('{{');
  });

  it('不带请求体也能预览（全部用说明占位）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prompts/summarize-user/preview',
    });

    expect(response.statusCode).toBe(200);
    expect(okBody<{ text: string }>(response.json()).text).toContain('〔要生成摘要的目录〕');
  });

  it('预览用的是当前覆盖', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/prompts/rewrite-user',
      payload: { body: '只有 {{query}}' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prompts/rewrite-user/preview',
      payload: { variables: { query: '一句话' } },
    });

    expect(okBody<{ text: string }>(response.json()).text).toBe('只有 一句话');
  });

  it('变量值不是字符串时拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prompts/rewrite-user/preview',
      payload: { variables: { query: 1 } },
    });

    expect(response.statusCode).toBe(400);
  });
});
