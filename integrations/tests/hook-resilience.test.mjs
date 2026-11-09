/**
 * Hook 在 CoMem 服务异常时不阻塞用户（架构文档 §15.9 的「降级而不是等待」）。
 *
 * 这一份测的是**进程**，不是函数：要证明的性质是「hook 进程会在预算内退出、
 * 退出码 0、stdout 一个字节都不写」。单元测试证明不了进程会不会退出——一个没关
 * 的 stdin、一条 keep-alive socket、一个没清掉的定时器都只在真实进程里显形。
 *
 * 三类必测场景（验收要求）：
 *
 * 1. **慢服务端**：请求永远不响应。断言进程在「事件预算 + 余量」内退出，而且
 *    **不早于**预算——早退说明请求其实没发出去，测的就不是超时路径了。
 * 2. **不可达端口**：快速失败，不能等满预算。
 * 3. **stdin 不关闭**：宿主写了半截不 end（或根本不写）。没有上限时进程永远不
 *    返回；断言它在 `STDIN_READ_CAP_MS` 附近退出。
 *
 * 余量（`EXIT_MARGIN_MS`）覆盖 Node 进程启动、模块加载与退出清理。§15.9 实测的
 * 进程启动是 30–50ms，本机（空载）实测 29–57ms；1200ms 是它的 20 倍以上，够覆盖
 * CI 的负载抖动，又远小于「预算失效」时的秒级差距（慢服务端那种场景不修是 15s）。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runHook } from '../hosts/claude-code.mjs';
import { createHttpClient } from '../lib/http.mjs';
import {
  HOOK_BUDGETS_MS,
  SESSION_END_BUDGET_MS,
  STDIN_READ_CAP_MS,
  budgetForEvent,
  createDeadline,
} from '../lib/lifecycle.mjs';

const SCRIPT = {
  'pre-tool-use': fileURLToPath(new URL('../servers/pre-tool-use.mjs', import.meta.url)),
  'session-start': fileURLToPath(new URL('../servers/session-start.mjs', import.meta.url)),
  'user-prompt-submit': fileURLToPath(
    new URL('../servers/user-prompt-submit.mjs', import.meta.url),
  ),
  'mcp-proxy': fileURLToPath(new URL('../servers/mcp-proxy.mjs', import.meta.url)),
};

/** 预算之外允许的进程启动 / 退出余量。见文件头。 */
const EXIT_MARGIN_MS = 1200;

/** 看门狗：超过它说明进程根本没在跑预算逻辑，杀掉并让断言给出人话。 */
const WATCHDOG_MS = 20_000;

/**
 * 定时器不 ref：睡眠是「模拟服务端慢」，不是被测进程；ref 着会让 `node --test`
 * 等完 30 秒才退出（进程被一个假服务端的定时器留住）。
 */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

/**
 * 假服务端。
 *
 * `handler` 拿到 `(request, response)`；不响应就模拟「服务端卡住」。请求体先读完，
 * 否则子进程可能因为 TCP 背压卡在 `fetch` 的写入上——那测的就不是读超时了。
 */
async function startServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 消费请求体。
    }
    requests.push({ method: request.method, url: request.url });
    await handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // 挂起的请求不会自己结束，`close()` 会一直等连接。
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** 取一个当前没人监听的端口：先绑定再释放。 */
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 跑一次真实 hook 入口，返回退出码、stdout、stderr 与墙钟。
 *
 * 环境变量里先剔掉所有 `COMEM_*`，避免开发机的真实配置（`~/.config/comem/config.yaml`、
 * 已设的 token）影响断言。
 */
function spawnHook(options) {
  const { script, payload, env = {}, args, endStdin = true } = options;
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('COMEM_')) {
      childEnv[key] = value;
    }
  }
  Object.assign(childEnv, env);

  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(
      process.execPath,
      [script, ...(args ?? ['--host', 'claude-code'])],
      { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // 进程先退出时 stdin 会 ESPIPE/EPIPE；不是被测行为。
    });

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      resolve(value);
    };

    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
    }, WATCHDOG_MS);

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      finish({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    });

    if (endStdin) {
      child.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
    }
    // `endStdin: false` 时故意什么都不写、也不 end：模拟宿主把 stdin 挂着。
  });
}

