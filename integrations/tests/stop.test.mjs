/**
 * `Stop` 立刻返回（架构文档 §15.3）。
 *
 * 两条硬要求：
 * 1. **不等采集完成就退出**。采集与提交挂在后台 worker 里，用户按下停止键不能
 *    等一次 LLM 抽取。
 * 2. worker 必须是**分离**进程并被 `unref()`——否则主进程的事件循环会被它挂住。
 *
 * ## 为什么第 1 条不能量墙钟
 *
 * 墙钟里包含进程启动（§15.9 明确写 30–50ms）、模块加载、HTTP 往返。这些和
 * 「等不等待采集」没有因果关系：空载 45ms、负载 3–4 时 56ms 是同一份实现。
 * 拿墙钟当断言，测的是机器负载，不是 hook 的行为。
 *
 * 这里改成**因果断言**：假服务端的采集端点收到请求后永不响应（worker 自己的
 * 超时是 60 秒），Stop 若等待采集就永远退不出来。退出预算 2 秒相对「无限」有
 * 两个数量级的余量，只有「真的等了」才会失败。
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

/**
 * 假服务端：记录请求，永远返回成功封套。
 *
 * `hangCapture` 为真时，`/messages`（采集端点）收到请求后**不响应**——连接一直
 * 挂着，模拟一次很慢的采集。`captureStarted` 在该请求到达时 resolve，用来证明
 * worker 真的去采集了，而不是 Stop 提前退出。
 *
 * @param {{ hangCapture?: boolean }} [options]
 */
async function startServer(options = {}) {
  const requests = [];
  let notifyCaptureStarted;
  const captureStarted = new Promise((resolve) => {
    notifyCaptureStarted = resolve;
  });
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
    if (options.hangCapture === true && request.url?.endsWith('/messages')) {
      notifyCaptureStarted();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    requests,
    captureStarted,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        // 挂起的请求不会自己结束，`close()` 会一直等连接。先断开再关。
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/**
 * 跑一次 `Stop` 主进程，返回退出码与耗时。
 *
 * `timeoutMs` 是看门狗：Stop 若等待采集，就不该退出。杀掉它并给出可读的失败
 * 原因，比让 `node --test` 报一个笼统的超时更容易定位。
 */
function runStop(env, payload, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      callback(value);
    };
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      settle(
        reject,
        new Error(`Stop 进程 ${String(timeoutMs)}ms 内没有退出：它在等待采集完成。`),
      );
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => settle(reject, error));
    child.on('exit', (code) => {
      settle(resolve, {
        code,
        stderr,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 采集请求挂起时 Stop 的退出预算。见文件头：相对「无限」的两个数量级。 */
const STOP_EXIT_BUDGET_MS = 2_000;

/** 等 worker 发出采集请求的上限。进程启动 30–50ms，这里留了 100 倍余量。 */
const CAPTURE_START_BUDGET_MS = 10_000;

/** 等 `promise` 完成；超时抛错。定时器必须清掉，否则会拖住测试进程。 */
async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('Stop 不等待采集：采集请求挂起时仍然退出', async () => {
  const server = await startServer({ hangCapture: true });
  const dir = await mkdtemp(join(tmpdir(), 'comem-stop-'));
  try {
    // 有消息才会有采集请求；没有消息时 Stop 走「无需提交」的早退路径，测不到
    // 「等不等采集」。
    const transcript = join(dir, 'transcript.jsonl');
    await writeFile(
      transcript,
      `${JSON.stringify({ uuid: 'u1', message: { role: 'user', content: '你好' } })}\n`,
      'utf8',
    );

    const result = await runStop(
      {
        COMEM_BASE_URL: server.baseUrl,
        COMEM_USER_ID: 'alice',
        COMEM_HOOK_TMPDIR: dir,
        COMEM_HOST: 'claude-code',
        // 让 worker 的请求挂得比断言窗口久：Stop 退不退出不取决于它。
        COMEM_TIMEOUT_MS: '60000',
      },
      {
        hook_event_name: 'Stop',
        session_id: 's1',
        cwd: dir,
        transcript_path: transcript,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    // worker 真的发出了采集请求，且此刻它还挂在服务端——Stop 是在「采集未完成」
    // 的状态下退出的。这一步失败说明 Stop 根本没起 worker（另一条性质）。
    await withTimeout(
      server.captureStarted,
      CAPTURE_START_BUDGET_MS,
      `${String(CAPTURE_START_BUDGET_MS)}ms 内没有等到采集请求`,
    );
    assert.ok(
      result.elapsedMs < STOP_EXIT_BUDGET_MS,
      `Stop 耗时 ${result.elapsedMs.toFixed(1)}ms；采集请求挂起时它必须在 ` +
        `${String(STOP_EXIT_BUDGET_MS)}ms 内退出（§15.3）`,
    );
    // 数字进 CI 日志：失败时先看实际耗时，不用重跑。
    console.log(`[stop] Stop 主进程耗时：${result.elapsedMs.toFixed(1)}ms（采集请求挂起中）`);
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
