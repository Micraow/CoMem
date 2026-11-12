/**
 * 本地推理端点的验收（架构文档 §14、§18.2）。
 *
 * 只测三件事：探测的形状、缺依赖时 400、真实 spawn 一个假的推理进程后 start 能等到
 * 就绪、stop 能把它收掉。假的 Python shim 走的是同一条 `nice taskset .venv/bin/python`
 * 命令，所以测的是真实的 spawn / pid / 健康轮询路径，不是替身分支。
 *
 * 不连仓库里的 `local-inference/`：`repoRoot` 指向临时目录，测试不会启动真的模型。
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { toErrorEnvelope } from '../../../src/api/http/error-mapper.js';
import {
  createIdentityMiddleware,
  createRequestIdMiddleware,
} from '../../../src/api/http/middleware.js';
import { createInferenceRoutes } from '../../../src/api/http/routes/inference.js';
import {
  LocalInferenceManager,
  type LocalInferenceManagerOptions,
} from '../../../src/adapters/local-inference/manager.js';

let root = '';
let dataDir = '';
let manager: LocalInferenceManager | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  if (manager !== null) {
    await manager.stop();
  }
  if (app !== null) {
    await app.close();
  }
  if (root !== '') {
    rmSync(root, { recursive: true, force: true });
  }
  manager = null;
  app = null;
  root = '';
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('没有拿到端口。'));
        return;
      }
      server.close(() => {
        resolve(address.port);
      });
    });
  });
}

/** 一个只回 /health 的假推理服务；`.venv/bin/python` 是它的 shell 启动器。 */
function writeFakeInference(port: number): void {
  const directory = join(root, 'local-inference');
  const bin = join(directory, '.venv', 'bin');
  mkdirSync(join(directory, 'models'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(directory, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), '');
  writeFileSync(join(directory, 'server.py'), '');

  const serverPath = join(root, 'fake-health.mjs');
  writeFileSync(
    serverPath,
    [
      "import { createServer } from 'node:http';",
      "const server = createServer((request, response) => {",
      "  if (request.url === '/health') {",
      "    response.writeHead(200, { 'content-type': 'application/json' });",
      '    response.end(JSON.stringify({',
      "      status: 'ok', backend: 'fake', device: 'cpu',",
      "      model: 'Qwen3-Embedding-0.6B', dimension: 1024, ready: true,",
      '    }));',
      '    return;',
      '  }',
      '  response.writeHead(404);',
      '  response.end();',
      '});',
      `server.listen(${String(port)}, '127.0.0.1');`,
      // 直接退出：keep-alive 的探测连接会让 server.close() 等下去。
      "process.on('SIGTERM', () => process.exit(0));",
      "process.on('SIGINT', () => process.exit(0));",
      '',
    ].join('\n'),
    'utf8',
  );
  const python = join(bin, 'python');
  // 末尾保留 `server.py`：生产命令的 cmdline 里有它，pid 文件靠这个片段确认
  // 进程没有被复用。假的 shim 也保留，才能走到真实的 stop 分支。
  writeFileSync(
    python,
    `#!/bin/sh\nexec node ${serverPath} ${String(port)} server.py\n`,
    'utf8',
  );
  chmodSync(python, 0o755);
}

async function createApp(next: LocalInferenceManager): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  server.addHook('onRequest', createRequestIdMiddleware());
  server.addHook(
    'onRequest',
    createIdentityMiddleware(async () => ({ subject: 'user:local', principals: ['user:local'] })),
  );
  server.setErrorHandler((error, _request, reply) => {
    const mapped = toErrorEnvelope(error);
    reply.code(mapped.statusCode).send(mapped.body);
  });
  await server.register(createInferenceRoutes({
    systemAdmin: { adminUserIds: ['local'], isBootstrapAdmin: () => false },
    localInference: next,
  }).register, { prefix: '/api/v1/inference' });
  await server.ready();
  return server;
}

function managerOf(options: Partial<LocalInferenceManagerOptions> = {}): LocalInferenceManager {
  manager = new LocalInferenceManager({
    dataDir,
    repoRoot: root,
    baseUrl: '',
    startTimeoutMs: 5_000,
    ...options,
  });
  return manager;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('error');
  return body['error'] as Record<string, unknown>;
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`进程 ${String(pid)} 没有退出。`);
}

function newRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'comem-local-inference-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
}

describe('GET /api/v1/inference/local', () => {
  it('本机没有 local-inference 时回 available:false 与缺失项', async () => {
    newRoot();
    app = await createApp(managerOf());

    const response = await app.inject({ method: 'GET', url: '/api/v1/inference/local' });
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);

    expect(result).toMatchObject({
      available: false,
      running: false,
      endpoint: 'http://127.0.0.1:8089',
      dimension: null,
      backend: null,
      device: null,
      model: null,
      missing: ['venv', 'server', 'embedding-model', 'rerank-model'],
    });
    expect(String(result['startCommand'])).toContain('cd local-inference');
  });
});

describe('POST /api/v1/inference/local/start', () => {
  it('缺依赖时回 400 与 missing', async () => {
    newRoot();
    app = await createApp(managerOf());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inference/local/start',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const error = errorOf(response);
    expect(error['code']).toBe('INVALID_ARGUMENT');
    expect(error['details']).toMatchObject({
      missing: ['venv', 'server', 'embedding-model', 'rerank-model'],
    });
  });

  it('启动假服务后等到就绪，stop 收掉同一个 pid', async () => {
    newRoot();
    const port = await freePort();
    writeFakeInference(port);
    app = await createApp(managerOf({ baseUrl: `http://127.0.0.1:${String(port)}/v1` }));

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/inference/local/start',
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(resultOf(started)).toEqual({
      started: true,
      ready: true,
      endpoint: `http://127.0.0.1:${String(port)}`,
      dimension: 1024,
    });

    const status = resultOf(
      await app.inject({ method: 'GET', url: '/api/v1/inference/local' }),
    );
    expect(status).toMatchObject({
      available: true,
      running: true,
      dimension: 1024,
      backend: 'fake',
      device: 'cpu',
      model: 'Qwen3-Embedding-0.6B',
      missing: ['rerank-model'],
      startCommand: null,
    });

    const pidPath = join(dataDir, '_meta', 'local-inference.pid');
    const pid = Number(readFileSync(pidPath, 'utf8'));
    expect(pid).toBeGreaterThan(0);

    const stopped = await app.inject({
      method: 'POST',
      url: '/api/v1/inference/local/stop',
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(resultOf(stopped)).toEqual({ stopped: true });
    await waitUntilGone(pid);
    expect(existsSync(pidPath)).toBe(false);
  });
});
