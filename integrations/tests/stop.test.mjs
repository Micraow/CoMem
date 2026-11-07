/**
 * `Stop` 立刻返回（架构文档 §15.3）。
 *
 * 两条硬要求：
 * 1. 进程总耗时 < 50ms（§15.9 的 hook 进程启动预算）。采集与提交不能拖住用户。
 * 2. worker 必须是**分离**进程并被 `unref()`——否则主进程的事件循环会被它挂住。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { spawnCaptureWorker, writeWorkerPayload } from '../servers/stop.mjs';

const SERVER_SCRIPT = fileURLToPath(new URL('../servers/stop.mjs', import.meta.url));

/** 假服务端：记录请求，永远返回成功封套。 */
async function startServer() {
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
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runStop(env, payload) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    // 只收 stderr：stdout 是宿主信封，这里不关心；`exit` 比 `close` 早，
    // 不把 stdio 关闭时间算进 hook 预算。
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code,
        stderr,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('Stop 主进程耗时 < 50ms，且不等待采集', async () => {
  const server = await startServer();
  const dir = await mkdtemp(join(tmpdir(), 'comem-stop-'));
  try {
    const result = await runStop(
      {
        COMEM_BASE_URL: server.baseUrl,
        COMEM_USER_ID: 'alice',
        COMEM_HOOK_TMPDIR: dir,
        COMEM_HOST: 'claude-code',
      },
      {
        hook_event_name: 'Stop',
        session_id: 's1',
        cwd: dir,
        transcript_path: join(dir, 'missing.jsonl'),
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.elapsedMs < 50,
      `Stop 耗时 ${result.elapsedMs.toFixed(1)}ms，超过 50ms 预算（§15.9）`,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker 以 detached + stdio:ignore 启动，并且被 unref', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-stop-'));
  try {
    const payloadFile = await writeWorkerPayload(dir, {
      event: {
        sessionId: 'cc-1',
        cwd: dir,
        eventId: null,
        transcriptPath: null,
        messages: [],
      },
      processStartMs: 1,
    });

    const calls = [];
    let unrefCalled = false;
    const fakeChild = {
      unref() {
        unrefCalled = true;
      },
    };
    const fakeSpawn = (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild;
    };

    spawnCaptureWorker(payloadFile, { spawnImpl: fakeSpawn, scriptPath: SERVER_SCRIPT });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].args, [SERVER_SCRIPT]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].options.env['COMEM_WORKER'], '1');
    assert.equal(calls[0].options.env['COMEM_WORKER_PAYLOAD'], payloadFile);
    assert.equal(unrefCalled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker 真正跑起来时会把消息写进服务端并清掉载荷', async () => {
  const server = await startServer();
  const dir = await mkdtemp(join(tmpdir(), 'comem-stop-'));
  try {
    const transcript = join(dir, 'transcript.jsonl');
    await writeFile(
      transcript,
      `${JSON.stringify({ uuid: 'u1', message: { role: 'user', content: '你好' } })}\n`,
      'utf8',
    );

    const payloadFile = await writeWorkerPayload(dir, {
      event: {
        sessionId: 'cc-1',
        cwd: dir,
        eventId: null,
        transcriptPath: transcript,
        messages: null,
      },
      processStartMs: 1,
    });

    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env: {
        ...process.env,
        COMEM_BASE_URL: server.baseUrl,
        COMEM_USER_ID: 'alice',
        COMEM_HOOK_TMPDIR: dir,
        COMEM_WORKER: '1',
        COMEM_WORKER_PAYLOAD: payloadFile,
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    await new Promise((resolve) => child.on('close', resolve));

    const messages = server.requests.find((request) => request.url?.endsWith('/messages'));
    assert.equal(messages.body.messages.length, 1);
    assert.equal(messages.body.messages[0].id, 'u1');
    assert.equal(server.requests.some((request) => request.url?.endsWith('/commit')), true);

    const cursor = JSON.parse(await readFile(join(dir, 'comem-cursors.json'), 'utf8'));
    assert.deepEqual(cursor, { 'cc-1': 1 });
    await assert.rejects(() => readFile(payloadFile, 'utf8'), /ENOENT/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
