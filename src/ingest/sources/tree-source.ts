import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ComemError, errorMessage } from '../../domain/errors.js';
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

/** 会话树里的一个节点。分支是编辑与重新生成的产物，由 `parentId` / `childrenIds` 描述。 */
export interface TreeMessageNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly childrenIds: readonly string[];
  /** 这一节点贡献的消息；不是对话正文的节点（思考、工具调用）为 `null`。 */
  readonly message: NormalizedMessage | null;
}

export interface TreeConversation {
  readonly id: string;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly nodes: ReadonlyMap<string, TreeMessageNode>;
}

export interface TreeLogSourceOptions {
  /** 覆盖默认路径；空数组等同未提供。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

/** 从根沿第一条子分支走到叶子；环用 visited 兜底。 */
function linearPath(nodes: ReadonlyMap<string, TreeMessageNode>): readonly string[] {
  const root = [...nodes.values()].find((node) => node.parentId === null);
  if (root === undefined) {
    return [];
  }
  const path: string[] = [];
  const visited = new Set<string>();
  let current: TreeMessageNode | undefined = root;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current.id);
    const nextId: string | undefined = current.childrenIds[0];
    current = nextId === undefined ? undefined : nodes.get(nextId);
  }
  return path;
}

/**
 * 整份 JSON 导出（树形会话）的基类。
 *
 * 子类只负责「顶层形状怎么校验」「一条会话怎么变成 `TreeConversation`」与
 * 「默认路径下哪些文件属于本来源」；文件查找、按 locator 缓存、`tree_node`
 * 游标与分支展开都在这里。
 */
export abstract class TreeLogSource implements LogSource {
  abstract readonly harness: IngestHarness;
  readonly cursorKind: CursorKind = 'tree_node';

  /** 日志与错误消息里的来源名。 */
  protected abstract readonly label: string;

  readonly #paths: readonly string[] | null;
  readonly #logger: Logger;
  /** 当前文件解析后的会话。按 locator 缓存：一个 32MB 文件只解析一次。 */
  readonly #documents = new Map<string, readonly TreeConversation[]>();
  readonly #fileErrors: SourceFileError[] = [];

  protected constructor(options: TreeLogSourceOptions) {
    this.#paths = options.paths === undefined || options.paths.length === 0 ? null : options.paths;
    this.#logger = options.logger;
  }

  protected get logger(): Logger {
    return this.#logger;
  }

  /** 默认路径下哪些文件名是本来源的导出。 */
  protected abstract matchesExportFile(name: string): boolean;

  /** 顶层形状校验，返回会话数组；形状不对时抛 `INVALID_ARGUMENT`。 */
  protected abstract conversationsOf(parsed: unknown, locator: string): readonly unknown[];

  protected abstract toConversation(value: unknown): TreeConversation | null;

  get fileErrors(): readonly SourceFileError[] {
    return this.#fileErrors;
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    for (const locator of await this.#locators()) {
      let conversations: readonly TreeConversation[];
      try {
        conversations = await this.#load(locator);
      } catch (error) {
        // 一份损坏的导出不该让同来源的其它文件也导不进来。跳过并记进报告，
        // 由用户在报告里看到「哪个文件被跳过了、为什么」。
        const message = errorMessage(error);
        this.#fileErrors.push({ locator, message });
        this.#logger.error(`跳过无法解析的 ${this.label} 导出文件`, { locator, reason: message });
        continue;
      }
      for (const conversation of conversations) {
        yield {
          harness: this.harness,
          nativeSessionId: conversation.id,
          locator,
          title: conversation.title,
          startedAt: conversation.startedAt,
        };
      }
    }
    // 发现结束后不再需要整份文档：上千个会话全留在内存里只会占着堆。
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
      if (node.message !== null) {
        messages.push(node.message);
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
    // 真实导出比任务草图多一层目录，递归找比写死层级稳。
    const locators: string[] = [];
    for await (const path of walkFiles(DOWNLOADS, (name) => this.matchesExportFile(name))) {
      locators.push(path);
    }
    return locators;
  }

  async #load(locator: string): Promise<readonly TreeConversation[]> {
    const cached = this.#documents.get(locator);
    if (cached !== undefined) {
      return cached;
    }

    let raw: string;
    try {
      raw = await readFile(locator, 'utf8');
    } catch (error) {
      throw new ComemError('NOT_FOUND', `读不到 ${this.label} 导出文件：${locator}`, {
        locator,
        reason: errorMessage(error),
      });
    }

    const parsed = parseJsonDocument(raw, locator);
    if (parsed.repaired) {
      this.#logger.warn(`${this.label} 导出文件的脱敏伪影已按 0 修复`, { locator });
    }

    const conversations: TreeConversation[] = [];
    for (const value of this.conversationsOf(parsed.value, locator)) {
      const conversation = this.toConversation(value);
      if (conversation === null) {
        this.#logger.warn(`跳过无法解析的 ${this.label} 会话`, { locator });
        continue;
      }
      conversations.push(conversation);
    }
    this.#documents.set(locator, conversations);
    return conversations;
  }
}
