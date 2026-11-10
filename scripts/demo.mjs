#!/usr/bin/env node
/**
 * 演示脚本的辅助进程（`scripts/e2e.mjs` 调用）。
 *
 * 这里只做两件 shell 不擅长的事：**等**（轮询 `/health` 直到服务就绪、轮询
 * `.abstract.md` 直到摘要落盘）和**断言**（失败时打印可读的原因并以非零码退出）。
 * 业务流程本身走 HTTP API，与浏览器、MCP 客户端、Hook 插件用的是同一套接口。
 *
 * ## 为什么把「会话 ID / 任务 ID」写进 state.json
 *
 * 每一步是独立的 node 进程（`e2e.mjs` 一个步骤一行命令，读起来就是一条时间线）。
 * 进程间唯一的共享状态是临时目录里的一个 JSON 文件，不用环境变量传参——环境变量
 * 在 `set -u` 下漏一个就是一句「未绑定变量」，而 JSON 能直接 `cat` 出来看。
 *
 * ## 演示用规则摘要，不调模型
 *
 * 配置里 `summary.generator: rule`（§9.2 的实现 2）：没有模型凭据时摘要仍然能生成，
 * 结果带 `degraded: true`。这不是「假装有模型」——`health` 会把它报成 `degraded`，
 * 控制台也会显示降级标记（§17.9「静默降级等于骗人」）。
 *
 * 用法：
 *   node scripts/demo.mjs wait-ready    --base-url http://127.0.0.1:19330
 *   node scripts/demo.mjs write-preference ...
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 参数 ──────────────────────────────────────────────────────────────────

/** `--key value` 与 `--flag` 两种形式；重复的键保留最后一次。 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`无法解析的参数：${token}`);
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  return args;
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('用法：node scripts/demo.mjs <命令> [--base-url ...] [--root ...]\n');
  process.exit(2);
}

const args = parseArgs(rest);
const BASE_URL = String(args['base-url'] ?? process.env.COMEM_DEMO_BASE_URL ?? 'http://127.0.0.1:19330').replace(/\/+$/u, '');
const DEMO_ROOT = String(args.root ?? process.env.COMEM_DEMO_ROOT ?? join(tmpdir(), 'comem-demo'));
const DATA_DIR = join(DEMO_ROOT, 'data');
const STATE_PATH = join(DEMO_ROOT, 'state.json');

/** 演示用的固定身份（v1 单用户部署，装配方把服务图绑在 `user:local`，§12.4）。 */
const SCOPE_ROOT = 'comem://user/local';

// ── 输出 ──────────────────────────────────────────────────────────────────

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function detail(text) {
  line(`    ${text}`);
}

/** 分数显示：BM25 的量级跨度很大，小于 0.001 时用科学计数法才不至于显示成 0.0000。 */
function formatScore(score) {
  return score >= 0.001 ? score.toFixed(4) : score.toExponential(2);
}

/** 摘要截断：终端宽度有限，长摘要会把一行撑断。 */
function clip(text, max = 78) {
  if (text === null || text === undefined || text === '') {
    return '（无摘要）';
  }
  const flat = String(text).replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// ── 状态 ──────────────────────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function requireState(key) {
  const state = readState();
  const value = state[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`state.json 里没有 ${key}：上一步没有跑完？`);
  }
  return value;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

/**
 * 发一个请求并解封套（§14）。错误封套抛成带 `code` 的异常——演示脚本要断言
 * 「这个请求应该被拒绝，且原因是权限」，只看状态码不够。
 */
async function request(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} 返回的不是 JSON（HTTP ${response.status}）：${clip(text, 200)}`);
  }

  if (parsed.status === 'error') {
    const error = new Error(`${parsed.error.code}：${parsed.error.message}`);
    error.code = parsed.error.code;
    error.httpStatus = response.status;
    throw error;
  }
  return parsed.result;
}

const api = {
  get: (path) => request('GET', `/api/v1${path}`),
  post: (path, body) => request('POST', `/api/v1${path}`, body ?? {}),
};

/** 断言一个请求失败，且错误码符合预期。 */
async function expectFailure(label, run, expectedCode) {
  try {
    await run();
  } catch (error) {
    if (error.code !== expectedCode) {
      throw new Error(`${label} 期望 ${expectedCode}，实际是 ${error.code ?? '(无错误码)'}：${error.message}`);
    }
    return error;
  }
  throw new Error(`${label} 本应被拒绝（${expectedCode}），但请求成功了。`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询目录的 L0 摘要，直到非空。返回摘要正文。 */
async function waitForAbstract(directoryUri, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await api.get(`/content/abstract?uri=${encodeURIComponent(directoryUri)}`);
    if (typeof result.abstract === 'string' && result.abstract !== '') {
      return result.abstract;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 ${directoryUri} 的摘要超时（${timeoutMs}ms）。`);
    }
    await sleep(100);
  }
}


