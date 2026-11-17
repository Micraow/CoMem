import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../dsh-plugin/lib/index.js';

test('DSH 用会话 ID 召回与采集，typed 工具事件保留决定与来源，子会话不采集', async () => {
  const requests = [];
  let receivedMessages;
  const received = new Promise((resolve) => { receivedMessages = resolve; });
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text === '' ? {} : JSON.parse(text);
    requests.push({ path: request.url, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: { rendered: '背景正文' } }));
    if (request.url.endsWith('/messages')) receivedMessages(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listeners = new Map();
  const agent = { id: 'agent-other-id', session: { id: 'session-one', header: {} }, inject: () => {} };
  try {
    apply({ on: (event, listener) => listeners.set(event, listener), logger: { warn: () => {} } }, {
      baseUrl: `http://127.0.0.1:${server.address().port}`, token: '', timeoutMs: 1000, recallTimeoutMs: 6000,
    });
    await listeners.get('agent/created')({ agent, source: 'startup' });
    assert.equal(requests.find((entry) => entry.path === '/api/v1/context').body.sessionId, 'dsh-session-one');
    const tool = listeners.get('tools/post-execute');
    const decision = { output: { projection: 'keep' } };
    assert.equal(await tool({ agent, name: 'bash', callId: 'call-one', arguments: { command: 'uname -m' } }, {
      isError: false, content: [{ type: 'text', text: 'x86_64' }],
    }, async () => decision), decision);
    const child = { ...agent, session: { id: 'child', header: { origin: 'subagent' } } };
    const count = requests.length;
    const step = { kind: 'enter', messages: [] };
    const recalled = await listeners.get('agent/pre-step')({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '查询已有的设备配置' }] }] }, async () => step);
    assert.equal(recalled.messages.length, 1);
    assert.ok(requests.find((entry) => entry.body.query === '查询已有的设备配置').body.budgetMs > 4000);
    const afterRecall = requests.length;
    assert.equal(await listeners.get('agent/pre-step')({ agent: child, messages: [{ role: 'user' }] }, async () => step), step);
    assert.ok(afterRecall > count);
    assert.equal(requests.length, afterRecall);
    await tool({ agent: child, name: 'bash', callId: 'ignored', arguments: {} }, { content: [] }, async () => decision);
    listeners.get('session/event')(agent.session, { type: 'turn/end', time: Date.now() });
    const body = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('capture timed out')), 2000).unref())]);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].parts[0].name, 'bash');
    assert.equal(body.messages[0].parts[1].output, 'x86_64');
    assert.equal(body.messages[0].source.host, 'dsh');
    assert.equal(body.messages[0].source.machineId.length, 16);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DSH patch 不写连接字段时复用共享 config.yaml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-dsh-config-'));
  const configFile = join(dir, 'config.yaml');
  const previousConfigFile = process.env.COMEM_CONFIG_FILE;
  const previousBaseUrl = process.env.COMEM_BASE_URL;
  let authorization;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: { rendered: '来自共享配置' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listeners = new Map();
  let injected;
  try {
    await writeFile(
      configFile,
      `baseUrl: http://127.0.0.1:${server.address().port}\ntoken: 'comem_shared'\n`,
      'utf8',
    );
    process.env.COMEM_CONFIG_FILE = configFile;
    delete process.env.COMEM_BASE_URL;
    const agent = {
      session: { id: 'shared-config', header: Object.create(null) },
      inject: (message) => { injected = message; },
    };
    apply(
      { on: (event, listener) => listeners.set(event, listener), logger: { warn: () => undefined } },
      { timeoutMs: 1000 },
    );
    await listeners.get('agent/created')({ agent, source: 'startup' });
    assert.match(injected.content[0].text, /来自共享配置/);
    assert.equal(authorization, 'Bearer comem_shared');
  } finally {
    if (previousConfigFile === undefined) delete process.env.COMEM_CONFIG_FILE;
    else process.env.COMEM_CONFIG_FILE = previousConfigFile;
    if (previousBaseUrl === undefined) delete process.env.COMEM_BASE_URL;
    else process.env.COMEM_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('DSH 共享配置无效时停用插件，不写回环默认身份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-dsh-invalid-'));
  const configFile = join(dir, 'config.yaml');
  const previousConfigFile = process.env.COMEM_CONFIG_FILE;
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: { rendered: '不应发生' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listeners = new Map();
  const warnings = [];
  try {
    await writeFile(configFile, 'this is not yaml\n', 'utf8');
    process.env.COMEM_CONFIG_FILE = configFile;
    const agent = {
      session: { id: 'invalid-config', header: Object.create(null) },
      inject: () => {
        throw new Error('配置无效时不能注入');
      },
    };
    apply(
      {
        on: (event, listener) => listeners.set(event, listener),
        logger: { warn: (message) => warnings.push(message) },
      },
      { timeoutMs: 1000 },
    );
    await listeners.get('agent/created')({ agent, source: 'startup' });
    assert.equal(requests, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /插件停用/);
  } finally {
    if (previousConfigFile === undefined) delete process.env.COMEM_CONFIG_FILE;
    else process.env.COMEM_CONFIG_FILE = previousConfigFile;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