/** 每个用例一个隔离的临时目录（锁、游标、worker 载荷都落在这里）。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-budget-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function envFor(dir, extra = {}) {
  return {
    COMEM_HOOK_TMPDIR: dir,
    // 不读开发机的真实配置；文件不存在不是错误。
    COMEM_CONFIG_FILE: join(dir, 'comem-missing.yaml'),
    COMEM_USER_ID: 'alice',
    ...extra,
  };
}

/** 一个有内容的诊断行（不是空行、不是堆栈）。 */
function diagnosticLines(stderr) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 断言进程真的按 hook 契约退出：退出码 0、没被信号杀掉、stdout 一个字节都没有。 */
function assertCleanExit(result) {
  assert.equal(result.signal, null, `进程被信号 ${String(result.signal)} 杀掉：预算没有生效`);
  assert.equal(result.code, 0, `退出码必须是 0（任何非 0 都可能被宿主当成失败/阻断）：${result.stderr}`);
  assert.equal(result.stdout, '', `错误路径的 stdout 必须为空，实际：${JSON.stringify(result.stdout)}`);
}

// ---------------------------------------------------------------------------
// 预算表与 deadline
// ---------------------------------------------------------------------------

test('预算表覆盖七个内部事件，且都小于宿主的 hook 超时', () => {
  assert.deepEqual(Object.keys(HOOK_BUDGETS_MS).sort(), [
    'post_tool_use',
    'pre_compact',
    'pre_tool_use',
    'session_end',
    'session_start',
    'stop',
    'user_prompt_submit',
  ]);
  for (const [event, budget] of Object.entries(HOOK_BUDGETS_MS)) {
    assert.ok(Number.isInteger(budget) && budget > 0, `${event} 的预算必须是正整数`);
    // 宿主上限：UserPromptSubmit 30s，其余 command hook 600s（Claude Code 官方
    // 默认）。预算超过上限时宿主会先杀掉进程、丢弃输出——那样预算就是空话。
    assert.ok(budget <= 30_000, `${event} 的预算 ${String(budget)}ms 超过了宿主最小上限 30s`);
  }
});

test('SessionEnd 用 1.5s 派生的预算，不跟 PreCompact 共用一个 30s', () => {
  assert.ok(SESSION_END_BUDGET_MS < HOOK_BUDGETS_MS.pre_compact);
  // Claude Code 给 SessionEnd 一组 hook 1.5 秒共享预算，留 300ms 给进程启动与退出。
  assert.ok(SESSION_END_BUDGET_MS + 300 <= 1500);
  // 两个生命周期点走同一个处理器，但预算各查各的键。
  assert.equal(budgetForEvent({ event: 'session_end' }), SESSION_END_BUDGET_MS);
  assert.equal(budgetForEvent({ event: 'pre_compact' }), HOOK_BUDGETS_MS.pre_compact);
  assert.equal(budgetForEvent({ event: 'user_prompt_submit' }), HOOK_BUDGETS_MS.user_prompt_submit);
});

test('deadline 从进程启动算起，不是从现在算起', () => {
  const budgetMs = 500;
  const deadline = createDeadline(budgetMs);
  const expected = Math.round(performance.timeOrigin) + budgetMs;
  // `timeOrigin` 带小数，`AbortSignal.timeout` 又只收整数：允许 ±2ms。
  assert.ok(Math.abs(deadline.expiresAt - expected) <= 2, `expiresAt=${deadline.expiresAt}`);
  assert.ok(deadline.expiresAt <= Date.now() + budgetMs);
});

