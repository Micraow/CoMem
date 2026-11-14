import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
    response.end(JSON.stringify({ status: 'ok', result: request.url === '/api/v1/context' ? { rendered: '背景正文' } : { skills: [] } }));
    if (request.url.endsWith('/messages')) receivedMessages(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listeners = new Map();
  const agent = { id: 'agent-other-id', session: { id: 'session-one', header: {} }, inject: () => {} };
  try {
    apply({ on: (event, listener) => listeners.set(event, listener), logger: { warn: () => {} } }, {
      baseUrl: `http://127.0.0.1:${server.address().port}`, token: '',
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
    assert.equal(await listeners.get('agent/pre-step')({ agent: child, messages: [{ role: 'user' }] }, async () => step), step);
    assert.equal(requests.length, count);
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
