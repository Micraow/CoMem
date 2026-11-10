/**
 * Claude Code 的 JSONL 日志（`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`）。
 *
 * 一个文件就是一个会话。每行是一个事件，`type` 区分 user / assistant / system /
 * attachment / file-history-snapshot 等；只有 user 与 assistant 是对话。
 *
 * ## 过滤规则（实测自真实导出）
 *
 * - `isSidechain === true`：子 agent 的旁支，不是用户与主 agent 的对话。
 * - `isMeta === true`：宿主合成的记录（如 `/skills` 被关掉时的提示）。
 * - `content` 是 block 数组时只取 `type === "text"`：`tool_use` / `tool_result` /
 *   `thinking` 都不是对话正文。取完为空（纯工具轮）就丢弃。
 *
 * `~/.claude/history.jsonl` 是命令历史（`display` / `pastedContents`），不是对话。
 * 它没有 `type` 字段，`describeSession` 因此返回 `null`，不会被导入。
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  IngestHarness,
  NormalizedMessage,
  SessionRef,
} from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { isRecord } from '../../domain/guards.js';
import { JsonlLogSource, readLines, walkFiles } from '../source.js';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
const JSONL_SUFFIX = '.jsonl';
const HISTORY_FILE_NAME = 'history.jsonl';

export interface ClaudeCodeSourceOptions {
  /** 覆盖默认根（`~/.claude/projects`）。空数组表示用默认值。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

function isConversationType(value: unknown): value is 'user' | 'assistant' {
  return value === 'user' || value === 'assistant';
}

/**
 * `content` 可以是字符串（用户直接输入）或 block 数组（assistant 的增量输出）。
 * 只保留 text block 的正文，多块按出现顺序拼接。
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part['type'] !== 'text') {
      continue;
    }
    const text = part['text'];
    if (typeof text === 'string') {
      texts.push(text);
    }
  }
  return texts.join('\n');
}

export class ClaudeCodeSource extends JsonlLogSource {
  readonly harness: IngestHarness = 'claude-code';

  readonly #roots: readonly string[];

  constructor(options: ClaudeCodeSourceOptions) {
    super(options.logger);
    this.#roots = options.paths === undefined || options.paths.length === 0 ? [DEFAULT_ROOT] : options.paths;
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    for (const root of this.#roots) {
      for await (const path of walkFiles(root, (name) => name.endsWith(JSONL_SUFFIX) && name !== HISTORY_FILE_NAME)) {
        const ref = await this.#describeSession(path);
        if (ref !== null) {
          yield ref;
        }
      }
    }
  }

  protected parseLine(value: Record<string, unknown>): NormalizedMessage | null {
    if (!isConversationType(value['type'])) {
      return null;
    }
    if (value['isSidechain'] === true || value['isMeta'] === true) {
      return null;
    }
    const message = value['message'];
    if (!isRecord(message)) {
      return null;
    }
    const role = message['role'];
    if (role !== 'user' && role !== 'assistant') {
      return null;
    }
    const text = extractText(message['content']);
    if (text.trim() === '') {
      return null;
    }

    return {
      role,
      text,
      createdAt: typeof value['timestamp'] === 'string' ? value['timestamp'] : null,
      model: typeof message['model'] === 'string' ? message['model'] : null,
      cwd: typeof value['cwd'] === 'string' ? value['cwd'] : null,
    };
  }

  /**
   * 从文件头部取会话身份与首条消息时间。
   *
   * 只读到「会话 ID 与首条消息都出现」为止：一个 844KB 的文件不需要为发现会话
   * 完整读一遍。读不到 ID 时退回文件名（Claude Code 的文件名就是 session uuid）。
   */
  async #describeSession(path: string): Promise<SessionRef | null> {
    let nativeSessionId: string | null = null;
    let startedAt: string | null = null;
    let sawConversation = false;

    for await (const line of readLines(path, 0)) {
      if (line.text.trim() === '') {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.text);
      } catch {
        // 发现阶段不计数：`readMessages` 会再遇到同一行并计入 `skippedLines`。
        continue;
      }
      if (!isRecord(value)) {
        continue;
      }
      if (nativeSessionId === null && typeof value['sessionId'] === 'string') {
        nativeSessionId = value['sessionId'];
      }
      if (!sawConversation && isConversationType(value['type'])) {
        sawConversation = true;
        if (typeof value['timestamp'] === 'string') {
          startedAt = value['timestamp'];
        }
      }
      if (nativeSessionId !== null && startedAt !== null) {
        break;
      }
    }

    if (!sawConversation) {
      return null;
    }
    const fallbackId = basename(path, JSONL_SUFFIX);
    return {
      harness: this.harness,
      nativeSessionId: nativeSessionId ?? fallbackId,
      locator: path,
      title: null,
      startedAt,
    };
  }
}