// ── 各步骤 ────────────────────────────────────────────────────────────────

/** 轮询 `/health` 直到 2xx。服务端启动要跑迁移与启动自检，固定 sleep 不可靠。 */
async function waitReady() {
  const timeoutMs = Number(args.timeout ?? 60_000);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();

  for (;;) {
    try {
      const health = await api.get('/health');
      detail(`服务已就绪（${Date.now() - startedAt}ms）：status=${health.status}，版本 ${health.version}，索引 ${health.index.nodes} 个节点`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`等待服务就绪超时（${timeoutMs}ms）：${error.message}`);
      }
      await sleep(200);
    }
  }
}

/** 步骤 1：写一条偏好记忆。frontmatter 里的 `memory_type` / `status` 是记忆的类型与复核状态。 */
async function writePreference() {
  const uri = `${SCOPE_ROOT}/memories/preferences/code-style.md`;
  const content = [
    '---',
    'memory_type: preferences',
    'status: active',
    'topic: code-style',
    'summary: TypeScript 严格模式、2 空格缩进、函数式优先',
    'created_at: 2026-11-08T00:00:00Z',
    'updated_at: 2026-11-08T00:00:00Z',
    '---',
    '',
    '## content',
    '',
    '用户偏好 TypeScript 严格模式、2 空格缩进，函数式写法优先于类继承；不喜欢为单一实现预留接口。',
    '',
  ].join('\n');

  const result = await api.post('/content/write', { uri, content, mode: 'replace' });
  if (result.created !== true) {
    throw new Error(`期望新建文件，实际 created=${String(result.created)}`);
  }
  detail(`写入 ${result.uri}`);
  detail(`created=${String(result.created)}，${result.size} 字节`);

  // 摘要失效由写路径的观察者异步触发（§9.3）。等它落盘再检索，演示里才看得到
  // 目录的 L0 命中——固定 sleep 在慢机器上会闪断，所以轮询摘要本身。
  const directory = `${SCOPE_ROOT}/memories/preferences`;
  const abstract = await waitForAbstract(directory, 15_000);
  detail(`父目录 ${directory} 的 L0 摘要已生成：${clip(abstract, 60)}`);

  saveState({ preferenceUri: uri });
}

/** 步骤 2：目录级检索。`find` 同时命中目录的 L0 摘要与文件的 L2 原文。 */
async function findMemory() {
  const query = String(args.query ?? 'TypeScript 严格模式');
  const result = await api.post('/search/find', { query, limit: 5 });
  const hits = result.hits ?? [];
  if (hits.length === 0) {
    throw new Error(`查询「${query}」没有命中任何节点。`);
  }
  if (!hits.some((hit) => hit.uri === readState().preferenceUri)) {
    throw new Error(`查询「${query}」没有命中刚写入的记忆。`);
  }

  detail(`查询「${query}」命中 ${hits.length} 条：`);
  for (const hit of hits) {
    detail(`  ${hit.level.padEnd(2)} ${formatScore(hit.score).padStart(9)}  ${hit.uri}`);
    detail(`             ${clip(hit.abstract)}`);
  }
}

/** 步骤 3：建会话 → 写消息 → 提交归档（阶段一）。 */
async function archiveSession() {
  const created = await api.post('/sessions', {});
  const sessionUri = created.uri;
  const sessionId = sessionUri.slice(sessionUri.lastIndexOf('/') + 1);
  detail(`会话 ${sessionUri}`);

  const appended = await api.post(`/sessions/${sessionId}/messages`, {
    messages: [
      {
        role: 'user',
        parts: [{ kind: 'text', text: '我们这个项目不用 any，需要收窄时用 unknown。' }],
      },
      {
        role: 'assistant',
        parts: [{ kind: 'text', text: '记下了：项目里不用 any，需要收窄时用 unknown。' }],
      },
    ],
  });
  detail(`写入 ${appended.count} 条消息（turn ${appended.messages.map((message) => message.turn).join('、')}）`);

  const committed = await api.post(`/sessions/${sessionId}/commit`, {});
  detail(`归档 ${committed.archiveUri}`);
  detail(`taskId=${committed.taskId}，归档 ${committed.archivedCount} 条消息`);

  saveState({
    sessionUri,
    sessionId,
    archiveUri: committed.archiveUri,
    taskId: committed.taskId,
  });
}

