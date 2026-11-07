/**
 * 消息游标（架构文档 §15.4 第 2 层）。
 *
 * 核心不变量：**游标只在服务端确认接收后前进**。失败一次就前进，那批消息永远
 * 补不上；重复投递则能被服务端按消息 ID 去重。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { advanceCursor, cursorFilePath, readCursor } from '../lib/cursor.mjs';
import { captureSession } from '../servers/stop.mjs';

function message(index) {
  return {
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ kind: 'text', text: `第 ${index} 条` }],
    createdAt: '2026-11-08T00:00:00.000Z',
  };
}

/** 记录调用的假客户端：`failOn` 命中时抛错。 */
function fakeHttp(options = {}) {
  const calls = [];
  let failOn = options.failOn ?? null;
  return {
    calls,
    setFailOn(value) {
      failOn = value;
    },
    async post(path, body) {
      calls.push({ path, body });
      if (failOn !== null && path.includes(failOn)) {
        throw new Error(`fail ${path}`);
      }
      return { ok: true };
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-cursor-'));
  const config = { tmpDir: dir, userId: 'alice' };
  try {
    return await fn({ dir, config });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('没有记录时游标是 0', async () => {
  await withTempDir(async ({ dir }) => {
    assert.equal(await readCursor('cc-1', { dir }), 0);
  });
});

test('advanceCursor 只前进不后退', async () => {
  await withTempDir(async ({ dir }) => {
    assert.equal(await advanceCursor('cc-1', 5, { dir }), 5);
    assert.equal(await advanceCursor('cc-1', 3, { dir }), 5);
    assert.equal(await readCursor('cc-1', { dir }), 5);
  });
});

test('advanceCursor 拒绝非整数', async () => {
  await withTempDir(async ({ dir }) => {
    await assert.rejects(() => advanceCursor('cc-1', -1, { dir }), /非负整数/);
    await assert.rejects(() => advanceCursor('cc-1', 1.5, { dir }), /非负整数/);
  });
});

test('游标文件是 JSON 对象，按会话分键', async () => {
  await withTempDir(async ({ dir }) => {
    await advanceCursor('cc-1', 2, { dir });
    await advanceCursor('cc-2', 7, { dir });
    const parsed = JSON.parse(await readFile(cursorFilePath(dir), 'utf8'));
    assert.deepEqual(parsed, { 'cc-1': 2, 'cc-2': 7 });
  });
});

test('提交成功后游标前进，重投不再发消息', async () => {
  await withTempDir(async ({ dir, config }) => {
    const http = fakeHttp();
    const event = {
      sessionId: 'cc-1',
      cwd: '/repo',
      eventId: null,
      transcriptPath: null,
      messages: [message(0), message(1)],
    };

    const first = await captureSession(event, { config, http, env: {} });
    assert.equal(first.captured, 2);
    assert.equal(await readCursor('cc-1', { dir }), 2);
    const before = http.calls.length;

    // 同一个 transcript 再投一次：游标之后没有消息，一个请求都不该发。
    const second = await captureSession(event, { config, http, env: {} });
    assert.equal(second.captured, 0);
    assert.equal(http.calls.length, before);
  });
});

test('服务端失败时游标不前进，重投能补上', async () => {
  await withTempDir(async ({ dir, config }) => {
    const http = fakeHttp({ failOn: '/messages' });
    const event = {
      sessionId: 'cc-1',
      cwd: '/repo',
      eventId: null,
      transcriptPath: null,
      messages: [message(0), message(1)],
    };

    await assert.rejects(() => captureSession(event, { config, http, env: {} }));
    // 关键断言：消息没被确认，游标必须停在 0。
    assert.equal(await readCursor('cc-1', { dir }), 0);

    http.setFailOn(null);
    const retry = await captureSession(event, { config, http, env: {} });
    assert.equal(retry.captured, 2);
    assert.equal(await readCursor('cc-1', { dir }), 2);
  });
});

test('transcript 里只取 user / assistant 的文本，跳过工具与子 agent', async () => {
  await withTempDir(async ({ dir, config }) => {
    const transcript = join(dir, 'transcript.jsonl');
    const lines = [
      { uuid: 'u1', type: 'user', message: { role: 'user', content: '怎么配置 TypeScript' } },
      { uuid: 'u2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '用 strict' }] } },
      // 工具调用由 PostToolUse 采集，不在这里重复。
      {
        uuid: 'u3',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
      },
      // 子 agent 的对话属于另一个会话。
      {
        uuid: 'u4',
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: '子 agent 的问题' },
      },
      // 最后半行（宿主边写边追加）。
      { uuid: 'u5', type: 'user', message: { role: 'user', content: '半行' } },
    ];
    await writeFile(
      transcript,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{"uuid":"u6","message":`,
      'utf8',
    );

    const http = fakeHttp();
    const result = await captureSession(
      { sessionId: 'cc-2', cwd: '/repo', eventId: null, transcriptPath: transcript, messages: null },
      { config, http, env: {} },
    );
    // u1 / u2 / u5 是文本；u3 是工具调用（PostToolUse 采集），u4 是子 agent，
    // 最后一行是半截 JSON。
    assert.equal(result.captured, 3);
    const posted = http.calls.find((call) => call.path.endsWith('/messages'));
    assert.deepEqual(
      posted.body.messages.map((message) => message.id),
      ['u1', 'u2', 'u5'],
    );
  });
});

test('bypass 会话时既不提交也不前进游标（§8.9）', async () => {
  await withTempDir(async ({ dir, config }) => {
    const http = fakeHttp();
    const result = await captureSession(
      {
        sessionId: 'cc-1',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0)],
      },
      { config, http, env: { COMEM_BYPASS_SESSION: '1' } },
    );
    assert.equal(result.bypassed, true);
    assert.equal(result.captured, 0);
    assert.equal(await readCursor('cc-1', { dir }), 0);
    assert.equal(http.calls.length, 0);
  });
});

test('会话已存在（409）时继续写消息', async () => {
  await withTempDir(async ({ dir, config }) => {
    const calls = [];
    const http = {
      async post(path, body) {
        calls.push(path);
        if (path === '/api/v1/sessions') {
          const error = new Error('conflict');
          error.status = 409;
          throw error;
        }
        return { ok: true };
      },
    };
    const result = await captureSession(
      {
        sessionId: 'cc-1',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0)],
      },
      { config, http, env: {} },
    );
    assert.equal(result.captured, 1);
    assert.deepEqual(calls, [
      '/api/v1/sessions',
      '/api/v1/sessions/cc-1/messages',
      '/api/v1/sessions/cc-1/commit',
    ]);
    assert.equal(await readCursor('cc-1', { dir }), 1);
  });
});
