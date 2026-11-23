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
 * 它没有 `type` 字段，`inspectHead` 因此返回 `null`，不会被导入。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { IngestHarness, NormalizedMessage, SessionRef } from '../../domain/ingest.js';

import { isRecord } from '../../domain/guards.js';
import { JsonlDiscoverySource, joinTextBlocks, type JsonlSourceOptions } from './jsonl-discovery.js';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
const JSONL_SUFFIX = '.jsonl';
const HISTORY_FILE_NAME = 'history.jsonl';

export type ClaudeCodeSourceOptions = JsonlSourceOptions;

function isConversationType(value: unknown): value is 'user' | 'assistant' {
  return value === 'user' || value === 'assistant';
}

export class ClaudeCodeSource extends JsonlDiscoverySource {
  readonly harness: IngestHarness = 'claude-code';

  protected defaultRoot(): string {
    return DEFAULT_ROOT;
  }

  protected matchesLogFile(name: string): boolean {
    return name.endsWith(JSONL_SUFFIX) && name !== HISTORY_FILE_NAME;
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
    const text = joinTextBlocks(message['content'], (part) => part['type'] === 'text');
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

  /** 会话 ID 与首条消息时间都出现就够了：一个 844KB 的文件不必为发现会话读完。 */
  protected headComplete(head: readonly Record<string, unknown>[]): boolean {
    return (
      head.some((value) => typeof value['sessionId'] === 'string') &&
      head.some(
        (value) => isConversationType(value['type']) && typeof value['timestamp'] === 'string',
      )
    );
  }

  protected inspectHead(
    path: string,
    head: readonly Record<string, unknown>[],
  ): SessionRef | null {
    let nativeSessionId: string | null = null;
    let startedAt: string | null = null;
    let sawConversation = false;

    for (const value of head) {
      if (nativeSessionId === null && typeof value['sessionId'] === 'string') {
        nativeSessionId = value['sessionId'];
      }
      if (!sawConversation && isConversationType(value['type'])) {
        sawConversation = true;
        if (typeof value['timestamp'] === 'string') {
          startedAt = value['timestamp'];
        }
      }
    }

    if (!sawConversation) {
      return null;
    }
    return {
      harness: this.harness,
      nativeSessionId: nativeSessionId ?? this.fallbackSessionId(path),
      locator: path,
      title: null,
      startedAt,
    };
  }
}