test('总预算在多个请求之间共享：第二个请求被 deadline 截断，而不是各自重算', async () => {
  // 每个请求慢 300ms。各请求独立超时 → 两次 600ms；共享 400ms 预算 → 两次一共 400ms。
  const server = await startServer(async (request, response) => {
    await sleep(300);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: null }));
  });
  try {
    // 手工构造 deadline：`createDeadline` 从**进程启动**算起，本测试进程早就启动过了。
    // 形状就是 `lib/http.mjs` 与 `createDeadline` 约定的那一个。
    const budgetMs = 400;
    const expiresAt = Date.now() + budgetMs;
    const deadline = {
      budgetMs,
      expiresAt,
      signal: AbortSignal.timeout(budgetMs),
      remainingMs: () => Math.max(0, expiresAt - Date.now()),
      expired: () => Date.now() >= expiresAt,
    };
    const client = createHttpClient({
      baseUrl: server.baseUrl,
      deadline,
      timeoutMs: 5000,
      retries: 0,
    });

    const startedAt = Date.now();
    await client.post('/first', {});
    await assert.rejects(
      () => client.post('/second', {}),
      (error) => {
        assert.equal(error.code, 'HOOK_BUDGET_EXCEEDED');
        return true;
      },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < budgetMs + 200,
      `两次请求共 ${String(elapsedMs)}ms；共享预算应在约 ${String(budgetMs)}ms 处截断，` +
        '各请求独立超时会拖到 600ms',
    );

    // 预算用尽后不再开新请求（服务端计数不变）。
    const before = server.requests.length;
    await assert.rejects(() => client.post('/third', {}), /总预算/);
    assert.equal(server.requests.length, before);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 进程级：慢服务端 / 不可达 / stdin 不关闭
// ---------------------------------------------------------------------------

test(
  '慢服务端：UserPromptSubmit 在预算 + 余量内以 0 退出，stdout 为空，stderr 一行诊断',
  { timeout: 30_000 },
  async () => {
    const budgetMs = HOOK_BUDGETS_MS.user_prompt_submit;
    const server = await startServer(async () => {
      // 睡 30s，远大于 2s 的预算：模拟服务端卡死（不是 5xx，不是立刻断开）。
      // 没有总预算时这个 hook 会等满 `timeoutMs`（5s）。
      await sleep(30_000);
    });
    try {
      await withTempDir(async (dir) => {
        const result = await spawnHook({
          script: SCRIPT['user-prompt-submit'],
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: 's1',
            cwd: dir,
            prompt: 'typescript strict 怎么配',
          },
          env: envFor(dir, { COMEM_BASE_URL: server.baseUrl }),
        });

        assertCleanExit(result);
        const lines = diagnosticLines(result.stderr);
        assert.equal(lines.length, 1, `stderr 应只有一行诊断，实际：${result.stderr}`);
        assert.match(lines[0], /HOOK_BUDGET_EXCEEDED|HOOK_TIMEOUT/);
        assert.ok(
          result.elapsedMs >= budgetMs - 150,
          `只用了 ${result.elapsedMs.toFixed(0)}ms，早于预算 ${String(budgetMs)}ms：` +
            '请求可能根本没发出去，这条用例就没证明超时路径',
        );
        assert.ok(
          result.elapsedMs <= budgetMs + EXIT_MARGIN_MS,
          `用了 ${result.elapsedMs.toFixed(0)}ms，超过预算 ${String(budgetMs)}ms + 余量：` +
            '总预算没有传导到子请求',
        );
      });
    } finally {
      await server.close();
    }
  },
);

test(
  '慢服务端：SessionStart 的三次 GET 共享一个预算，不是 3 × 5s（含 GET 重试）',
  { timeout: 30_000 },
  async () => {
    const budgetMs = HOOK_BUDGETS_MS.session_start;
    const server = await startServer(() => {
      // 永不响应；GET 还有 2 次重试，没有总预算时最坏 3 × 3 × 5s。
    });
    try {
      await withTempDir(async (dir) => {
        const result = await spawnHook({
          script: SCRIPT['session-start'],
          payload: { hook_event_name: 'SessionStart', session_id: 's1', cwd: dir },
          env: envFor(dir, { COMEM_BASE_URL: server.baseUrl }),
        });

        assertCleanExit(result);
        assert.ok(diagnosticLines(result.stderr).length >= 1, '降级要留一行诊断');
        assert.ok(
          result.elapsedMs >= budgetMs - 150,
          `只用了 ${result.elapsedMs.toFixed(0)}ms，早于预算`,
        );
        assert.ok(
          result.elapsedMs <= budgetMs + EXIT_MARGIN_MS,
          `用了 ${result.elapsedMs.toFixed(0)}ms，超过预算 ${String(budgetMs)}ms + 余量`,
        );
      });
    } finally {
      await server.close();
    }
  },
);

