/**
 * `remember`：把一段对话送进提交管线（架构文档 §13.2、§10.1）。
 *
 * **不另写一条记忆写入路径**：造一个合成会话，把消息追加进去，再走阶段一归档。
 * 抽取（阶段二）在后台任务里跑，工具立刻返回 `taskId`——抽取一次几秒到几十秒，
 * 阻塞等它等于把模型调用绑在用户输入上。
 */

import { randomUUID } from 'node:crypto';

import { ComemError } from '../../../domain/errors.js';
import type { MessageRole } from '../../../domain/session.js';
import type { Uri } from '../../../domain/uri.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  assertSubjectScope,
  nonEmptyString,
  recordArray,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'system', 'tool'];

/** §12.1：write = 3。合成会话写在个人根下，需要写权限。 */
const WRITE = 3;

function requireRole(message: Record<string, unknown>, index: number): MessageRole {
  const value = message['role'];
  if (typeof value !== 'string' || !ROLES.includes(value as MessageRole)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `remember 的 messages[${index}].role 只能是 ${ROLES.join(' / ')}。`,
      { tool: 'remember', index },
    );
  }
  return value as MessageRole;
}

async function appendMessages(
  context: McpToolContext,
  sessionUri: Uri,
  messages: readonly Record<string, unknown>[],
): Promise<void> {
  for (const [index, message] of messages.entries()) {
    await context.session.addMessage(sessionUri, {
      id: randomUUID(),
      role: requireRole(message, index),
      parts: [
        { kind: 'text', text: nonEmptyString(message, 'content', 'remember') },
      ],
      createdAt: new Date().toISOString(),
    });
  }
}

export const rememberTool: McpToolDefinition = {
  name: 'remember',
  kind: 'write',
  description:
    '需要把一段重要对话主动存进记忆时用这个；它返回的是 taskId，抽取在后台进行，不要立刻去 find 查结果。messages 里每条都要 role 与 content，role 只能是 user / assistant / system / tool。默认写进当前用户的个人空间，不能指定别人的根。',
  inputSchema: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ROLES },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
        },
        description: '按时间顺序排列的消息',
      },
    },
    required: ['messages'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'remember');
    const messages = recordArray(args, 'messages', 'remember');
    const scope = await assertSubjectScope(context, WRITE);

    const sessionUri = await context.session.create(scope);
    await appendMessages(context, sessionUri, messages);
    const result = await context.session.commitPhase1(sessionUri);

    context.logger.info('MCP remember 已归档', {
      requestId: context.requestId,
      sessionUri: sessionUri.toString(),
      taskId: result.taskId,
      archivedCount: result.archivedCount,
    });
    return textResult(
      `taskId: ${result.taskId}\nArchived ${result.archivedCount} message(s) in ${sessionUri.toString()}. Extraction is running in the background.`,
    );
  },
};
