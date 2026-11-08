/**
 * stdio 代理的协议契约（架构文档 §15.6）。
 *
 * 端到端链路在 `tests/integration/mcp/stdio-proxy.test.ts`（真起进程）。这里只钉
 * 三件在进程内就能穷举的事：
 *
 * 1. **stdout 只走协议**——宿主按行 `JSON.parse`，漏一行日志进去就报
 *    `JSON-RPC parse error`，而错误信息指不回是哪个进程写的。
 * 2. **失败要能定位**——「HTTP 401」不是能行动的信息，每类失败都得说清下一步。
 * 3. **SSE 解析**——`enableJsonResponse` 关掉时代理不能静默返回空。
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

import { createMcpProxy, parseSseMessages } from '../servers/mcp-proxy.mjs';

const BASE_CONFIG = Object.freeze({
  baseUrl: 'http://127.0.0.1:1933',
  token: '',
  mcpTimeoutMs: 15000,
});

/** 收集写入内容的最小可写流。 */
function collector() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** `fetch` 的替身：记录请求，按队列返回响应。 */
function fetchStub(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('fetchStub 的响应队列空了');
    }
    if (next instanceof Error) {
      throw next;
    }
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': next.contentType ?? 'application/json' },
    });
  };
  return { impl, calls };
}

function buildProxy(options = {}) {
  const stdout = collector();
  const stderr = collector();
  const proxy = createMcpProxy({
    config: { ...BASE_CONFIG, ...(options.config ?? {}) },
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl: options.fetchImpl,
    debug: options.debug ?? false,
  });
  return { proxy, stdout: stdout.text, stderr: stderr.text };
}

/** 从 stdout 里读回全部 JSON-RPC 消息；任何一行不是 JSON 都算失败。 */
function readMessages(text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

test('initialize 的响应原样转发，协商出的版本用在后续请求上', async () => {
  const fetch = fetchStub([
    {
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'comem', version: '0.1.0' },
        },
      },
    },
    { body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } },
  ]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {} },
    }),
  );
  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));

  const [initialize, list] = fetch.calls;
  assert.equal(initialize.url, 'http://127.0.0.1:1933/mcp');
  assert.equal(initialize.init.headers.accept, 'application/json, text/event-stream');
  // 第一条还不能带版本：还没协商出来，发了就是猜。
  assert.equal(initialize.init.headers['mcp-protocol-version'], undefined);
  assert.equal(list.init.headers['mcp-protocol-version'], '2025-06-18');

  const messages = readMessages(stdout());
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  );
  assert.equal(messages[0].result.serverInfo.name, 'comem');
});

test('有 token 时发 Authorization: Bearer', async () => {
  const fetch = fetchStub([{ body: { jsonrpc: '2.0', id: 1, result: {} } }]);
  const { proxy } = buildProxy({ fetchImpl: fetch.impl, config: { token: 'comem_abc' } });

  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));

  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer comem_abc');
});

test('通知（没有 id）不往 stdout 写东西', async () => {
  const fetch = fetchStub([{ body: '', status: 202 }]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  );

  assert.equal(stdout(), '');
  assert.equal(fetch.calls.length, 1);
});

test('401 的报错指向凭据该放哪里，不是「HTTP 401」', async () => {
  const fetch = fetchStub([
    {
      status: 401,
      body: { status: 'error', error: { code: 'UNAUTHENTICATED', message: '凭据无效' } },
    },
  ]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));

  const [message] = readMessages(stdout());
  assert.equal(message.id, 7);
  assert.equal(message.error.code, -32001);
  assert.match(message.error.message, /COMEM_TOKEN/);
  assert.match(message.error.message, /凭据无效/);
});

