/**
 * `PreToolUse`：拦住把 `comem://` 当本地路径的文件工具调用（架构文档 §15.2）。
 *
 * 拦截必须是「给下一步」，不是「不允许」——否则模型只会换一个错误的路径重试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatOutput, normalizeEvent } from '../hosts/claude-code.mjs';
import { handlePreToolUse } from '../servers/pre-tool-use.mjs';

function toolEvent(toolName, filePath) {
  return { toolName, filePath };
}

test('Read 读 comem:// 路径被拦，理由指向 MCP 工具', () => {
  const result = handlePreToolUse(toolEvent('Read', 'comem://user/alice/memories/profile.md'));
  assert.ok(result?.deny);
  assert.match(result.deny, /不是本地路径/);
  assert.match(result.deny, /MCP 工具 read/);
  assert.match(result.deny, /参数 uri=comem:\/\/user\/alice\/memories\/profile\.md/);
});

test('Write / Edit 各自指回对应的 MCP 工具', () => {
  assert.match(handlePreToolUse(toolEvent('Write', 'comem://user/alice/a.md')).deny, /MCP 工具 write/);
  assert.match(handlePreToolUse(toolEvent('Edit', 'comem://user/alice/a.md')).deny, /MCP 工具 edit/);
});

test('普通路径放行', () => {
  assert.equal(handlePreToolUse(toolEvent('Read', '/home/alice/notes.md')), undefined);
  assert.equal(handlePreToolUse(toolEvent('Write', 'src/foo.ts')), undefined);
  assert.equal(handlePreToolUse(toolEvent('Edit', 'file:///tmp/a.ts')), undefined);
});

test('没有路径参数的调用放行', () => {
  assert.equal(handlePreToolUse(toolEvent('Read', null)), undefined);
});

test('非文件工具放行（Bash 的参数不是路径）', () => {
  assert.equal(handlePreToolUse(toolEvent('Bash', 'comem://user/alice/a.md')), undefined);
  assert.equal(handlePreToolUse(toolEvent('Grep', 'comem://user/alice/a.md')), undefined);
});

test('宿主信封：拒绝用 permissionDecision=deny', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/repo',
    tool_name: 'Read',
    tool_use_id: 'tool-1',
    tool_input: { file_path: 'comem://user/alice/memories/profile.md' },
  });
  assert.equal(event.filePath, 'comem://user/alice/memories/profile.md');
  assert.equal(event.eventId, 'PreToolUse:tool-1');

  const output = formatOutput(event, handlePreToolUse(event));
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /MCP 工具 read/);
});

test('宿主信封：放行时不写 stdout', () => {
  const event = normalizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/repo',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/a.ts' },
  });
  assert.equal(formatOutput(event, handlePreToolUse(event)), null);
});

test('会话 ID 带 cc- 前缀（§15.5）', () => {
  const event = normalizeEvent({ hook_event_name: 'Stop', session_id: '7f3a', cwd: '/repo' });
  assert.equal(event.sessionId, 'cc-7f3a');
});

test('未知事件抛错，不静默放过', () => {
  assert.throws(() => normalizeEvent({ hook_event_name: 'Notification', session_id: 's1' }), /未支持/);
});
