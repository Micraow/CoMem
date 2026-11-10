#!/usr/bin/env node
// scripts/dev.sh 的跨平台移植
// 改端口: COMEM_SERVER_PORT=1934 pnpm dev

import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_PORT = Number(process.env['COMEM_SERVER_PORT'] ?? 1933);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const CONSOLE_URL = 'http://127.0.0.1:3081';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// 起动后端

console.log(`==> 后端 ${BACKEND_URL}`);
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'src', 'bootstrap', 'main.ts')],
  { cwd: ROOT, stdio: 'inherit', env: process.env },
);

let consoleProc = null;
function cleanup() {
  // 忽略失败: 进程可能已经自己退出了.
  if (consoleProc && consoleProc.exitCode === null) consoleProc.kill('SIGTERM');
  if (server.exitCode === null) server.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// 后端就绪
//
// 确认: 进程还活着, 端口被别的服务占着时 `listen` 会失败, 但控制台照样能起来
console.log('==> 等待后端就绪');
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  if (server.exitCode !== null) {
    console.error('');
    console.error('错误: 后端进程已退出, 无法启动控制台. ');
    console.error(`      常见原因是 ${BACKEND_PORT} 端口被别的服务占用 (EADDRINUSE) . `);
    console.error('      换个端口: COMEM_SERVER_PORT=1934 pnpm dev');
    process.exit(1);
  }
  // CoMem 的封装: {"status":"ok","result":{...}}. 别的服务可能也返回 200.
  try {
    const response = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    if (body && typeof body === 'object' && 'result' in body) {
      ready = true;
    }
  } catch {
    // 端口错误, 继续等.
  }
  if (!ready) await sleep(500);
}
if (!ready) {
  console.error('');
  console.error(`错误: 后端 60 秒内没有就绪 (${BACKEND_URL}/health) . `);
  console.error('      看后端日志确认是启动失败还是启动太慢. ');
  process.exit(1);
}

// 控制台

console.log(`==> 控制台 ${CONSOLE_URL}`);
// 把端口传给控制台的 devProxy: 两边必须指向同一个后端
consoleProc = spawn(
  process.execPath,
  [join(ROOT, 'web', 'node_modules', 'nuxt', 'bin', 'nuxt.mjs'), 'dev', '--port', '3081'],
  { cwd: join(ROOT, 'web'), stdio: 'inherit', env: { ...process.env, COMEM_SERVER_PORT: String(BACKEND_PORT) } },
);

await new Promise((resolveConsole) => {
  consoleProc.on('exit', (code) => {
    process.exitCode = code ?? 1;
    resolveConsole();
  });
  server.on('exit', () => {
    if (consoleProc.exitCode === null) consoleProc.kill('SIGTERM');
  });
});
