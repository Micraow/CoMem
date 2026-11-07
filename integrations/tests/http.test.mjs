/**
 * HTTP 客户端（架构文档 §14 的封套、§15.9 的超时预算）。
 *
 * 核心约束：**POST 不重试，GET 重试**。反过来会把「游标没动」的窗口摊大，制造
 * 重复消息。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { ComemHookError, createHttpClient } from '../lib/http.mjs';

/** 假服务端：按 `handlers` 逐次响应，记录每次请求。 */
async function startServer(handlers) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: request.method,
      url: request.url,
      body: text === '' ? undefined : JSON.parse(text),
    });
    const handler = handlers[Math.min(requests.length - 1, handlers.length - 1)];
    await handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function ok(result) {
  return (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result }));
  };
}

function fail(status, code = 'INTERNAL') {
  return (request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: { code, message: '坏了' } }));
  };
}

test('拆 ok 封套，返回 result', async () => {
  const server = await startServer([ok({ hits: [] })]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    assert.deepEqual(await client.post('/api/v1/search/find', { query: 'x' }), { hits: [] });
    assert.deepEqual(server.requests[0].body, { query: 'x' });
    assert.equal(server.requests[0].method, 'POST');
  } finally {
    await server.close();
  }
});

test('POST 不重试：5xx 只发一次', async () => {
  const server = await startServer([fail(500)]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    await assert.rejects(() => client.post('/api/v1/sessions/cc-1/messages', {}), (error) => {
      assert.ok(error instanceof ComemHookError);
      assert.equal(error.status, 500);
      assert.equal(error.message, '坏了');
      return true;
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('GET 重试 5xx', async () => {
  const server = await startServer([fail(503), ok('好了')]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    assert.equal(await client.get('/health'), '好了');
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test('GET 在 4xx 上不重试', async () => {
  const server = await startServer([fail(404, 'NOT_FOUND')]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    await assert.rejects(() => client.get('/api/v1/content/read'), /坏了/);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('超时抛 HOOK_TIMEOUT', async () => {
  const server = await startServer([
    async (request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.end('{}');
    },
  ]);
  try {
    // 只测一次尝试，避免重试把用例拖长。
    const client = createHttpClient({ baseUrl: server.baseUrl, timeoutMs: 20, retries: 0 });
    await assert.rejects(
      () => client.post('/api/v1/search/find', {}),
      (error) => {
        assert.equal(error.code, 'HOOK_TIMEOUT');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('服务端不可达抛 HOOK_UNREACHABLE', async () => {
  // 端口 1 上没有服务端；GET 会重试，用 retries:0 缩短用例。
  const client = createHttpClient({ baseUrl: 'http://127.0.0.1:1', retries: 0, timeoutMs: 100 });
  await assert.rejects(() => client.get('/health'), (error) => {
    assert.equal(error.code, 'HOOK_UNREACHABLE');
    return true;
  });
});

test('查询参数被正确编码', async () => {
  const server = await startServer([ok('x')]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    await client.get('/api/v1/content/read', { uri: 'comem://user/alice/memories/profile.md' });
    assert.match(server.requests[0].url, /uri=comem%3A%2F%2Fuser%2Falice%2Fmemories%2Fprofile\.md/);
  } finally {
    await server.close();
  }
});

test('非封套的纯文本响应原样返回', async () => {
  const server = await startServer([
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('OK');
    },
  ]);
  try {
    const client = createHttpClient({ baseUrl: server.baseUrl });
    assert.equal(await client.get('/health'), 'OK');
  } finally {
    await server.close();
  }
});
