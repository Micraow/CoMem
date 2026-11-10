/**
 * transcript 解析（架构文档 §15.5、§15.7）。
 *
 * ## 为什么这份测试存在
 *
 * `Stop` 曾经内置一份 Claude Code 的 JSONL 解析器。Codex 写出的 rollout 没有顶层
 * `message` 字段，于是**每一行都被跳过**，`captureSession` 拿到空数组后早退：不发
 * `POST /sessions`、不建会话、不提交、不建任务，进程还退出 0。整条阶段二从来没
 * 启动过，而表面上一切正常。
 *
 * 解析器现在挂在各自的宿主适配器上（`hosts/<host>.mjs` 的 `parseTranscript`）。
 * 这里的 fixture 用真实 rollout 的形状（`session_meta` / `event_msg` /
 * `turn_context` / `response_item` 混合，含 `function_call` 与空文本消息），
 * 锁住「每宿主一份解析器」与「解析出 0 条必须留诊断」。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseTranscript as parseClaudeCode } from '../hosts/claude-code.mjs';
import { parseTranscript as parseCodex } from '../hosts/codex.mjs';
import { parseTranscript as parseDsh } from '../hosts/dsh.mjs';
import { captureSession } from '../servers/stop.mjs';

/**
 * Codex rollout 的行形状，取本机 `~/.codex/sessions/2026/11/06/rollout-*.jsonl`
 * 的真实条目（正文替换成短文本，`ordinal` 保留原样）。
 *
 * 12 行里只有 2 行是对话正文：其余是会话元数据、任务事件、`developer` 指令、
 * `reasoning`、工具调用与空文本消息。
 */
const CODEX_ROLLOUT_LINES = [
  {
    timestamp: '2026-11-06T11:35:39.562Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: 'thr_1', cwd: '/work', cli_version: '0.163.0-alpha.10.2' },
  },
  {
    timestamp: '2026-11-06T11:35:39.562Z',
    ordinal: 1,
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn_1' },
  },
  {
    timestamp: '2026-11-06T11:35:39.659Z',
    ordinal: 2,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_dev',
      role: 'developer',
      content: [{ type: 'input_text', text: '<app-context>…</app-context>' }],
    },
  },
  {
    timestamp: '2026-11-06T11:35:40.000Z',
    ordinal: 3,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_user',
      role: 'user',
      content: [{ type: 'input_text', text: '怎么配置 TypeScript' }],
    },
  },
  {
    timestamp: '2026-11-06T11:35:40.100Z',
    ordinal: 4,
    type: 'turn_context',
    payload: { turn_id: 'turn_1' },
  },
  {
    timestamp: '2026-11-06T11:35:41.000Z',
    ordinal: 5,
    type: 'response_item',
    payload: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '思考' }] },
  },
  {
    timestamp: '2026-11-06T11:35:42.000Z',
    ordinal: 6,
    type: 'response_item',
    payload: { type: 'function_call', id: 'fc_1', name: 'exec', arguments: '{}' },
  },
  {
    timestamp: '2026-11-06T11:35:43.000Z',
    ordinal: 7,
    type: 'response_item',
    payload: { type: 'function_call_output', id: 'fco_1', call_id: 'fc_1', output: 'ok' },
  },
  {
    timestamp: '2026-11-06T11:35:44.000Z',
    ordinal: 8,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_assistant',
      role: 'assistant',
      content: [
        { type: 'output_text', text: '把 tsconfig 的 strict 打开。' },
        { type: 'output_text', text: '再设 target。' },
      ],
    },
  },
  {
    timestamp: '2026-11-06T11:35:45.000Z',
    ordinal: 9,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_empty',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    },
  },
  {
    timestamp: '2026-11-06T11:35:46.000Z',
    ordinal: 10,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_image',
      role: 'user',
      content: [{ type: 'input_image', path: '/tmp/a.png' }],
    },
  },
  {
    timestamp: '2026-11-06T11:35:47.000Z',
    ordinal: 11,
    type: 'event_msg',
    payload: { type: 'token_count' },
  },
];