test(
  '不可达端口：快速失败、退出码 0、stdout 为空',
  { timeout: 30_000 },
  async () => {
    const port = await unusedPort();
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['user-prompt-submit'],
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 's1',
          cwd: dir,
          prompt: 'co mem 的检索接口',
        },
        env: envFor(dir, { COMEM_BASE_URL: `http://127.0.0.1:${port}` }),
      });

      assertCleanExit(result);
      assert.ok(diagnosticLines(result.stderr).length >= 1, '不可达也要留一行诊断');
      // 连不上必须立刻失败：等到预算才报错说明它在傻等。本机实测 55–70ms，
      // 1000ms 留了 15 倍余量，又明显小于 2000ms 的预算。
      assert.ok(
        result.elapsedMs < 1000,
        `用了 ${result.elapsedMs.toFixed(0)}ms，不可达端口不该等满预算`,
      );
    });
  },
);

test(
  'stdin 不关闭：进程在 STDIN_READ_CAP_MS 附近退出，退出码 0，stdout 为空',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['pre-tool-use'],
        endStdin: false,
        env: envFor(dir),
      });

      assertCleanExit(result);
      assert.match(result.stderr, /stdin/i);
      // 没有上限时这里会挂到看门狗（20s）。下限证明「是上限让它退出的」。
      assert.ok(
        result.elapsedMs >= STDIN_READ_CAP_MS - 150,
        `只用了 ${result.elapsedMs.toFixed(0)}ms，早于 stdin 上限，说明退出另有原因`,
      );
      assert.ok(
        result.elapsedMs <= STDIN_READ_CAP_MS + EXIT_MARGIN_MS,
        `用了 ${result.elapsedMs.toFixed(0)}ms，超过 stdin 上限 ${String(STDIN_READ_CAP_MS)}ms + 余量`,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// 硬上限：handler 违背约定（永不返回）也要退出
// ---------------------------------------------------------------------------

test(
  'handler 永不返回：预算用尽后仍有硬上限，进程退出码 0、stdout 为空',
  { timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hostUrl = pathToFileURL(join(root, 'hosts', 'claude-code.mjs')).href;
    const budgetMs = HOOK_BUDGETS_MS.pre_tool_use;
    // 故意挂一个真的句柄（定时器）：否则事件循环是空的，Node 会因为「没有待办」
    // 自然退出，测不到硬上限。等价于一条没关的 socket。
    const script = `
      import { runHook } from ${JSON.stringify(hostUrl)};
      setInterval(() => {}, 1000);
      await runHook(() => new Promise(() => undefined), {
        read: async () => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/repo' }),
        hardExit: true,
      });
    `;

    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const result = await new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('handler 永不返回时进程没有退出：硬上限没生效'));
      }, WATCHDOG_MS);
      child.on('exit', (code, signal) => {
        clearTimeout(watchdog);
        resolve({
          code,
          signal,
          stdout,
          stderr,
          elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        });
      });
    });

    assert.equal(result.signal, null, `被信号 ${String(result.signal)} 杀掉`);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(
      result.elapsedMs >= budgetMs - 150,
      `只用了 ${result.elapsedMs.toFixed(0)}ms，早于预算`,
    );
    assert.ok(
      result.elapsedMs <= budgetMs + EXIT_MARGIN_MS,
      `用了 ${result.elapsedMs.toFixed(0)}ms，超过预算 + 宽限期`,
    );
  },
);

// ---------------------------------------------------------------------------
// stdio MCP 代理：后端不可达时快速报错，不重连
// ---------------------------------------------------------------------------