/** 步骤 4：看归档产物。阶段一落盘的东西 + 阶段二的任务行。 */
async function showArchive() {
  const taskId = requireState('taskId');
  const archiveUri = requireState('archiveUri');
  const sessionId = requireState('sessionId');

  // 阶段二在后台跑，轮询到终态再展示。不轮询就只能读到刚建任务时的 pending，
  // 那看起来像「执行器没跑」——而实际上它只是还没轮到。
  //
  // **没有模型凭据时不轮询**：抽取步骤会失败重试三次再进死信，等它只是让人干等
  // 30 秒，而且 `failed` 也不说明编排有问题。直接说「这一步需要模型」更诚实。
  const llmEnabled = process.env['CO_MEM_LLM_ENABLED'] === '1';
  const task = llmEnabled
    ? await waitForTask(taskId)
    : await api.get(`/tasks/${taskId}`);
  detail(`任务 ${task.task.id}：status=${task.task.status}，stepsDone=[${task.task.stepsDone.join(', ')}]`);

  const archiveDir = join(DATA_DIR, 'user', 'local', 'sessions', sessionId, 'history', archiveUri.slice(archiveUri.lastIndexOf('/') + 1));
  const meta = JSON.parse(readFileSync(join(archiveDir, '.meta.json'), 'utf8'));
  detail(`归档元数据 ${archiveDir}/.meta.json：`);
  detail(`  phase1.status=${meta.phase1.status}，archived=${meta.phase1.archivedMessageIds.length} 条，stepsDone=[${meta.stepsDone.join(', ')}]`);

  const messages = readFileSync(join(archiveDir, 'messages.jsonl'), 'utf8').trim().split('\n');
  detail(`归档消息 ${archiveDir}/messages.jsonl：${messages.length} 行（每行一条消息）`);

  if (!llmEnabled) {
    detail('阶段二需要模型：设置 COMEM_LLM_KEY 后重跑，会真实执行四步并写 .done。');
    detail('（摘要已用规则生成器降级产出，见上面的 .abstract.md / .overview.md。）');
  } else if (task.task.status === 'done') {
    detail('阶段二完成：四步全部落盘，.done 已写。');
  } else {
    // 失败不吞掉：把服务端记的原因原样打出来，否则演示脚本会假装一切正常。
    detail(`注意：阶段二没有完成（status=${task.task.status}）：${task.task.error ?? '未记录原因'}`);
  }
}

/**
 * 轮询任务到终态。
 *
 * 超时 30 秒：离线提供者下四步是毫秒级的，真实模型下 `memory_extract` 要几秒。
 * 30 秒够用，又短到演示不会卡住。
 */
