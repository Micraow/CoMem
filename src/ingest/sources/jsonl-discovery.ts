/**
 * 逐行日志的发现阶段
 */

import { basename } from 'node:path';

import type { SessionRef } from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { isRecord } from '../../domain/guards.js';
import { JsonlLogSource, readLines, walkFiles } from '../source.js';

export interface JsonlSourceOptions {
  /** 覆盖默认根。空数组表示用默认值。 */
  readonly paths?: readonly string[];
  readonly logger: Logger;
}

/**
 * `content` 是字符串就直接用，是 block 数组就只拼 `accepts` 认可的块，块间用换行。
 * `content` 为空值或其它形状时返回空串。
 */
export function joinTextBlocks(
  content: unknown,
  accepts: (part: Record<string, unknown>) => boolean,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && accepts(part) && typeof part['text'] === 'string') {
      texts.push(part['text']);
    }
  }
  return texts.join('\n');
}

export abstract class JsonlDiscoverySource extends JsonlLogSource {
  readonly #paths: readonly string[] | undefined;

  constructor(options: JsonlSourceOptions) {
    super(options.logger);
    this.#paths = options.paths;
  }

  /** 没有配置 `paths` 时的默认根。 */
  protected abstract defaultRoot(): string;

  /** 文件名是否属于这个源的会话日志。 */
  protected abstract matchesLogFile(name: string): boolean;

  /** 头部是否已经够判定会话；够了就不再往下读。 */
  protected abstract headComplete(head: readonly Record<string, unknown>[]): boolean;

  /** 头部记录 → `SessionRef`；`null` 表示这个文件不是会话。 */
  protected abstract inspectHead(
    path: string,
    head: readonly Record<string, unknown>[],
  ): SessionRef | null;

  /** 读不到会话 ID 时的兜底：去掉 `.jsonl` 的文件名。 */
  protected fallbackSessionId(path: string): string {
    return basename(path, '.jsonl');
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    const roots =
      this.#paths === undefined || this.#paths.length === 0 ? [this.defaultRoot()] : this.#paths;
    for (const root of roots) {
      for await (const path of walkFiles(root, (name) => this.matchesLogFile(name))) {
        const ref = await this.#describeSession(path);
        if (ref !== null) {
          yield ref;
        }
      }
    }
  }

  async #describeSession(path: string): Promise<SessionRef | null> {
    const head: Record<string, unknown>[] = [];
    for await (const line of readLines(path, 0)) {
      if (line.text.trim() === '') {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.text);
      } catch {
        continue;
      }
      if (!isRecord(value)) {
        continue;
      }
      head.push(value);
      if (this.headComplete(head)) {
        break;
      }
    }
    return this.inspectHead(path, head);
  }
}