test(
  'mcp-proxy：后端不可达时立刻回 JSON-RPC 错误，不重试、不挂起',
  { timeout: 30_000 },
  async () => {
    const port = await unusedPort();
    await withTempDir(async (dir) => {
      const childEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('COMEM_')) {
          childEnv[key] = value;
        }
      }
      Object.assign(childEnv, envFor(dir, { COMEM_BASE_URL: `http://127.0.0.1:${port}` }));

      const child = spawn(process.execPath, [SCRIPT['mcp-proxy']], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`,
        );

        const requestStartedAt = Date.now();
        const { firstLine, receivedAfterMs } = await new Promise((resolve, reject) => {
          let buffer = '';
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('代理没有在后端不可达时返回错误：它在挂起或无限重试'));
          }, 6000);
          child.stdout.on('data', (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline >= 0) {
              clearTimeout(timer);
              resolve({
                firstLine: buffer.slice(0, newline),
                receivedAfterMs: Date.now() - requestStartedAt,
              });
            }
          });
        });

        const message = JSON.parse(firstLine);
        assert.equal(message.id, 1);
        // -32005 = 连不上（`servers/mcp-proxy.mjs` 的 UNREACHABLE）。
        assert.equal(message.error.code, -32005);
        assert.match(message.error.message, /连不上/);
        assert.ok(
          receivedAfterMs < 1000,
          `代理用了 ${String(receivedAfterMs)}ms 才报错：不可达必须快速失败`,
        );

        // 不许有第二次尝试：再等一会儿，stdout 不该多出行。
        let extra = '';
        child.stdout.on('data', (chunk) => {
          extra += chunk;
        });
        await sleep(400);
        assert.equal(extra, '', `代理重试了：${extra}`);
      } finally {
        // 代理是常驻 stdio 服务器：测完主动关掉。已经退出时不要再等一次 exit。
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise((resolve) => child.on('exit', resolve));
        }
      }
    });
  },
);

// ---------------------------------------------------------------------------
// PreToolUse：任何错误路径都是放行
// ---------------------------------------------------------------------------

test(
  'PreToolUse：后端不可达时普通路径照常放行（stdout 空、退出码 0）',
  { timeout: 30_000 },
  async () => {
    const port = await unusedPort();
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['pre-tool-use'],
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: 's1',
          cwd: dir,
          tool_name: 'Read',
          tool_use_id: 't1',
          tool_input: { file_path: join(dir, 'notes.md') },
        },
        env: envFor(dir, { COMEM_BASE_URL: `http://127.0.0.1:${port}` }),
      });

      assertCleanExit(result);
    });
  },
);

test(
  'PreToolUse：comem:// 的判定不依赖后端，后端不可达时仍然只按本地规则 deny',
  { timeout: 30_000 },
  async () => {
    const port = await unusedPort();
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['pre-tool-use'],
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: 's1',
          cwd: dir,
          tool_name: 'Read',
          tool_use_id: 't2',
          tool_input: { file_path: 'comem://user/alice/memories/profile.md' },
        },
        env: envFor(dir, { COMEM_BASE_URL: `http://127.0.0.1:${port}` }),
      });

      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /MCP 工具 read/);
    });
  },
);

test(
  'PreToolUse：载荷坏掉时放行（stdout 空、退出码 0、stderr 一行）',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['pre-tool-use'],
        payload: undefined,
        env: envFor(dir),
      });

      assertCleanExit(result);
      assert.equal(diagnosticLines(result.stderr).length, 1);
    });
  },
);

test(
  'PreToolUse：异常路径绝不 deny——handler 抛错时不写 stdout',
  async () => {
    // 先注入 stderr，避免这条用例往测试输出里打一行真诊断。
    const original = process.stderr.write;
    const stderr = [];
    process.stderr.write = (chunk, callback) => {
      stderr.push(String(chunk));
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    };
    try {
      const lines = [];
      const event = await runHook(
        () => {
          throw new Error('后端炸了');
        },
        {
          read: async () => ({
            hook_event_name: 'PreToolUse',
            session_id: 's1',
            cwd: '/repo',
            tool_name: 'Read',
            tool_input: { file_path: 'comem://user/alice/a.md' },
          }),
          write: (line) => lines.push(line),
        },
      );
      assert.equal(event.event, 'pre_tool_use');
      assert.deepEqual(lines, [], '异常路径不能写出 deny 信封');
      assert.match(stderr.join(''), /后端炸了/);
    } finally {
      process.stderr.write = original;
    }
  },
);

test(
  '入口级失败（--host 非法）也退出 0：不是 1，更不是 2',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const result = await spawnHook({
        script: SCRIPT['pre-tool-use'],
        args: ['--host', '../evil'],
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: 's1',
          cwd: dir,
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/a.md' },
        },
        env: envFor(dir),
      });

      assertCleanExit(result);
      assert.equal(diagnosticLines(result.stderr).length, 1);
      assert.match(result.stderr, /宿主名不合法/);
    });
  },
);
