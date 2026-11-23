/**
 * Codex 的 rollout JSONL（`~/.codex/sessions/**\/rollout-*.jsonl`）。
 *
 * 一个文件就是一个会话。每行 `type` 区分事件；对话正文在
 * `type === "response_item"` 且 `payload.type === "message"` 的行里：
 *
 * ```json
 * {"timestamp":"...","type":"response_item","payload":{
 *   "type":"message","role":"user|assistant",
 *   "content":[{"type":"input_text|output_text","text":"..."}]}}
 * ```
 *
 * ## 实测到的 payload.type
 *
 * `message`（对话）、`reasoning`（思维链）、`function_call` / `function_call_output`、
 * `custom_tool_call` / `custom_tool_call_output`。后五类都不是对话正文，丢弃。
 * `role` 还可能是 `developer`（系统提示），同样丢弃——它不是用户说的话。
 *
 * ## 为什么 cwd 存在实例字段里
 *
 * `cwd` 只在 `session_meta` / `turn_context` 行上，而 `NormalizedMessage` 是逐行的。
 * 发现会话时把 `session_meta` 的 cwd 记在 `#cwdByLocator`，`parseLine` 再按文件
 * 取回来。不这样做就得为每条消息重扫文件头。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { IngestHarness, NormalizedMessage, SessionRef } from '../../domain/ingest.js';

import { isRecord } from '../../domain/guards.js';
import { JsonlDiscoverySource, joinTextBlocks, type JsonlSourceOptions } from './jsonl-discovery.js';

const DEFAULT_ROOT = join(homedir(), '.codex', 'sessions');
const JSONL_SUFFIX = '.jsonl';
const ROLLOUT_PREFIX = 'rollout-';

export type CodexSourceOptions = JsonlSourceOptions;

export class CodexSource extends JsonlDiscoverySource {
  readonly harness: IngestHarness = 'codex';

  /** `locator` → `session_meta.payload.cwd`。发现会话时填充，`parseLine` 读取。 */
  readonly #cwdByLocator = new Map<string, string>();

  protected defaultRoot(): string {
    return DEFAULT_ROOT;
  }

  protected matchesLogFile(name: string): boolean {
    return name.startsWith(ROLLOUT_PREFIX) && name.endsWith(JSONL_SUFFIX);
  }

  protected parseLine(
    value: Record<string, unknown>,
    ref: SessionRef,
  ): NormalizedMessage | null {
    if (value['type'] !== 'response_item') {
      return null;
    }
    const payload = value['payload'];
    if (!isRecord(payload) || payload['type'] !== 'message') {
      return null;
    }
    const role = payload['role'];
    if (role !== 'user' && role !== 'assistant') {
      return null;
    }
    // `content` 的 block 里只有 `input_text` / `output_text` 是正文；
    // `input_image` 只存引用，正文里没有可导入的文本。
    const text = joinTextBlocks(
      payload['content'],
      (part) => part['type'] === 'input_text' || part['type'] === 'output_text',
    );
    if (text.trim() === '') {
      return null;
    }

    return {
      role,
      text,
      createdAt: typeof value['timestamp'] === 'string' ? value['timestamp'] : null,
      model: null,
      cwd: this.#cwdByLocator.get(ref.locator) ?? null,
    };
  }

  /**
   * `session_meta` 通常在首行。拿到它（或第一条 `response_item`）之后就不需要
   * 继续扫——发现阶段不读正文，一个 200MB 的 rollout 不该被完整读一遍。
   */
  protected headComplete(head: readonly Record<string, unknown>[]): boolean {
    return head.some(
      (value) => value['type'] === 'session_meta' || value['type'] === 'response_item',
    );
  }

  /**
   * 从 `session_meta` 取会话身份与 cwd。没有 `session_meta` 的文件（导出被截断、
   * 手工改过）退回文件名，仍然可导入——会话 ID 只要求「同一文件稳定」。
   */
  protected inspectHead(
    path: string,
    head: readonly Record<string, unknown>[],
  ): SessionRef | null {
    let nativeSessionId: string | null = null;
    let cwd: string | null = null;
    let startedAt: string | null = null;
    let sawSessionMeta = false;
    let sawResponseItem = false;

    for (const value of head) {
      if (value['type'] === 'session_meta') {
        sawSessionMeta = true;
        const payload = value['payload'];
        if (isRecord(payload)) {
          if (nativeSessionId === null && typeof payload['session_id'] === 'string') {
            nativeSessionId = payload['session_id'];
          }
          if (cwd === null && typeof payload['cwd'] === 'string') {
            cwd = payload['cwd'];
          }
        }
        if (startedAt === null && typeof value['timestamp'] === 'string') {
          startedAt = value['timestamp'];
        }
      }

      if (value['type'] === 'response_item') {
        sawResponseItem = true;
        if (startedAt === null && typeof value['timestamp'] === 'string') {
          startedAt = value['timestamp'];
        }
      }
    }

    if (!sawSessionMeta && !sawResponseItem) {
      return null;
    }
    if (cwd !== null) {
      this.#cwdByLocator.set(path, cwd);
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