test('超时与连不上分开报：超时说明服务端可能还在算', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const timeoutFetch = fetchStub([abort]);
  const timedOut = buildProxy({ fetchImpl: timeoutFetch.impl });
  await timedOut.proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
  const [timeoutMessage] = readMessages(timedOut.stdout());
  assert.equal(timeoutMessage.error.code, -32004);
  assert.match(timeoutMessage.error.message, /15000ms/);
  assert.match(timeoutMessage.error.message, /COMEM_MCP_TIMEOUT_MS/);

  const unreachableFetch = fetchStub([new TypeError('fetch failed')]);
  const unreachable = buildProxy({ fetchImpl: unreachableFetch.impl });
  await unreachable.proxy.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  );
  const [unreachableMessage] = readMessages(unreachable.stdout());
  assert.equal(unreachableMessage.error.code, -32005);
  assert.match(unreachableMessage.error.message, /curl http:\/\/127\.0\.0\.1:1933\/health/);
});

test('非 2xx 但不是 401 时带上服务端原话', async () => {
  const fetch = fetchStub([
    { status: 500, body: { status: 'error', error: { message: '索引损坏' } } },
  ]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));

  const [message] = readMessages(stdout());
  assert.equal(message.error.code, -32002);
  assert.match(message.error.message, /500/);
  assert.match(message.error.message, /索引损坏/);
});

test('2xx 但响应体为空时明确报错，不是静默成功', async () => {
  const fetch = fetchStub([{ body: '' }]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));

  const [message] = readMessages(stdout());
  assert.equal(message.error.code, -32003);
});

test('非法 JSON 行回 -32700，且不影响后续请求', async () => {
  const fetch = fetchStub([{ body: { jsonrpc: '2.0', id: 1, result: {} } }]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine('{不是 JSON');
  await proxy.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));

  const messages = readMessages(stdout());
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[0].id, null);
  assert.equal(messages[1].id, 1);
});

test('jsonrpc 不是 2.0 的消息被拒，不转发给服务端', async () => {
  const fetch = fetchStub([]);
  const { proxy, stdout } = buildProxy({ fetchImpl: fetch.impl });

  await proxy.handleLine(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }));

  assert.equal(fetch.calls.length, 0);
  const [message] = readMessages(stdout());
  assert.equal(message.error.code, -32600);
});

test('stdout 只走协议：任何输入下每一行都是合法 JSON-RPC', async () => {
  const fetch = fetchStub([
    { body: { jsonrpc: '2.0', id: 1, result: { tools: [] } } },
    { status: 401, body: { status: 'error', error: { message: 'no' } } },
    { body: '', status: 202 },
    { body: 'data: {"jsonrpc":"2.0","id":9,"result":{}}\n\n', contentType: 'text/event-stream' },
  ]);
  // debug 打开后日志才会写——它必须全落在 stderr。
  const { proxy, stdout, stderr } = buildProxy({ fetchImpl: fetch.impl, debug: true });

  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health","arguments":{}}}',
    '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    '坏行',
    '',
  ];
  for (const line of lines) {
    await proxy.handleLine(line);
  }

  for (const line of stdout().split('\n').filter((entry) => entry !== '')) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0', `stdout 混进了非协议内容：${line}`);
    assert.ok('result' in message || 'error' in message, `消息既没有 result 也没有 error：${line}`);
  }
  // 日志确实走了 stderr（否则上面那条断言只是「没打开 debug」）。
  assert.match(stderr(), /"stage":"notification_failed"/);
  assert.ok(!stdout().includes('"stage"'), '日志漏到了 stdout');
});

test('SSE 响应体按 data 行拆成多条消息', () => {
  const messages = parseSseMessages(
    [
      ': 注释行要被跳过',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{}}',
      '',
      'data: {"jsonrpc":"2.0",',
      'data: "id":2,"result":{}}',
      '',
      'data: [DONE]',
      '',
    ].join('\r\n'),
  );

  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  );
});

test('SSE 的空行与纯注释不产出消息', () => {
  assert.deepEqual(parseSseMessages(''), []);
  assert.deepEqual(parseSseMessages('\n\n\n'), []);
  assert.deepEqual(parseSseMessages(': keep-alive\n\n'), []);
});
