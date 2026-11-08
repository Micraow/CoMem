/**
 * Qwen 的会话导出（`~/Downloads/Qwen-chat-export-*.json`）。
 *
 * 顶层是 `{success, request_id, data:[...]}`，每个会话的树在
 * `chat.history` 里。真实导出把消息放在 `chat.history.messages`（对象，键是
 * 节点 ID）；任务草图写的是 `chat.history` 直接就是那张对象。两种都认。
 *
 * ## 实测到的正文位置
 *
 * assistant 的 `content` 经常是空串，回答在 `content_list` 里
 * （`{phase: "answer", content: "..."}`）；`thinking_summary` / `web_search` /
 * `think` 等 phase 不是正文。只取 `phase === "answer"`。
 *
 * ## 损坏的文件要报错，不能静默跳过
 *
 * 本机这份 35MB 导出在 JSON 字符串里有一个未转义的引号（`"date": ""`），
 * `JSON.parse` 在第 166939 行失败。整份文件不可用——静默返回 0 个会话会让
 * 「导入完了但什么都没发生」看起来像正常状态。这里明确抛 `INVALID_ARGUMENT`，
 * 由 `IngestService` 记进报告。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ComemError } from '../../domain/errors.js';
import type {
  CursorKind,
  IngestCursor,
  IngestHarness,
  NormalizedMessage,
  SessionRef,
} from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { isRecord, walkFiles, type LogSource, type ReadMessagesResult } from '../source.js';

const DOWNLOADS = join(homedir(), 'Downloads');
const QWEN_FILE_PREFIX = 'Qwen-chat-export-';
const QWEN_FILE_SUFFIX = '.json';

interface QwenNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly childrenIds: readonly string[];
  readonly role: string | null;
  readonly content: unknown;
  readonly contentList: readonly Record<string, unknown>[];
  readonly timestamp: string | null;
  readonly model: string | null;
}

interface QwenConversation {
  readonly id: string;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly nodes: ReadonlyMap<string, QwenNode>;
}

export interface QwenSourceOptions {
  /** 覆盖默认路径（`~/Downloads/Qwen-chat-export-*.json`）。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

function isQwenFile(name: string): boolean {
  return name.startsWith(QWEN_FILE_PREFIX) && name.endsWith(QWEN_FILE_SUFFIX);
}

/** 时间戳可能是 epoch 秒（数字）或 ISO 字符串。 */
function toIso(value: unknown): string | null {
  if (typeof value === 'string') {
    return value === '' ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 导出里是秒；乘 1000 前先判断量级，避免把已经是毫秒的值再乘一次。
    // 1e12 是毫秒时间戳的量级分界（2001-09-09 的毫秒值），当前年份的秒值约 1.7e9，
    // 毫秒值约 1.7e12，两者相距三个数量级，不存在误判区间。
    const milliseconds = value < 1e12 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return null;
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join('\n');
  }
  return '';
}

/**
 * 正文：优先 `content`，为空时取 `content_list` 里 `phase === "answer"` 的段。
 *
 * 真实导出里 assistant 的 `content` 是空串，答案在 `content_list`；只看
 * `content` 会得到一份只有用户提问的会话。
 */
function textOf(node: QwenNode): string {
  const direct = stringContent(node.content);
  if (direct.trim() !== '') {
    return direct;
  }
  const answers: string[] = [];
  for (const item of node.contentList) {
    if (item['phase'] !== 'answer') {
      continue;
    }
    const text = stringContent(item['content']);
    if (text !== '') {
      answers.push(text);
    }
  }
  return answers.join('\n');
}

function toNode(id: string, value: unknown): QwenNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const children = value['childrenIds'];
  const contentList = value['content_list'];
  const role = value['role'];
  const model = value['model'] ?? value['modelName'];
  return {
    id,
    parentId: typeof value['parentId'] === 'string' ? value['parentId'] : null,
    childrenIds: Array.isArray(children)
      ? children.filter((child): child is string => typeof child === 'string')
      : [],
    role: typeof role === 'string' ? role : null,
    content: value['content'],
    contentList: Array.isArray(contentList)
      ? contentList.filter((item): item is Record<string, unknown> => isRecord(item))
      : [],
    timestamp: toIso(value['timestamp']),
    model: typeof model === 'string' ? model : null,
  };
}

function historyNodes(history: unknown): ReadonlyMap<string, QwenNode> {
  const nodes = new Map<string, QwenNode>();
  if (!isRecord(history)) {
    return nodes;
  }
  // 真实导出的形状是 `history.messages`；任务草图是 `history` 本身就是对象。
  const messages = isRecord(history['messages']) ? history['messages'] : history;
  for (const [id, value] of Object.entries(messages)) {
    if (id === 'currentId' || id === 'messages') {
      continue;
    }
    const node = toNode(id, value);
    if (node !== null) {
      nodes.set(id, node);
    }
  }
  return nodes;
}

function toConversation(value: unknown): QwenConversation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const chat = value['chat'];
  if (typeof id !== 'string' || !isRecord(chat)) {
    return null;
  }
  const nodes = historyNodes(chat['history']);
  if (nodes.size === 0) {
    return null;
  }

  let startedAt: string | null = null;
  for (const node of nodes.values()) {
    if (node.timestamp !== null && (startedAt === null || node.timestamp < startedAt)) {
      startedAt = node.timestamp;
    }
  }

  const title = value['title'];
  return {
    id,
    title: typeof title === 'string' && title !== '' ? title : null,
    startedAt,
    nodes,
  };
}