async function waitForTask(taskId) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const task = await api.get(`/tasks/${taskId}`);
    const status = task.task.status;
    if (status === 'done' || status === 'failed') {
      return task;
    }
    if (Date.now() > deadline) {
      detail(`等待任务 ${taskId} 超时（30 秒），当前 status=${status}。`);
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 步骤 5：复核闸门。`experiences` / `rules` 先 pending，approve 之后才进检索（§11.6）。 */
async function reviewGate() {
  const uri = `${SCOPE_ROOT}/memories/experiences/pnpm-verify.md`;
  const content = [
    '---',
    'memory_type: experiences',
    'status: pending',
    'topic: pnpm-verify',
    'created_at: 2026-11-08T00:00:00Z',
    'updated_at: 2026-11-08T00:00:00Z',
    '---',
    '',
    '## content',
    '',
    '在 CoMem 里改完代码先跑 pnpm verify：它串起 typecheck、lint、单测与 Hook 测试。',
    '',
  ].join('\n');

  await api.post('/content/write', { uri, content, mode: 'replace' });
  detail(`写入待复核记忆 ${uri}`);

  const before = await api.get('/memories/pending');
  detail(`待复核 ${before.memories.length} 条：${before.memories.map((record) => record.uri).join(', ')}`);
  if (!before.memories.some((record) => record.uri === uri)) {
    throw new Error('待复核列表里没有刚写入的记忆。');
  }

  const query = 'typecheck';
  const hidden = await api.post('/search/find', { query, limit: 5 });
  if (hidden.hits.some((hit) => hit.uri === uri)) {
    throw new Error('pending 记忆出现在检索结果里：复核闸门没有生效。');
  }
  detail(`复核前检索「${query}」：${hidden.hits.length} 条（pending 记录不参与检索）`);

  const approved = await api.post(`/memories/${encodeURIComponent(uri)}/approve`);
  detail(`通过复核：${approved.uri} → status=${approved.status}`);

  const after = await api.get('/memories/pending');
  if (after.memories.some((record) => record.uri === uri)) {
    throw new Error('通过复核后仍在待复核列表里。');
  }
  detail(`待复核剩余 ${after.memories.length} 条`);

  const visible = await api.post('/search/find', { query, limit: 5 });
  if (!visible.hits.some((hit) => hit.uri === uri)) {
    throw new Error('通过复核后检索不到这条记忆。');
  }
  detail(`复核后检索「${query}」：命中 ${visible.hits.length} 条，含 ${uri}`);
}

/** 步骤 6：摘要生成。写一个资源文件，等父目录的 `.abstract.md` 落盘（§9.2、§9.3）。 */
async function generateSummary() {
  const uri = `${SCOPE_ROOT}/resources/docs/architecture.md`;
  await api.post('/content/write', {
    uri,
    content: [
      '---',
      'summary: 四层分层与唯一的依赖方向',
      '---',
      '',
      '# 架构',
      '',
      '四层：接口层负责协议转换，应用层编排用例，领域层是纯规则，适配层实现文件系统、SQLite 与模型调用。',
      '',
      '依赖方向只有一条：接口层 → 应用层 → 领域层，适配层被应用层与接口层注入。',
      '',
    ].join('\n'),
    mode: 'replace',
  });
  detail(`写入资源 ${uri}`);

  const directoryUri = `${SCOPE_ROOT}/resources/docs`;
  const abstractPath = join(DATA_DIR, 'user', 'local', 'resources', 'docs', '.abstract.md');
  const deadline = Date.now() + 15_000;
  while (!existsSync(abstractPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待摘要生成超时：${abstractPath} 不存在。`);
    }
    await sleep(100);
  }

  const abstract = await api.get(`/content/abstract?uri=${encodeURIComponent(directoryUri)}`);
  detail(`${directoryUri} 的 L0 摘要（来源 ${abstract.source}，degraded=${String(abstract.degraded)}）：`);
  detail(`  ${clip(abstract.abstract, 160)}`);

  const overviewPath = join(DATA_DIR, 'user', 'local', 'resources', 'docs', '.overview.md');
  detail(`磁盘上：${abstractPath}（${readFileSync(abstractPath, 'utf8').split('\n').length} 行）、${overviewPath}`);
}

/** 步骤 7：ACL。授权 → 看推导链 → 被拒的组空间写入 → 撤销。 */
async function aclGate() {
  const directory = `${SCOPE_ROOT}/memories`;

  await api.post('/acl/grant', {
    uri: directory,
    principal: 'group:dev',
    level: 1,
    effect: 'allow',
  });
  detail(`给 group:dev 授予 ${directory} 的 read（1）`);

  const snapshot = await api.get(`/acl?uri=${encodeURIComponent(directory)}`);
  detail(`mode=${snapshot.mode}，entries=${JSON.stringify(snapshot.entries)}`);
  detail(`有效权限（按链求值）：${JSON.stringify(snapshot.effective)}`);

  // 组空间没有组员身份：服务图绑定的是 `user:local`，`group:dev` 不在 principals 里。
  const denied = await expectFailure(
    '写入 comem://group/dev/',
    () => api.post('/content/write', { uri: 'comem://group/dev/memories/conventions', content: '组约定' }),
    'PERMISSION_DENIED',
  );
  detail(`写入 comem://group/dev/memories/conventions 被拒绝（HTTP ${denied.httpStatus}，${denied.code}）`);

  await api.post('/acl/revoke', { uri: directory, principal: 'group:dev' });
  const after = await api.get(`/acl?uri=${encodeURIComponent(directory)}`);
  if (after.entries.length !== 0) {
    throw new Error(`撤销后仍有授权条目：${JSON.stringify(after.entries)}`);
  }
  detail(`撤销 group:dev 后 entries=[]，有效权限 ${JSON.stringify(after.effective)}`);
}

// ── 入口 ──────────────────────────────────────────────────────────────────

const commands = {
  'wait-ready': waitReady,
  'write-preference': writePreference,
  find: findMemory,
  archive: archiveSession,
  'show-archive': showArchive,
  review: reviewGate,
  summary: generateSummary,
  acl: aclGate,
};

const run = commands[command];
if (run === undefined) {
  process.stderr.write(`未知命令：${command}。可用：${Object.keys(commands).join(' / ')}\n`);
  process.exit(2);
}

try {
  await run();
} catch (error) {
  process.stderr.write(`\n演示失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
