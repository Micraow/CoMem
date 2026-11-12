/**
 * 事件名契约：宿主事件名 → 内部事件名 → 上报字段（架构文档 §15.2、§17.2）。
 *
 * 这里守的是**一条链**，不是几个字符串：
 *
 * 1. 宿主载荷里的 PascalCase（`SessionStart`）只在适配器入口出现；
 * 2. 适配器查 `lib/events.json` 换成 snake_case（`session_start`），三个宿主共用
 *    同一张表，不各自映射；
 * 3. 上报点把内部事件名放进 `POST /api/v1/telemetry/hook` 的 `event` 字段，而服务端
 *    白名单（`src/services/observability.ts` 的 `HOOK_EVENTS`）只认 snake_case；
 * 4. 安装表让每个宿主事件都真的会被宿主调用——认识却没装的事件等于一个永远
 *    不会出现的事件名。
 *
 * 曾经的缺陷：上报点直接写 PascalCase 字面量，服务端 `normalizeEvent` 把它们全部
 * 归成 `other`，控制台的七个生命周期行永远没有数据。这个文件里的每一条断言都是
 * 那次缺陷的直接反例。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HOOK_EVENTS as INSTALLED_HOOKS } from '../cli.mjs';
import { FileEventDeduper } from '../lib/dedup.mjs';
import { EVENT_NAMES, REPORTED_EVENT_NAMES, internalEventNameOf } from '../lib/events.mjs';
import { normalizeEvent as normalizeClaudeCode } from '../hosts/claude-code.mjs';
import { normalizeEvent as normalizeCodex } from '../hosts/codex.mjs';
import { handlePostToolUse } from '../servers/post-tool-use.mjs';
import { handlePreCompact } from '../servers/pre-compact.mjs';
import { handleSessionStart } from '../servers/session-start.mjs';
import { runCaptureWorker, writeWorkerPayload } from '../servers/stop.mjs';
import { handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';

/** §17.2 的上报端点（`integrations/lib/telemetry.mjs` 的 `TELEMETRY_PATH`）。 */
const TELEMETRY_PATH = '/api/v1/telemetry/hook';

/**
 * 记录所有请求的假客户端。
 *
 * GET 一律返回空对象：`SessionStart` 的三个块都走「没有这个节点」的降级路径，
 * 不上报诊断噪声。POST 按端点回最小可用的封套。
 */
