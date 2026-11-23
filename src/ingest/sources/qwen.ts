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

import { ComemError } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type { IngestHarness, NormalizedMessage } from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { TreeLogSource, type TreeConversation, type TreeMessageNode } from './tree-source.js';

const QWEN_FILE_PREFIX = 'Qwen-chat-export-';
const QWEN_FILE_SUFFIX = '.json';

export interface QwenSourceOptions {
  /** 覆盖默认路径（`~/Downloads/Qwen-chat-export-*.json`）。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

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

function messageOf(node: QwenNode, startedAt: string | null): NormalizedMessage | null {
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
    createdAt: node.timestamp ?? startedAt,
    model: node.model,
    cwd: null,
  };
}

function conversationOf(value: unknown): TreeConversation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const chat = value['chat'];
  if (typeof id !== 'string' || !isRecord(chat)) {
    return null;
  }
  const raw = historyNodes(chat['history']);
  if (raw.size === 0) {
    return null;
  }

  let startedAt: string | null = null;
  for (const node of raw.values()) {
    if (node.timestamp !== null && (startedAt === null || node.timestamp < startedAt)) {
      startedAt = node.timestamp;
    }
  }

  const nodes = new Map<string, TreeMessageNode>();
  for (const node of raw.values()) {
    nodes.set(node.id, {
      id: node.id,
      parentId: node.parentId,
      childrenIds: node.childrenIds,
      message: messageOf(node, startedAt),
    });
  }

  const title = value['title'];
  return {
    id,
    title: typeof title === 'string' && title !== '' ? title : null,
    startedAt,
    nodes,
  };
}

export class QwenSource extends TreeLogSource {
  readonly harness: IngestHarness = 'qwen';
  protected readonly label = 'Qwen';

  constructor(options: QwenSourceOptions) {
    super(options);
  }

  protected matchesExportFile(name: string): boolean {
    return name.startsWith(QWEN_FILE_PREFIX) && name.endsWith(QWEN_FILE_SUFFIX);
  }

  protected conversationsOf(parsed: unknown, locator: string): readonly unknown[] {
    if (!isRecord(parsed) || !Array.isArray(parsed['data'])) {
      throw new ComemError('INVALID_ARGUMENT', `Qwen 导出文件缺少 data 数组：${locator}`, {
        locator,
      });
    }
    return parsed['data'];
  }

  protected toConversation(value: unknown): TreeConversation | null {
    return conversationOf(value);
  }
}
