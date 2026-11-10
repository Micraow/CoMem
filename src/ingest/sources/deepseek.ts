/**
 * DeepSeek 的会话导出（`~/Downloads/*\/conversations.json`）。
 *
 * 文件是一个 JSON 数组，每个会话里 `mapping` 是**树**（`parent` / `children`），
 * 不是线性数组——导出时编辑、重新生成分支都会留下兄弟节点。
 *
 * ## 实测到的 message 形状（与任务草图不同）
 *
 * 真实导出里 `message` 的形状是：
 *
 * ```json
 * {"model":"deepseek-chat","inserted_at":"…","fragments":[
 *   {"type":"REQUEST","content":"用户说的话"},
 *   {"type":"THINK","content":"…"},
 *   {"type":"RESPONSE","content":"模型回答"}]}
 * ```
 *
 * 不是 ChatGPT 式的 `{"role": "...", "content": {"parts": [...]}}`。两种都认：
 * `fragments` 优先，没有 `fragments` 时退回 `content.parts`（旧版导出）。
 *
 * ## 树怎么展开
 *
 * 取**第一条子分支**（`children[0]`）。分支是编辑 / 重新生成的产物，它们共享
 * 同一段前缀；把每个叶子都导一遍会让同一句话在库里出现 N 次。选择第一条是
 * 确定性的，重跑得到同一份结果。
 *
 * 只有 `REQUEST`（用户）与 `RESPONSE`（assistant）是对话；`THINK`、
 * `TOOL_OPEN`、`TOOL_SEARCH`、`TOOL_FIND`、`FILE`、`SEARCH` 都不是正文。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ComemError, errorMessage } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type {
  CursorKind,
  IngestCursor,
  IngestHarness,
  NormalizedMessage,
  SessionRef,
} from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import {
  parseJsonDocument,
  walkFiles,
  type LogSource,
  type ReadMessagesResult,
  type SourceFileError,
} from '../source.js';

const DOWNLOADS = join(homedir(), 'Downloads');
const CONVERSATIONS_FILE = 'conversations.json';

interface DeepSeekNode {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly message: Record<string, unknown> | null;
}

interface DeepSeekConversation {
  readonly id: string;
  readonly title: string | null;
  readonly insertedAt: string | null;
  readonly mapping: ReadonlyMap<string, DeepSeekNode>;
}

export interface DeepSeekSourceOptions {
  /** 覆盖默认路径（`~/Downloads/*\/conversations.json`）。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 从 `fragments` 取正文；同一角色可能有多段，按出现顺序拼接。 */
function textFromFragments(fragments: unknown): { role: 'user' | 'assistant'; text: string } | null {
  if (!Array.isArray(fragments)) {
    return null;
  }
  const requests: string[] = [];
  const responses: string[] = [];
  for (const fragment of fragments) {
    if (!isRecord(fragment)) {
      continue;
    }
    const text = textOf(fragment['content']);
    if (text === '') {
      continue;
    }
    if (fragment['type'] === 'REQUEST') {
      requests.push(text);
    } else if (fragment['type'] === 'RESPONSE') {
      responses.push(text);
    }
  }
  // 一个 message 里同时出现 REQUEST 与 RESPONSE 不是正常导出；优先 RESPONSE
  // （assistant 的可见回答），避免把两条不同角色的正文拼在一起。
  if (responses.length > 0) {
    return { role: 'assistant', text: responses.join('\n') };
  }
  if (requests.length > 0) {
    return { role: 'user', text: requests.join('\n') };
  }
  return null;
}

/** 任务草图描述的 `content.parts` 形状（旧版导出）。只取字符串 part。 */
function textFromContentParts(content: unknown): string {
  if (!isRecord(content)) {
    return '';
  }
  const parts = content['parts'];
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts.filter((part): part is string => typeof part === 'string').join('\n');
}

function toNode(id: string, value: unknown): DeepSeekNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const parent = value['parent'];
  const children = value['children'];
  const message = value['message'];
  return {
    id,
    parent: typeof parent === 'string' ? parent : null,
    children: Array.isArray(children)
      ? children.filter((child): child is string => typeof child === 'string')
      : [],
    message: isRecord(message) ? message : null,
  };
}

function toConversation(value: unknown): DeepSeekConversation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const mapping = value['mapping'];
  if (typeof id !== 'string' || !isRecord(mapping)) {
    return null;
  }
  const nodes = new Map<string, DeepSeekNode>();
  for (const [nodeId, node] of Object.entries(mapping)) {
    const parsed = toNode(nodeId, node);
    if (parsed !== null) {
      nodes.set(nodeId, parsed);
    }
  }
  const title = value['title'];
  const insertedAt = value['inserted_at'];
  return {
    id,
    title: typeof title === 'string' && title !== '' ? title : null,
    insertedAt: typeof insertedAt === 'string' ? insertedAt : null,
    mapping: nodes,
  };
}

