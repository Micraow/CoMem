/**
 * `remember`：把一段对话送进提交管线（架构文档 §13.2、§10.1、§11.9）。
 *
 * **不另写一条记忆写入路径**：造一个合成会话，把消息追加进去，再走阶段一归档。
 * 抽取（阶段二）在后台任务里跑，工具立刻返回 `taskId`——抽取一次几秒到几十秒，
 * 阻塞等它等于把模型调用绑在用户输入上。
 *
 * ## `sessionId` 让上传幂等
 *
 * 不传 `sessionId` 时每次调用建一个新会话（随机 ID），这是「把当前这段对话存一下」
 * 的语义。批量上传本机历史会话时必须传：同一份日志重跑要落回**同一个**会话，
 * 否则 908 个会话重跑一次就变成 1,816 个。
 *
 * 幂等靠**稳定消息 ID**：直接调服务层的 `stableMessageId`（`services/session.ts`），
 * 不在本文件重算。服务端去重按 ID 判等，`remember` 与 `ingest` 各算一份时公式一漂
 * 就互相看不见对方的去重。追加前先收集会话已有的消息 ID（live + 归档），命中就跳过。
 * 所以调用方必须把源日志里的 `createdAt` 原样传进来——不传时用当前时刻，重跑会得到
 * 不同的 ID，无法去重。
 *
 * **顺序去重是「同一批消息」语义。** 并发两个同 `sessionId` 的调用没有跨请求的锁，
 * 去重是「读现有 → 追加」两步，可能各追加一份。批量导入是单协程顺序调用，不受
 * 影响；要支持并发导入需要在会话层加一把跨消息的锁。
 */

import { randomUUID } from 'node:crypto';

import { ComemError } from '../../../domain/errors.js';
import type { MessageRole } from '../../../domain/session.js';
import type { Uri } from '../../../domain/uri.js';
import { stableMessageId } from '../../../services/session.js';
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

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function requireRole(message: Record<string, unknown>, index: number): MessageRole {
  const value = message['role'];
  if (typeof value !== 'string' || !ROLES.includes(value as MessageRole)) {
    throw invalidArgument(`remember 的 messages[${index}].role 只能是 ${ROLES.join(' / ')}。`, {
      tool: 'remember',
      index,
    });
  }
  return value as MessageRole;
}

/** 源日志的时间戳（ISO 8601）；不传时用当前时刻。它是幂等键的一部分。 */
function createdAtOf(message: Record<string, unknown>, index: number): string {
  const value = message['createdAt'];
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalidArgument(
      `remember 的 messages[${index}].createdAt 必须是 ISO 8601 时间串。`,
      { tool: 'remember', index },
    );
  }
  return value;
}

function optionalSessionId(input: Record<string, unknown>): string | undefined {
  const value = input['sessionId'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw invalidArgument('remember 的 sessionId 必须是非空字符串。', {
      tool: 'remember',
      field: 'sessionId',
    });
  }
  return value;
}

/**
 * 会话里已经有的消息 ID：live 与所有归档。
 *
 * 只读 live 不够——第一次上传提交之后消息已经移进 `history/archive_NNN/`，live 是
 * 空的，重跑会把整段对话再追加一遍。归档元数据里有 `archivedMessageIds`，不用重新
 * 解析 `messages.jsonl`。
 */