function fakeHttp() {
  const calls = [];
  return {
    calls,
    async get(path, query) {
      calls.push({ path, body: query });
      return {};
    },
    async post(path, body) {
      calls.push({ path, body });
      if (path === '/api/v1/sessions') {
        // 会话已存在（§19 的 CONFLICT）：采集链路照常继续。
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      if (path === '/api/v1/search/find') {
        return { hits: [] };
      }
      return { ok: true };
    },
  };
}

/** 从请求记录里取出上报的事件名。 */
function reportedEvents(http) {
  return http.calls
    .filter((call) => call.path === TELEMETRY_PATH)
    .map((call) => call.body.event);
}

function message(index) {
  return {
    id: `msg-${index}`,
    role: 'user',
    parts: [{ kind: 'text', text: `第 ${index} 条` }],
    createdAt: '2026-11-10T00:00:00.000Z',
  };
}

test('事件名表：内部名 snake_case、宿主名 PascalCase，两个方向都能查', () => {
  for (const [internal, host] of Object.entries(EVENT_NAMES)) {
    assert.match(internal, /^[a-z]+(_[a-z]+)*$/, `内部事件名必须是 snake_case：${internal}`);
    assert.match(host, /^[A-Z][A-Za-z]*$/, `宿主事件名必须是 PascalCase：${host}`);
    assert.equal(internalEventNameOf(host), internal);
  }
  // 键与值都一对一：重复会让「反查」有歧义。
  assert.equal(new Set(Object.keys(EVENT_NAMES)).size, Object.keys(EVENT_NAMES).length);
  assert.equal(new Set(Object.values(EVENT_NAMES)).size, Object.values(EVENT_NAMES).length);
  // 只认宿主名，不认内部名：宿主不会发 snake_case，反查也不该「兼容」它。
  assert.equal(internalEventNameOf('SessionEnded'), null);
  assert.equal(internalEventNameOf('session_start'), null);
});

test('有上报点的事件是表的一个真子集：pre_tool_use 不报开销', () => {
  // `PreToolUse` 只做本地判断、不发 HTTP（`servers/pre-tool-use.mjs` 的文件头），
  // 让它上报等于给每次工具调用加一次网络往返。所以它照常被适配器接受，但不在
  // 上报集合里——服务端白名单与控制台也不为它留位置。
  assert.deepEqual(
    [...REPORTED_EVENT_NAMES].sort(),
    [
      'post_tool_use',
      'pre_compact',
      'session_end',
      'session_start',
      'stop',
      'user_prompt_submit',
    ],
  );
  for (const name of REPORTED_EVENT_NAMES) {
    assert.ok(Object.hasOwn(EVENT_NAMES, name), `${name} 不在事件名表里`);
  }
  assert.equal(REPORTED_EVENT_NAMES.includes('pre_tool_use'), false);
  assert.equal(Object.hasOwn(EVENT_NAMES, 'pre_tool_use'), true);
});

test('两个宿主适配器都从同一张表取名，没有各自的映射', () => {
  const hosts = [
    [
      'claude-code',
      normalizeClaudeCode,
      (host) => ({ hook_event_name: host, session_id: 's1', cwd: '/repo' }),
    ],
    ['codex', normalizeCodex, (host) => ({ hook_event_name: host, session_id: 's1', cwd: '/repo' })],
  ];
  for (const [label, normalize, payload] of hosts) {
    for (const [internal, host] of Object.entries(EVENT_NAMES)) {
      const event = normalize(payload(host));
      assert.equal(event.event, internal, `${label} 把 ${host} 变成了 ${event.event}`);
      // 返回信封要用宿主认识的名字，不能把内部名写回去。
      assert.equal(event.hostEventName, host, `${label} 的 hostEventName 漂了：${event.hostEventName}`);
    }
  }
});

test('安装表覆盖表里的每个宿主事件：认识但没装 = 永远不会出现的事件名', () => {
  assert.deepEqual(
    Object.keys(INSTALLED_HOOKS).sort(),
    Object.values(EVENT_NAMES).sort(),
    '`cli.mjs` 的安装表与 `lib/events.json` 不一致：装漏的事件永远不会上报，多装的事件适配器会拒绝',
  );
});

test('每个上报点发出的 event 都在常量表里', async () => {
  const http = fakeHttp();
  const dir = await mkdtemp(join(tmpdir(), 'comem-event-names-'));
  try {
    const base = { userId: 'alice', tmpDir: dir };

    await handleSessionStart(
      { event: 'session_start', sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
      { config: { ...base, skillBudgetTokens: 100 }, http, env: {} },
    );

    await handleUserPromptSubmit(
      { event: 'user_prompt_submit', sessionId: 'cc-1', cwd: '/repo', prompt: '上周的设计决定' },
      { config: { ...base, queryFilters: [], recallLimit: 5, recallScoreThreshold: 0.5 }, http, env: {} },
    );

    await handlePostToolUse(
      {
        event: 'post_tool_use',
        sessionId: 'cc-1',
        cwd: '/repo',
        toolName: 'Read',
        toolUseId: 'tool-1',
        toolInput: { file_path: '/repo/a.ts' },
        toolOutput: 'contents',
      },
      { config: base, http, env: {}, deduper: new FileEventDeduper(join(dir, 'comem-events.json')) },
    );

    // 同一个脚本服务两个生命周期点：事件名必须跟着载荷走，不能写死一个。
    const deduper = new FileEventDeduper(join(dir, 'comem-events.json'));
    await handlePreCompact(
      {
        event: 'pre_compact',
        sessionId: 'cc-2',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(0)],
      },
      { config: base, http, env: {}, deduper },
    );
    await handlePreCompact(
      {
        event: 'session_end',
        sessionId: 'cc-3',
        cwd: '/repo',
        eventId: null,
        transcriptPath: null,
        messages: [message(1)],
      },
      { config: base, http, env: {}, deduper },
    );

    // `Stop` 的上报在分离 worker 里，所以这里直接跑 worker 的处理函数。
    const payloadFile = await writeWorkerPayload(dir, {
      event: {
        event: 'stop',
        sessionId: 'cc-4',
        cwd: dir,
        eventId: null,
        transcriptPath: null,
        messages: [message(2)],
      },
      processStartMs: 1,
    });
    await runCaptureWorker(payloadFile, { config: base, http, env: {} });

    const reported = reportedEvents(http);
    // 先查「发出去的名字对不对」：写成宿主名（`SessionStart`）时，这条比
    // 「少了某个事件」更直接地指向缺陷。
    for (const name of reported) {
      assert.ok(
        REPORTED_EVENT_NAMES.includes(name),
        `${name} 不是「有上报点的事件」：服务端白名单会把它归成 other，这个样本就丢了（实际：${reported.join(', ')}）`,
      );
    }
    for (const name of REPORTED_EVENT_NAMES) {
      assert.ok(reported.includes(name), `上报点没有发出 ${name}（实际：${reported.join(', ')}）`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
