/**
 * `PreCompact` / `SessionEnd`：**等**提交完成（架构文档 §15.2、§15.3）。
 *
 * 与 `Stop` 的差别只有「等不等」：这两个时机之后对话就没了，后台 worker 会被
 * 宿主杀掉。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileEventDeduper } from '../lib/dedup.mjs';
import { handlePreCompact } from '../servers/pre-compact.mjs';

function message(index) {
  return {
    id: `msg-${index}`,
    role: 'user',
    parts: [{ kind: 'text', text: `第 ${index} 条` }],
    createdAt: '2026-11-08T00:00:00.000Z',
  };
}

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

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-precompact-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('等提交完成：消息写入 + 触发提交都在返回之前', async () => {
  await withTempDir(async (dir) => {
    const http = fakeHttp();
    const result = await handlePreCompact(
      {
        sessionId: 'cc-1',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0), message(1)],
      },
      {
        config: { tmpDir: dir, userId: 'alice' },
        http,
        env: {},
        deduper: new FileEventDeduper(join(dir, 'comem-events.json')),
      },
    );

    assert.match(result.message, /已提交 2 条消息/);
    assert.deepEqual(
      http.calls.map((call) => call.path).filter((path) => !path.includes('/telemetry/')),
      ['/api/v1/sessions', '/api/v1/sessions/cc-1/messages', '/api/v1/sessions/cc-1/commit'],
    );
  });
});

test('没有待处理消息时不提交（空归档会产出一个空任务）', async () => {
  await withTempDir(async (dir) => {
    const http = fakeHttp();
    const result = await handlePreCompact(
      { sessionId: 'cc-1', cwd: '/repo', eventId: null, transcriptPath: null, messages: [] },
      {
        config: { tmpDir: dir, userId: 'alice' },
        http,
        env: {},
        deduper: new FileEventDeduper(join(dir, 'comem-events.json')),
      },
    );
    assert.equal(result, undefined);
    assert.equal(http.calls.filter((call) => call.path.endsWith('/commit')).length, 0);
  });
});

test('同一个 eventId 在窗口内只提交一次', async () => {
  await withTempDir(async (dir) => {
    const http = fakeHttp();
    const deduper = new FileEventDeduper(join(dir, 'comem-events.json'));
    const event = {
      sessionId: 'cc-1',
      cwd: '/repo',
      eventId: 'SessionEnd:1',
      transcriptPath: null,
      messages: [message(0)],
    };
    const deps = { config: { tmpDir: dir, userId: 'alice' }, http, env: {}, deduper };

    assert.match((await handlePreCompact(event, deps)).message, /已提交 1 条/);
    const callsAfterFirst = http.calls.length;
    assert.equal(await handlePreCompact(event, deps), undefined);
    assert.equal(http.calls.length, callsAfterFirst);
  });
});

test('bypass 会话时不提交（§8.9）', async () => {
  await withTempDir(async (dir) => {
    const http = fakeHttp();
    const result = await handlePreCompact(
      {
        sessionId: 'cc-1',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0)],
      },
      {
        config: { tmpDir: dir, userId: 'alice' },
        http,
        env: { COMEM_BYPASS_SESSION: '1' },
        deduper: new FileEventDeduper(join(dir, 'comem-events.json')),
      },
    );
    assert.equal(result, undefined);
    assert.equal(http.calls.length, 0);
  });
});

test('服务端失败时不抛错（不能把上下文压缩变成红色错误），游标不前进', async () => {
  await withTempDir(async (dir) => {
    const http = {
      async post() {
        throw new Error('boom');
      },
    };
    const result = await handlePreCompact(
      {
        sessionId: 'cc-1',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0)],
      },
      {
        config: { tmpDir: dir, userId: 'alice' },
        http,
        env: {},
        deduper: new FileEventDeduper(join(dir, 'comem-events.json')),
      },
    );
    assert.equal(result, undefined);
  });
});
