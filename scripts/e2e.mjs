#!/usr/bin/env node
// scripts/demo.sh 的跨平台移植
//
// 可选环境变量
//   COMEM_DEMO_ROOT   演示数据根 默认 os.tmpdir()/comem-demo 必须在 os.tmpdir() 内
//   COMEM_DEMO_PORT   演示服务端口 默认 19330
//   COMEM_LLM_KEY     设置后走真实 LLM, 摘要/经验蒸馏, 不设置则降级为规则摘要
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_ROOT = resolve(String(process.env['COMEM_DEMO_ROOT'] ?? join(tmpdir(), 'comem-demo')));
const DEMO_PORT = Number(process.env['COMEM_DEMO_PORT'] ?? 19330);
const BASE_URL = `http://127.0.0.1:${DEMO_PORT}`;
const DATA_DIR = join(DEMO_ROOT, 'data');
const LLM_KEY = String(process.env['COMEM_LLM_KEY'] ?? '');
const LLM_BASE_URL = String(process.env['COMEM_LLM_BASE_URL'] ?? 'http://127.0.0.1:3425/v1');
const LLM_MODEL = String(process.env['COMEM_LLM_MODEL'] ?? 'comate/600085158/xiaomi/mimo-v2.6-flash//public');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// 前置检查

{
  const tmpBase = resolve(tmpdir());
  if (DEMO_ROOT !== tmpBase && !DEMO_ROOT.startsWith(tmpBase + sep)) {
    fail(`演示数据根必须在 os.tmpdir() (${tmpBase}) 内, 当前为 ${DEMO_ROOT}`);
  }
}
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    fail(`需要 Node >= 22.5, 当前 ${process.versions.node}`);
  }
}
if (!existsSync(join(ROOT, 'node_modules', 'tsx'))) {
  fail('请先执行 pnpm install');
}

// 建数据根, 写配置

rmSync(DEMO_ROOT, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const providersBlock = LLM_KEY
  ? `providers:
  llm:
    default:
      type: openai-compatible
      baseUrl: ${LLM_BASE_URL}
      model: ${LLM_MODEL}
      apiKey: ${LLM_KEY}
      maxTokens: 32768
      timeoutSeconds: 120`
  : '# 没有 COMEM_LLM_KEY: phase 2 会失败重试, 进死信, 摘要降级为规则生成';

const yaml = `dataDir: ${DATA_DIR.split(sep).join('/')}
${providersBlock}
summary:
  generator: ${LLM_KEY ? 'llm' : 'rule'}
server:
  host: 127.0.0.1
  port: ${DEMO_PORT}
auth:
  # 步骤 4/7 要读 \`GET /tasks/{id}\`, 该接口只认系统管理员名单
  #  (src/api/http/routes/tasks.ts) . 名单默认空 = 全员 403, 所以演示必须
  # 写入绑定的 subject (server.subject 的 uid) . auth.enabled 保持默认 false:
  # 演示是单用户形态, 身份由 server.subject 给出.
  adminUserIds: [local]
logging:
  level: warn
`;
writeFileSync(join(DEMO_ROOT, 'config.yaml'), yaml, 'utf8');

console.log('CoMem 六条链路演示');
console.log(`  repo    ${ROOT}`);
console.log(`  数据根  ${DATA_DIR}`);
console.log(`  服务    ${BASE_URL}`);
console.log(`  配置    ${join(DEMO_ROOT, 'config.yaml')}`);

// 启动服务

// 一个 node 进程, 不用 pnpm 包一层, 不会留下孤儿进程.
const serverLog = openSync(join(DEMO_ROOT, 'server.log'), 'w');
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'src', 'bootstrap', 'main.ts'), '--config', join(DEMO_ROOT, 'config.yaml')],
  { cwd: ROOT, stdio: ['ignore', serverLog, serverLog], env: process.env },
);

function cleanup() {
  if (server.exitCode === null) server.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

console.log('');
console.log('==> 服务就绪');

// 六条链路

// 每一步是 scripts/demo.mjs 的一个子命令, 输出直通终端.
async function runStep(name, extraArgs) {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'demo.mjs'), name, ...extraArgs, '--base-url', BASE_URL, '--root', DEMO_ROOT],
    {
      stdio: 'inherit',
      env: { ...process.env, CO_MEM_LLM_ENABLED: LLM_KEY ? '1' : '0' },
    },
  );
  const code = await new Promise((resolveCode) => {
    child.once('exit', (exitCode) => resolveCode(exitCode ?? 1));
    child.once('error', () => resolveCode(1));
  });
  return code;
}

// [标签, 子命令, 额外参数]
const steps = [
  ['写入一条偏好记忆', 'write-preference', []],
  ['目录级检索', 'find', []],
  ['建会话、写消息、提交归档', 'archive', []],
  ['看归档产物', 'show-archive', []],
  ['通过复核', 'review', []],
  ['摘要生成', 'summary', []],
  ['ACL', 'acl', []],
];

// 等服务起来再跑步骤.
const readyCode = await runStep('wait-ready', ['--timeout', '60000']);
if (readyCode !== 0) {
  cleanup();
  fail(`服务 60 秒内没起来 (exit ${readyCode}) , 看 ${join(DEMO_ROOT, 'server.log')}. `);
}

for (let i = 0; i < steps.length; i += 1) {
  const [label, name, extraArgs] = steps[i];
  if (server.exitCode !== null) {
    fail(`服务进程提前退出 (code ${server.exitCode}) , 看 ${join(DEMO_ROOT, 'server.log')}. `);
  }
  console.log('');
  console.log(`==> ${i + 1}/${steps.length} ${label}`);
  const code = await runStep(name, extraArgs);
  if (code !== 0) {
    cleanup();
    fail(`步骤「${label}」失败 (exit ${code}) . 演示根保留在 ${DEMO_ROOT}, 服务日志在 ${join(DEMO_ROOT, 'server.log')}. `);
  }
}

console.log('');
console.log('==> 演示完成');
console.log(`  数据根    ${DATA_DIR}`);
console.log(`  服务日志  ${join(DEMO_ROOT, 'server.log')}`);
console.log(`  /metrics  见 ${BASE_URL}/metrics (Prometheus 文本) `);
console.log('');
console.log('  GET /health (原样 JSON) :');
try {
  const response = await fetch(`${BASE_URL}/health`);
  const body = await response.json();
  for (const line of JSON.stringify(body, null, 2).split('\n')) {
    console.log(`    ${line}`);
  }
} catch {
  console.log('     (服务已退出, 拿不到 /health) ');
}

cleanup();