/**
 * 从根沿 `children[0]` 走到叶子。没有根（`parent` 全非空、数据损坏）时返回空。
 * 环用 `visited` 兜底：损坏的导出不该让导入进程转不出来。
 */
function linearPath(mapping: ReadonlyMap<string, DeepSeekNode>): readonly string[] {
  const root = [...mapping.values()].find((node) => node.parent === null);
  if (root === undefined) {
    return [];
  }

  const path: string[] = [];
  const visited = new Set<string>();
  let current: DeepSeekNode | undefined = root;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current.id);
    const nextId: string | undefined = current.children[0];
    current = nextId === undefined ? undefined : mapping.get(nextId);
  }
  return path;
}

function messageOf(
  node: DeepSeekNode,
  conversation: DeepSeekConversation,
): NormalizedMessage | null {
  const message = node.message;
  if (message === null) {
    return null;
  }

  const fromFragments = textFromFragments(message['fragments']);
  const role = fromFragments?.role ?? message['role'];
  const text = fromFragments?.text ?? textFromContentParts(message['content']);
  if ((role !== 'user' && role !== 'assistant') || text.trim() === '') {
    return null;
  }

  const insertedAt = message['inserted_at'];
  return {
    role,
    text,
    createdAt:
      typeof insertedAt === 'string'
        ? insertedAt
        : conversation.insertedAt,
    model: typeof message['model'] === 'string' ? message['model'] : null,
    cwd: null,
  };
}

export class DeepSeekSource implements LogSource {
  readonly harness: IngestHarness = 'deepseek';
  readonly cursorKind: CursorKind = 'tree_node';

  readonly #paths: readonly string[] | null;
  readonly #logger: Logger;
  /** 当前文件解析后的会话。按 locator 缓存：一个 32MB 文件只解析一次。 */
  readonly #documents = new Map<string, readonly DeepSeekConversation[]>();
  readonly #fileErrors: SourceFileError[] = [];

  constructor(options: DeepSeekSourceOptions) {
    this.#paths = options.paths === undefined || options.paths.length === 0 ? null : options.paths;
    this.#logger = options.logger;
  }

  get fileErrors(): readonly SourceFileError[] {
    return this.#fileErrors;
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    for (const locator of await this.#locators()) {
      let conversations: readonly DeepSeekConversation[];
      try {
        conversations = await this.#load(locator);
      } catch (error) {
        // 一份损坏的导出不该让同来源的其它文件也导不进来。跳过并记进报告。
        const message = errorMessage(error);
        this.#fileErrors.push({ locator, message });
        this.#logger.error('跳过无法解析的 DeepSeek 导出文件', { locator, reason: message });
        continue;
      }
      for (const conversation of conversations) {
        yield {
          harness: this.harness,
          nativeSessionId: conversation.id,
          locator,
          title: conversation.title,
          startedAt: conversation.insertedAt,
        };
      }
    }
    // 发现结束后不再需要整份文档：908 个会话全留在内存里只会占着堆。
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

    const path = linearPath(conversation.mapping);
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
      const node = conversation.mapping.get(nodeId);
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
    // 真实导出在 `~/Downloads/AI对话/deepseek_data-…/conversations.json`——比任务
    // 草图多一层。递归找同名文件，比写死一级目录稳。
    const locators: string[] = [];
    for await (const path of walkFiles(DOWNLOADS, (name) => name === CONVERSATIONS_FILE)) {
      locators.push(path);
    }
    return locators;
  }

  async #load(locator: string): Promise<readonly DeepSeekConversation[]> {
    const cached = this.#documents.get(locator);
    if (cached !== undefined) {
      return cached;
    }

    let raw: string;
    try {
      raw = await readFile(locator, 'utf8');
    } catch (error) {
      throw new ComemError('NOT_FOUND', `读不到 DeepSeek 导出文件：${locator}`, {
        locator,
        reason: errorMessage(error),
      });
    }

    const parsed = parseJsonDocument(raw, locator);
    if (parsed.repaired) {
      this.#logger.warn('DeepSeek 导出文件的脱敏伪影已按 0 修复', { locator });
    }
    if (!Array.isArray(parsed.value)) {
      throw new ComemError('INVALID_ARGUMENT', `DeepSeek 导出文件的顶层不是数组：${locator}`, {
        locator,
      });
    }

    const conversations: DeepSeekConversation[] = [];
    for (const value of parsed.value) {
      const conversation = toConversation(value);
      if (conversation === null) {
        this.#logger.warn('跳过无法解析的 DeepSeek 会话', { locator });
        continue;
      }
      conversations.push(conversation);
    }
    this.#documents.set(locator, conversations);
    return conversations;
  }
}
