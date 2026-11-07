/**
 * `PostToolUse`：采集工具调用与结果（架构文档 §15.2、§10.1）。
 *
 * 一次工具调用是一条 `tool` 消息，`tool_use` 与 `tool_result` 两个 part 都在
 * 里面。宿主重投同一个 `tool_use_id` 时不再写第二条。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileEventDeduper } from '../lib/dedup.mjs';
import { handlePostToolUse, toToolMessage } from '../servers/post-tool-use.mjs';

function fakeHttp() {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      if (path === '/api/v1/sessions') {
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      return { ok: true };
    },
  };
}

function event(overrides = {}) {
  return {
    sessionId: 'cc-1',
    cwd: '/repo',
    toolName: 'Read',
    toolUseId: 'tool-1',
    toolInput: { file_path: '/repo/a.ts' },
    toolOutput: 'file contents',
    ...overrides,
  };
}

test('工具调用与结果合成一条 tool 消息', () => {
  const message = toToolMessage(event());
  assert.equal(message.role, 'tool');
  assert.equal(message.id, 'tool_tool-1');
  assert.equal(message.parts.length, 2);
  assert.equal(message.parts[0].kind, 'tool_use');
  assert.equal(message.parts[0].name, 'Read');
  assert.equal(message.parts[1].kind, 'tool_result');
  assert.equal(message.parts[1].output, 'file contents');
  assert.equal(message.parts[1].toolUseId, 'tool-1');
});

test('消息 id 由 tool_use_id 派生（重投时稳定）', () => {
  assert.equal(toToolMessage(event()).id, toToolMessage(event()).id);
  assert.notEqual(toToolMessage(event()).id, toToolMessage(event({ toolUseId: 'tool-2' })).id);
});

test('写入消息前先确保会话存在', async () => {
  const http = fakeHttp();
  const result = await handlePostToolUse(event(), {
    config: { tmpDir: '/tmp', userId: 'alice' },
    http,
    env: {},
  });
  assert.equal(result, undefined);
  // 上报开销也走同一个客户端，断言只看采集路径。
  assert.deepEqual(
    http.calls.map((call) => call.path).filter((path) => !path.includes('/telemetry/')),
    ['/api/v1/sessions', '/api/v1/sessions/cc-1/messages'],
  );
  assert.equal(http.calls[1].body.messages.length, 1);
});

test('同一个 tool_use_id 重投时只写一条消息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-post-tool-'));
  try {
    const deduper = new FileEventDeduper(join(dir, 'comem-events.json'));
    const http = fakeHttp();
    const deps = { config: { tmpDir: dir, userId: 'alice' }, http, env: {} };

    // 模拟宿主把同一个事件投两次：第二次在窗口内，必须被去重挡掉。
    const first = await deduper.accept('PostToolUse:tool-1');
    assert.equal(first, true);
    const second = await deduper.accept('PostToolUse:tool-1');
    assert.equal(second, false);

    await handlePostToolUse(event(), deps);
    const captured = http.calls.filter((call) => !call.path.includes('/telemetry/'));
    assert.equal(captured.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bypass 会话时不采集', async () => {
  const http = fakeHttp();
  await handlePostToolUse(event(), {
    config: { tmpDir: '/tmp', userId: 'alice' },
    http,
    env: { COMEM_BYPASS_SESSION: '1' },
  });
  assert.equal(http.calls.length, 0);
});
