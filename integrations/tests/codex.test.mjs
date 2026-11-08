/**
 * Codex 宿主适配（架构文档 §15.5、§15.7）。
 *
 * 载荷样例依据 Codex 官方 Hook 文档（<https://developers.openai.com/codex/hooks>）：
 * 公共字段 `session_id` / `transcript_path` / `cwd` / `hook_event_name`，事件私有
 * 字段见各用例。信封形状与 Codex 的 `hookSpecificOutput` 契约一致。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENT_NAMES,
  MAX_CONTEXT_BYTES,
  SESSION_ID_PREFIX,
  formatOutput,
  normalizeEvent,
  runHook,
} from '../hosts/codex.mjs';

test('SessionStart：读 source，会话 ID 加 cx- 前缀', () => {
  const event = normalizeEvent({
    hook_event_name: 'SessionStart',
    session_id: 'thr_123',
    transcript_path: '/work/.codex/rollout.jsonl',
    cwd: '/work',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    source: 'resume',
  });
  assert.equal(event.host, 'codex');
  assert.equal(event.event, 'SessionStart');
  assert.equal(event.hostEventName, 'SessionStart');
  assert.equal(event.sessionId, `${SESSION_ID_PREFIX}thr_123`);
  assert.equal(event.cwd, '/work');
  assert.equal(event.source, 'resume');
  assert.equal(event.transcriptPath, '/work/.codex/rollout.jsonl');
  assert.equal(event.eventId, null);
});

test('UserPromptSubmit：读 prompt，无事件 ID（靠游标兜底）', () => {
  const event = normalizeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'thr_9',
    cwd: '/repo',
    turn_id: 'turn_1',
    prompt: '帮我找一下上周的设计决定',
  });
  assert.equal(event.event, 'UserPromptSubmit');
  assert.equal(event.prompt, '帮我找一下上周的设计决定');
  assert.equal(event.eventId, null);
});

test('PreToolUse：apply_patch 从补丁命令里取 comem:// 路径', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 'thr_9',
    cwd: '/repo',
    turn_id: 'turn_2',
    tool_name: 'apply_patch',
    tool_use_id: 'call_abc',
    tool_input: {
      command: '*** Begin Patch\n*** Update File: comem://user/alice/memories/profile.md\n*** End Patch',
    },
  });
  assert.equal(event.event, 'PreToolUse');
  assert.equal(event.toolName, 'apply_patch');
  assert.equal(event.filePath, 'comem://user/alice/memories/profile.md');
  assert.equal(event.eventId, 'PreToolUse:call_abc');
});

test('PreToolUse：Edit 用 file_path，并用 tool_use_id 合成事件 ID', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 'thr_9',
    cwd: '/repo',
    tool_name: 'Edit',
    tool_use_id: 'call_x',
    tool_input: { file_path: 'comem://user/alice/prefs/theme.md', old_string: 'a', new_string: 'b' },
  });
  assert.equal(event.filePath, 'comem://user/alice/prefs/theme.md');
  assert.equal(event.eventId, 'PreToolUse:call_x');
});

test('PreToolUse：Bash 不取路径（守卫只认文件工具）', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 'thr_9',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_use_id: 'call_b',
    tool_input: { command: 'cat comem://user/alice/memories/profile.md' },
  });
  assert.equal(event.toolName, 'Bash');
  assert.equal(event.filePath, null);
});

test('PostToolUse：带 tool_response，渲染成文本', () => {
  const event = normalizeEvent({
    hook_event_name: 'PostToolUse',
    session_id: 'thr_9',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_use_id: 'call_p',
    tool_input: { command: 'ls' },
    tool_response: { exit_code: 0, stdout: 'a\nb' },
  });
  assert.equal(event.event, 'PostToolUse');
  assert.equal(event.toolOutput, JSON.stringify({ exit_code: 0, stdout: 'a\nb' }));
});

test('Stop：读 stop_hook_active，无事件 ID', () => {
  const event = normalizeEvent({
    hook_event_name: 'Stop',
    session_id: 'thr_9',
    cwd: '/repo',
    stop_hook_active: false,
    last_assistant_message: '已完成',
  });
  assert.equal(event.event, 'Stop');
  assert.equal(event.eventId, null);
});

test('SessionEnd 归一成 PreCompact（与 §15.2 表格一致）', () => {
  const event = normalizeEvent({
    hook_event_name: 'SessionEnd',
    session_id: 'thr_9',
    cwd: '/repo',
    reason: 'other',
  });
  assert.equal(event.event, 'PreCompact');
  assert.equal(event.hostEventName, 'PreCompact');
});

test('PreCompact：读 trigger', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreCompact',
    session_id: 'thr_9',
    cwd: '/repo',
    trigger: 'auto',
  });
  assert.equal(event.event, 'PreCompact');
});

test('未知事件被拒绝（不静默吞掉）', () => {
  assert.throws(
    () => normalizeEvent({ hook_event_name: 'PermissionRequest', session_id: 's1' }),
    /未支持的 Codex hook 事件/,
  );
  assert.throws(
    () => normalizeEvent({ hook_event_name: 'SubagentStart', session_id: 's1' }),
    /未支持/,
  );
});

test('缺少 hook_event_name 或 session_id 都抛错', () => {
  assert.throws(() => normalizeEvent({ session_id: 's1' }), /缺少 hook_event_name/);
  assert.throws(() => normalizeEvent({ hook_event_name: 'Stop' }), /缺少 session_id/);
});

test('formatOutput：context → hookSpecificOutput.additionalContext', () => {
  const event = normalizeEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/r' });
  assert.deepEqual(formatOutput(event, { context: '记忆' }), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '记忆' },
  });
});

test('formatOutput：deny → permissionDecision deny', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/r',
    tool_name: 'Edit',
    tool_use_id: 'c1',
    tool_input: {},
  });
  assert.deepEqual(formatOutput(event, { deny: '请用 MCP 工具 edit' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '请用 MCP 工具 edit',
    },
  });
});

test('formatOutput：message → systemMessage；空结果 → null', () => {
  const event = normalizeEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/r' });
  assert.deepEqual(formatOutput(event, { message: '提示' }), { systemMessage: '提示' });
  assert.equal(formatOutput(event, {}), null);
  assert.equal(formatOutput(event, undefined), null);
});

test('runHook：载荷解析后交给 handler，输出写进 stdout', async () => {
  const lines = [];
  const event = await runHook(() => ({ context: 'hi' }), {
    read: async () => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/r', prompt: 'x' }),
    write: (line) => lines.push(line),
  });
  assert.equal(event.event, 'UserPromptSubmit');
  assert.deepEqual(JSON.parse(lines[0]), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hi' },
  });
});

test('runHook：非法载荷写 stderr、不抛、不写 stdout', async () => {
  const lines = [];
  const event = await runHook(() => ({ context: 'x' }), {
    read: async () => ({ hook_event_name: 'Stop' }),
    write: (line) => lines.push(line),
  });
  assert.equal(event, null);
  assert.equal(lines.length, 0);
});

test('常量：前缀、预算、事件表齐全', () => {
  assert.equal(SESSION_ID_PREFIX, 'cx-');
  assert.equal(MAX_CONTEXT_BYTES, 9500);
  assert.deepEqual(Object.keys(EVENT_NAMES).sort(), [
    'PostToolUse',
    'PreCompact',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
});
