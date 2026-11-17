#!/usr/bin/env node
// `pnpm dev`：同时起后端与控制台，并让两边同生共死。
//
// POSIX 上各自创建进程组，退出时杀掉整组；Windows 上由 taskkill /T 收尾。
// 后端端口从配置和原 argv 读取，控制台端口读 COMEM_WEB_PORT（默认 3081）。

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const WINDOWS = process.platform === 'win32';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function portOf(raw, label) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} 不是合法端口：${String(raw)}`);
  }
  return port;
}

function backendPortFromConfig() {
  const source = [
    "import { loadConfig } from './src/config/index.ts';",
    'process.stdout.write(String(loadConfig({ argv: process.argv.slice(1) }).server.port));',
  ].join(' ');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source, '--', ...ARGS],
    { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`读取后端配置失败（exit ${String(result.status)}）。`);
  return portOf(result.stdout.trim(), '后端端口');
}

function isAvailable(port) {
  return new Promise((resolveAvailable) => {
    const probe = createServer();
    probe.once('error', () => resolveAvailable(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolveAvailable(true));
    });
  });
}

function isGone(child) {
  return child === null || child.exitCode !== null || child.signalCode !== null;
}

function signalTree(child, force = false) {
  if (isGone(child)) return;
  if (WINDOWS) {
    spawnSync(
      'taskkill',
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // 进程组已退出。
  }
}

function exitStateOf(child, name) {
  if (isGone(child)) return Promise.resolve({ name, code: child?.exitCode, signal: child?.signalCode });
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ name, code, signal }));
  });
}

async function stopTree(child) {
  if (isGone(child)) return;
  const exit = once(child, 'exit');
  signalTree(child);
  await Promise.race([exit, sleep(2_000)]);
  if (isGone(child)) return;
  signalTree(child, true);
  await Promise.race([once(child, 'exit'), sleep(2_000)]);
}

let server = null;
let web = null;
let stopping = false;

async function terminate(code) {
  if (stopping) return;
  stopping = true;
  await stopTree(web);
  await stopTree(server);
  process.exit(code);
}

process.on('exit', () => {
  signalTree(web, true);
  signalTree(server, true);
});
process.on('SIGINT', () => void terminate(130));
process.on('SIGTERM', () => void terminate(143));

async function run() {
  const backendPort = backendPortFromConfig();
  const webPort = portOf(process.env['COMEM_WEB_PORT'] ?? '3081', 'COMEM_WEB_PORT');
  const backendUrl = `http://127.0.0.1:${String(backendPort)}`;
  if (backendPort === webPort) {
    throw new Error('后端和控制台不能使用同一个端口；请用 COMEM_WEB_PORT 指定控制台端口。');
  }
  for (const port of [backendPort, webPort]) {
    if (!(await isAvailable(port))) throw new Error(`端口 ${String(port)} 不可用；请换端口后重试。`);
  }

  const options = { detached: !WINDOWS };
  console.log(`==> 后端 ${backendUrl}`);
  server = spawn(
    process.execPath,
    ['--import', 'tsx', join(ROOT, 'src', 'bootstrap', 'main.ts'), ...ARGS],
    { ...options, cwd: ROOT, stdio: 'inherit', env: process.env },
  );

  console.log('==> 等待后端就绪');
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error('后端进程已退出，无法启动控制台；具体原因见上面的后端日志。');
    }
    try {
      const response = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      ready = typeof body === 'object' && body !== null && 'result' in body;
    } catch {
      // 还在迁移或尚未监听。
    }
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error(`后端 60 秒内没有就绪（${backendUrl}/health）；请检查后端日志。`);

  console.log(`==> 控制台 http://127.0.0.1:${String(webPort)}`);
  web = spawn(
    process.execPath,
    [
      join(ROOT, 'web', 'node_modules', 'nuxt', 'bin', 'nuxt.mjs'),
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      ...options,
      cwd: join(ROOT, 'web'),
      stdio: 'inherit',
      env: { ...process.env, COMEM_SERVER_PORT: String(backendPort) },
    },
  );

  const first = await Promise.race([exitStateOf(server, '后端'), exitStateOf(web, '控制台')]);
  if (!stopping) {
    console.error(`错误：${first.name}开发进程意外退出（${first.signal ?? String(first.code ?? 'unknown')}）。`);
    await terminate(1);
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await terminate(1);
}