async function knownMessageIds(
  context: McpToolContext,
  sessionUri: Uri,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const session = await context.session.load(sessionUri);
  for (const message of session.messages) {
    ids.add(message.id);
  }
  for (const archiveUri of await context.session.listArchives(sessionUri)) {
    const meta = await context.session.readArchiveMeta(archiveUri);
    for (const id of meta?.phase1.archivedMessageIds ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

interface ParsedMessage {
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: string;
  readonly id: string;
}

/**
 * 先校验整个批次再写。
 *
 * 一条一条「边校验边追加」时，第 3 条非法会留下前 2 条半成品——调用方重试整批，
 * 前 2 条靠稳定 ID 被跳过，但「这批失败了」的表象与磁盘状态不一致。整批先解析，
 * 任何一条不合法都不写。
 */
function parseMessages(
  messages: readonly Record<string, unknown>[],
  stableIds: boolean,
): readonly ParsedMessage[] {
  return messages.map((message, index) => {
    const role = requireRole(message, index);
    const text = nonEmptyString(message, 'content', 'remember');
    const createdAt = createdAtOf(message, index);
    return {
      role,
      text,
      createdAt,
      id: stableIds ? stableMessageId(role, text, createdAt) : randomUUID(),
    };
  });
}

/** 追加消息，跳过 `known` 里已有的 ID。返回真正追加的条数。 */
async function appendMessages(
  context: McpToolContext,
  sessionUri: Uri,
  messages: readonly ParsedMessage[],
  known: ReadonlySet<string>,
): Promise<number> {
  let appended = 0;
  for (const message of messages) {
    if (known.has(message.id)) {
      continue;
    }
    await context.session.addMessage(sessionUri, {
      id: message.id,
      role: message.role,
      parts: [{ kind: 'text', text: message.text }],
      createdAt: message.createdAt,
    });
    appended += 1;
  }
  return appended;
}

export const rememberTool: McpToolDefinition = {
  name: 'remember',
  kind: 'write',
  description:
    '把一段对话交给提交管线，抽取在后台跑，立刻返回 taskId——不要马上 find 查结果。用户说「记住这个」、或出现跨会话的持久偏好 / 决定 / 踩坑结论时用；闲聊与临时状态不要存。每条消息必须有 role（user / assistant / system / tool）与非空 content。批量导入历史会话时传 sessionId 并给每条带源 createdAt，重跑幂等；不传则每次新建随机会话。只能写当前用户个人根。',
  inputSchema: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ROLES, description: '消息角色；只能是 user / assistant / system / tool' },
            content: { type: 'string', description: '消息正文，不能为空串' },
            createdAt: {
              type: 'string',
              description: '源日志里的 ISO 8601 时间串；它是幂等键的一部分，重跑要去重就传',
            },
          },
          required: ['role', 'content'],
        },
        description: '按时间顺序排列的消息；至少一条，不能是空数组',
      },
      sessionId: {
        type: 'string',
        description:
          '调用方指定的稳定会话 ID（如 `<harness>-<native-id>`）。已存在就追加、不存在就创建；不传时每次新建随机 ID。',
      },
    },
    required: ['messages'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'remember');
    const messages = recordArray(args, 'messages', 'remember');
    const requestedSessionId = optionalSessionId(args);
    // 先校验整批：一条非法消息不应该留下前几条半成品。
    const parsed = parseMessages(messages, requestedSessionId !== undefined);
    const scope = await assertSubjectScope(context, WRITE);

    const sessionUri =
      requestedSessionId === undefined
        ? await context.session.create(scope, context.principals)
        : await context.session.ensure(scope, requestedSessionId, context.principals);
    const known =
      requestedSessionId === undefined
        ? new Set<string>()
        : await knownMessageIds(context, sessionUri);
    const appended = await appendMessages(context, sessionUri, parsed, known);

    // 没有新消息就是一次幂等重跑。live 里可能还有上一次崩溃留下的未提交消息，
    // 那种情况仍然要提交，否则它们永远停在 live 里。
    const live = await context.session.load(sessionUri);
    if (live.messages.length === 0) {
      context.logger.info('MCP remember 没有新消息，跳过提交', {
        requestId: context.requestId,
        sessionUri: sessionUri.toString(),
        appended,
      });
      return textResult(
        `taskId: none\nNo new message(s) in ${sessionUri.toString()}; nothing to archive.`,
      );
    }

    const result = await context.session.commitPhase1(sessionUri);

    context.logger.info('MCP remember 已归档', {
      requestId: context.requestId,
      sessionUri: sessionUri.toString(),
      taskId: result.taskId,
      archivedCount: result.archivedCount,
      appended,
    });
    return textResult(
      `taskId: ${result.taskId}\nArchived ${result.archivedCount} message(s) in ${sessionUri.toString()}. Extraction is running in the background.`,
    );
  },
};