/** 从根沿 `childrenIds[0]` 走到叶子；环用 visited 兜底。 */
function linearPath(nodes: ReadonlyMap<string, QwenNode>): readonly string[] {
  const root = [...nodes.values()].find((node) => node.parentId === null);
  if (root === undefined) {
    return [];
  }
  const path: string[] = [];
  const visited = new Set<string>();
  let current: QwenNode | undefined = root;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current.id);
    const nextId: string | undefined = current.childrenIds[0];
    current = nextId === undefined ? undefined : nodes.get(nextId);
  }
  return path;
}

function messageOf(node: QwenNode, conversation: QwenConversation): NormalizedMessage | null {
  if (node.role !== 'user' && node.role !== 'assistant') {
    return null;
  }
  const text = textOf(node);
  if (text.trim() === '') {
    return null;
  }
  return {
    role: node.role,
    text,
    createdAt: node.timestamp ?? conversation.startedAt,
    model: node.model,
    cwd: null,
  };
}

export class QwenSource implements LogSource {
  readonly harness: IngestHarness = 'qwen';
  readonly cursorKind: CursorKind = 'tree_node';

  readonly #paths: readonly string[] | null;
  readonly #logger: Logger;
  readonly #documents = new Map<string, readonly QwenConversation[]>();

  constructor(options: QwenSourceOptions) {
    this.#paths = options.paths === undefined || options.paths.length === 0 ? null : options.paths;
    this.#logger = options.logger;
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    for (const locator of await this.#locators()) {
      for (const conversation of await this.#load(locator)) {
        yield {
          harness: this.harness,
          nativeSessionId: conversation.id,
          locator,
          title: conversation.title,
          startedAt: conversation.startedAt,
        };
      }
    }
    this.#documents.clear();
  }

  async readMessages(
    ref: SessionRef,
    cursor: IngestCursor | null,
    limit: number,
  ): Promise<ReadMessagesResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `每次读取的条数必须是正整数：${limit}`, {
        limit,
      });
    }
    if (cursor !== null && cursor.kind !== 'tree_node') {
      throw new ComemError('INVALID_ARGUMENT', `游标类型与源不匹配：${ref.locator}`, {
        locator: ref.locator,
        kind: cursor.kind,
      });
    }

    const conversation = (await this.#load(ref.locator)).find(
      (candidate) => candidate.id === ref.nativeSessionId,
    );
    if (conversation === undefined) {
      throw new ComemError('NOT_FOUND', `导出文件里找不到会话：${ref.nativeSessionId}`, {
        locator: ref.locator,
        nativeSessionId: ref.nativeSessionId,
      });
    }

    const path = linearPath(conversation.nodes);
    let index = 0;
    if (cursor !== null && cursor.value !== '') {
      const found = path.indexOf(cursor.value);
      if (found === -1) {
        throw new ComemError('INTERNAL', `游标指向的节点不在会话路径上：${cursor.value}`, {
          locator: ref.locator,
          nativeSessionId: ref.nativeSessionId,
          cursor: cursor.value,
        });
      }
      index = found + 1;
    }

    const messages: NormalizedMessage[] = [];
    let position = cursor?.value ?? '';
    while (index < path.length) {
      const nodeId = path[index];
      index += 1;
      if (nodeId === undefined) {
        break;
      }
      position = nodeId;
      const node = conversation.nodes.get(nodeId);
      if (node === undefined) {
        continue;
      }
      const message = messageOf(node, conversation);
      if (message !== null) {
        messages.push(message);
      }
      if (messages.length >= limit) {
        break;
      }
    }

    return { messages, cursor: { kind: 'tree_node', value: position } };
  }

  async #locators(): Promise<readonly string[]> {
    if (this.#paths !== null) {
      return this.#paths;
    }
    // 真实导出在 `~/Downloads/AI对话/Qwen-chat-export-*.json`——比任务草图多一层。
    const locators: string[] = [];
    for await (const path of walkFiles(DOWNLOADS, isQwenFile)) {
      locators.push(path);
    }
    return locators;
  }

  async #load(locator: string): Promise<readonly QwenConversation[]> {
    const cached = this.#documents.get(locator);
    if (cached !== undefined) {
      return cached;
    }

    let raw: string;
    try {
      raw = await readFile(locator, 'utf8');
    } catch (error) {
      throw new ComemError('NOT_FOUND', `读不到 Qwen 导出文件：${locator}`, {
        locator,
        reason: errorMessage(error),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `Qwen 导出文件不是合法 JSON：${locator}（${errorMessage(error)}）`,
        {
        locator,
        reason: errorMessage(error),
      });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['data'])) {
      throw new ComemError('INVALID_ARGUMENT', `Qwen 导出文件缺少 data 数组：${locator}`, {
        locator,
      });
    }

    const conversations: QwenConversation[] = [];
    for (const value of parsed['data']) {
      const conversation = toConversation(value);
      if (conversation === null) {
        this.#logger.warn('跳过无法解析的 Qwen 会话', { locator });
        continue;
      }
      conversations.push(conversation);
    }
    this.#documents.set(locator, conversations);
    return conversations;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