const CODEX_ROLLOUT = `${CODEX_ROLLOUT_LINES.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

/** Claude Code 的 transcript 形状（顶层 `message`），与 rollout 不是一种格式。 */
const CLAUDE_LINES = [
  { uuid: 'u1', type: 'user', message: { role: 'user', content: '怎么配置 TypeScript' } },
  {
    uuid: 'u2',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '用 strict' }] },
  },
  // 工具调用由 PostToolUse 采集，不在这里重复。
  {
    uuid: 'u3',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
  },
  // 子 agent 的对话属于另一个会话。
  {
    uuid: 'u4',
    type: 'user',
    isSidechain: true,
    message: { role: 'user', content: '子 agent 的问题' },
  },
  { uuid: 'u5', type: 'user', message: { role: 'user', content: '半行' } },
];

const CLAUDE_TRANSCRIPT = `${CLAUDE_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`;

/** 记录调用、永远成功的假客户端。 */
function fakeHttp() {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      return { ok: true };
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-transcript-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Codex rollout：只取 user / assistant 的 message，元数据与工具调用跳过', () => {
  const parsed = parseCodex(CODEX_ROLLOUT, { sessionId: 'cx-thr_1' });
  assert.deepEqual(
    parsed.messages.map((message) => [message.id, message.role]),
    [
      ['msg_user', 'user'],
      ['msg_assistant', 'assistant'],
    ],
  );
  assert.equal(parsed.messages[0].createdAt, '2026-11-06T11:35:40.000Z');
  // 逐条点名被跳过的：非 response_item（session_meta / event_msg / turn_context）、
  // developer 指令、reasoning、function_call、空文本、只有图片的消息。
  const ids = parsed.messages.map((message) => message.id);
  for (const skippedId of ['msg_dev', 'rs_1', 'fc_1', 'msg_empty', 'msg_image']) {
    assert.equal(ids.includes(skippedId), false, `${skippedId} 不该被采集`);
  }
  // 12 行里 10 行不是对话正文：session_meta / event_msg / turn_context /
  // developer / reasoning / 工具调用 / 空文本 / 图片 / token_count。
  assert.equal(parsed.lines, 12);
  assert.equal(parsed.skipped, 10);
  assert.match(parsed.sample, /type=session_meta/);
});

test('Codex rollout：多段文本按换行拼接', () => {
  const parsed = parseCodex(CODEX_ROLLOUT);
  assert.deepEqual(parsed.messages[1].parts, [
    { kind: 'text', text: '把 tsconfig 的 strict 打开。\n再设 target。' },
  ]);
});

test('Codex rollout：畸形行不抛错，计入跳过', () => {
  const text = `${CODEX_ROLLOUT}{"timestamp":"2026-11-06T11:35:48.000Z","type":"response_item","payload":`;
  const parsed = parseCodex(text);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.lines, 13);
  assert.equal(parsed.skipped, 11);
});

test('Claude Code 的解析器保持既有语义（uuid / 工具 / sidechain / 半行）', () => {
  const parsed = parseClaudeCode(`${CLAUDE_TRANSCRIPT}{"uuid":"u6","message":`, {
    sessionId: 'cc-1',
  });
  assert.deepEqual(
    parsed.messages.map((message) => message.id),
    ['u1', 'u2', 'u5'],
  );
  assert.equal(parsed.lines, 6);
  // u3（工具调用）、u4（sidechain）、最后半行。
  assert.equal(parsed.skipped, 3);
});

test('混合格式不串味：各自的解析器不认对方的行', () => {
  const claudeOnRollout = parseClaudeCode(CODEX_ROLLOUT, { sessionId: 'cc-1' });
  assert.equal(claudeOnRollout.messages.length, 0);
  assert.equal(claudeOnRollout.lines, 12);
  assert.equal(claudeOnRollout.skipped, 12);
  assert.match(claudeOnRollout.sample, /keys=timestamp,ordinal,type/);

  const codexOnClaude = parseCodex(CLAUDE_TRANSCRIPT, { sessionId: 'cx-1' });
  assert.equal(codexOnClaude.messages.length, 0);
  assert.equal(codexOnClaude.lines, 5);
  assert.equal(codexOnClaude.skipped, 5);
  assert.match(codexOnClaude.sample, /keys=uuid,type,message/);
});

test('DSH 不解析 transcript：结果带「未验证」说明', () => {
  const parsed = parseDsh('任意内容');
  assert.deepEqual(parsed.messages, []);
  assert.match(parsed.note, /未验证/);
});

test('回归：Codex rollout 走完整 captureSession 时 captured > 0', async () => {
  await withTempDir(async (dir) => {
    const transcript = join(dir, 'rollout-2026-11-06T11-35-38-thr_1.jsonl');
    await writeFile(transcript, CODEX_ROLLOUT, 'utf8');
    const http = fakeHttp();

    const result = await captureSession(
      {
        // 宿主名决定解析器：worker 从载荷里读它（`--host` 不在 worker 的 argv 里）。
        host: 'codex',
        event: 'stop',
        sessionId: 'cx-thr_1',
        cwd: dir,
        eventId: null,
        transcriptPath: transcript,
        messages: null,
      },
      { config: { tmpDir: dir, userId: 'alice' }, http, env: {} },
    );

    // 修复前：Codex 的每一行都被当成「不是 user / assistant」跳过，这里 captured 是 0，
    // 而且一个请求都不会发出去。
    assert.equal(result.captured, 2);
    assert.equal(result.committed, true);
    const posted = http.calls.find((call) => call.path.endsWith('/messages'));
    assert.deepEqual(
      posted.body.messages.map((message) => message.id),
      ['msg_user', 'msg_assistant'],
    );
    assert.equal(
      http.calls.some((call) => call.path === '/api/v1/sessions/cx-thr_1/commit'),
      true,
    );
    const cursor = JSON.parse(await readFile(join(dir, 'comem-cursors.json'), 'utf8'));
    assert.deepEqual(cursor, { 'cx-thr_1': 2 });
  });
});

test('解析出 0 条消息时写诊断日志：宿主名 / 路径 / 行数 / 跳过数 / 首行形状', async () => {
  await withTempDir(async (dir) => {
    const transcript = join(dir, 'rollout.jsonl');
    await writeFile(transcript, CODEX_ROLLOUT, 'utf8');
    const http = fakeHttp();

    const result = await captureSession(
      {
        // 拿 Claude Code 的解析器读 rollout：一份「格式对不上」的典型现场。
        host: 'claude-code',
        event: 'stop',
        sessionId: 'cc-x',
        cwd: dir,
        eventId: null,
        transcriptPath: transcript,
        messages: null,
      },
      { config: { tmpDir: dir, userId: 'alice' }, http, env: {} },
    );

    assert.equal(result.captured, 0);
    assert.equal(result.committed, false);
    // 0 条时不能发任何请求：没有会话可建，也没有消息可写。
    assert.deepEqual(http.calls, []);

    const log = JSON.parse((await readFile(join(dir, 'comem-capture.log'), 'utf8')).trim());
    assert.equal(log.host, 'claude-code');
    assert.equal(log.event, 'stop');
    assert.equal(log.transcript, transcript);
    assert.equal(log.reason, 'no-messages');
    assert.equal(log.lines, 12);
    assert.equal(log.skipped, 12);
    assert.match(log.sample, /type=session_meta/);
    // 诊断里不能出现消息正文。
    assert.equal(JSON.stringify(log).includes('怎么配置 TypeScript'), false);
  });
});

test('没有 transcript 路径时也记一条，与「给了但解析不出」区分', async () => {
  await withTempDir(async (dir) => {
    const http = fakeHttp();
    const result = await captureSession(
      {
        host: 'codex',
        event: 'session_end',
        sessionId: 'cx-empty',
        cwd: dir,
        eventId: null,
        transcriptPath: null,
        messages: null,
      },
      { config: { tmpDir: dir, userId: 'alice' }, http, env: {} },
    );

    assert.equal(result.captured, 0);
    assert.deepEqual(http.calls, []);
    const log = JSON.parse((await readFile(join(dir, 'comem-capture.log'), 'utf8')).trim());
    assert.equal(log.reason, 'no-transcript-path');
    assert.equal(log.transcript, null);
    assert.equal(log.lines, 0);
  });
});

test('DSH 载荷没有 messages 时，transcript 路径的「未验证」写进诊断', async () => {
  await withTempDir(async (dir) => {
    const transcript = join(dir, 'session.jsonl');
    await writeFile(transcript, '{"unknown":true}\n', 'utf8');
    const http = fakeHttp();

    await captureSession(
      {
        host: 'dsh',
        event: 'stop',
        sessionId: 'dsh-1',
        cwd: dir,
        eventId: null,
        transcriptPath: transcript,
        messages: null,
      },
      { config: { tmpDir: dir, userId: 'alice' }, http, env: {} },
    );

    const log = JSON.parse((await readFile(join(dir, 'comem-capture.log'), 'utf8')).trim());
    assert.equal(log.host, 'dsh');
    assert.match(log.note, /未验证/);
  });
});
