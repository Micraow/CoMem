/**
 * `messages.jsonl` 的序列化、解析与文本渲染。
 *
 * 消息 ID、token 估算都从这里出：`stableMessageId` 仍由门面 re-export，调用方路径不变。
 */

import { createHash } from 'node:crypto';

import type { ContentStore } from '../../adapters/fs/content-store.js';
import { ComemError } from '../../domain/errors.js';
import type { ContentPart, MessageRole, SessionMessage } from '../../domain/session.js';
import { estimateTokens, renderMessageText } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

/**
 * 稳定消息 ID 的分隔符。
 *
 * 用 NUL：它不会出现在角色名或 ISO 时间串里，正文里出现同样的字符也不会让
 * `("ab", "c")` 与 `("a", "bc")` 拼出同一个摘要。
 */
const MESSAGE_ID_SEPARATOR = '\u0000';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is SessionMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

/** 磁盘上的 `messages.jsonl` 是本模块自己写的；内容不合法说明数据被改坏了，是程序缺陷。 */
export function corruptDocument(uri: Uri, reason: string): ComemError {
  return new ComemError('INTERNAL', `会话文件内容不合法：${uri.toString()}（${reason}）`, {
    uri: uri.toString(),
    reason,
  });
}

function toSessionMessage(value: unknown, uri: Uri): SessionMessage {
  if (!isRecord(value)) {
    throw corruptDocument(uri, '消息不是对象');
  }
  const id = value['id'];
  const role = value['role'];
  const parts = value['parts'];
  const createdAt = value['createdAt'];
  const turn = value['turn'];
  if (typeof id !== 'string' || typeof createdAt !== 'string') {
    throw corruptDocument(uri, '消息的 id / createdAt 不是字符串');
  }
  if (!isMessageRole(role)) {
    throw corruptDocument(uri, '消息的 role 不是合法角色');
  }
  if (!Array.isArray(parts)) {
    throw corruptDocument(uri, '消息的 parts 不是数组');
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    throw corruptDocument(uri, '消息的 turn 不是正整数');
  }
  // `parts` 是判别联合，逐项校验等于把领域定义抄一遍；写入侧只接受 `SessionMessage`，
  // 这里确认它是数组即可（§4.2 不鼓励在服务层重写领域校验）。
  return { id, role, parts: parts as readonly ContentPart[], createdAt, turn };
}

/** 一条消息一行（JSONL，§6.5）。空会话是空文件，不是 `[]`。 */
export function serializeMessages(messages: readonly SessionMessage[]): string {
  if (messages.length === 0) {
    return '';
  }
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

function parseMessages(raw: string, uri: Uri): readonly SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw corruptDocument(uri, 'messages.jsonl 有一行不是合法 JSON');
    }
    messages.push(toSessionMessage(value, uri));
  }
  return messages;
}

/** 未提交的估算 token 数（§10.2.1 的阈值判断用）。 */
export function sumTokens(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(renderMessageText(message));
  }
  return total;
}

/**
 * 消息的稳定 ID：`sha256(role + \0 + text + \0 + createdAt)`。
 *
 * **这是唯一实现**：`remember`（`api/mcp/tools/remember.ts`）与 `ingest`
 * （`services/ingest.ts`）都直接 import 它，不在各自文件里重算。服务端去重按 ID
 * 判等，两份实现各写一遍时公式一漂，两边写进去的消息就互相看不见对方的去重。
 *
 * 为什么放在服务层而不是 `domain/session.ts`：它是纯函数，规则上属于领域，但
 * sha256 要用 `node:crypto`，而 `domain/` 的 lint 规则禁止任何 `node:*` import
 * （`eslint.config.js` 的 `DOMAIN_MESSAGE`）。为一个函数在 `services/` 单开模块
 * 也没必要——本模块是权威实现，调用方与 `stableMessageId` 的既有 import 路径
 * （门面 `services/session.ts`）不变。
 *
 * 为什么要稳定 ID：游标只在消息落盘之后前进，进程死在「写完消息、游标没写」之间
 * 时重跑会从同一个游标再读一遍。ID 每次随机时服务端没有任何判据能认出「这条已经
 * 落过盘」，只能整批重复追加。有了稳定 ID，调用方按「会话已有的 ID」去重即可。
 *
 * **`createdAt` 是幂等键的一部分**：源日志没有时间戳时调用方只能填当前时刻，
 * 重跑会得到不同的 ID，去重失效。这是已知窗口，写进 §18「并发控制」。
 * `remember.ts` 的 `createdAtOf` 就保留这个行为（缺省取当前时刻），不在这里兜。
 *
 * 分隔符用 NUL：它不出现在角色名或 ISO 时间串里，正文里出现同样的字符也不会让
 * `("ab", "c")` 与 `("a", "bc")` 拼出同一个摘要。
 */
export function stableMessageId(
  role: MessageRole,
  text: string,
  createdAt: string,
): string {
  return createHash('sha256').update([role, text, createdAt].join(MESSAGE_ID_SEPARATOR)).digest('hex');
}

export async function readMessages(
  store: ContentStore,
  messagesUri: Uri,
): Promise<readonly SessionMessage[]> {
  const document = await store.readText(messagesUri);
  return parseMessages(document.text, messagesUri);
}
