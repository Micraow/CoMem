/**
 * DeepSeek 的会话导出（`~/Downloads/*\\/conversations.json`）。
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

import { ComemError } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type { IngestHarness, NormalizedMessage } from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { TreeLogSource, type TreeConversation, type TreeMessageNode } from './tree-source.js';

const CONVERSATIONS_FILE = 'conversations.json';

export interface DeepSeekSourceOptions {
  /** 覆盖默认路径（`~/Downloads/*\\/conversations.json`）。 */
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

function messageOf(
  value: Record<string, unknown>,
  fallbackCreatedAt: string | null,
): NormalizedMessage | null {
  const fromFragments = textFromFragments(value['fragments']);
  const role = fromFragments?.role ?? value['role'];
  const text = fromFragments?.text ?? textFromContentParts(value['content']);
  if ((role !== 'user' && role !== 'assistant') || text.trim() === '') {
    return null;
  }

  const insertedAt = value['inserted_at'];
  return {
    role,
    text,
    createdAt: typeof insertedAt === 'string' ? insertedAt : fallbackCreatedAt,
    model: typeof value['model'] === 'string' ? value['model'] : null,
    cwd: null,
  };
}

function toNode(
  id: string,
  value: unknown,
  fallbackCreatedAt: string | null,
): TreeMessageNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const parent = value['parent'];
  const children = value['children'];
  const message = value['message'];
  return {
    id,
    parentId: typeof parent === 'string' ? parent : null,
    childrenIds: Array.isArray(children)
      ? children.filter((child): child is string => typeof child === 'string')
      : [],
    message: isRecord(message) ? messageOf(message, fallbackCreatedAt) : null,
  };
}

function conversationOf(value: unknown): TreeConversation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const mapping = value['mapping'];
  if (typeof id !== 'string' || !isRecord(mapping)) {
    return null;
  }

  const insertedAt = value['inserted_at'];
  const fallbackCreatedAt = typeof insertedAt === 'string' ? insertedAt : null;
  const nodes = new Map<string, TreeMessageNode>();
  for (const [nodeId, node] of Object.entries(mapping)) {
    const parsed = toNode(nodeId, node, fallbackCreatedAt);
    if (parsed !== null) {
      nodes.set(nodeId, parsed);
    }
  }

  const title = value['title'];
  return {
    id,
    title: typeof title === 'string' && title !== '' ? title : null,
    startedAt: fallbackCreatedAt,
    nodes,
  };
}

export class DeepSeekSource extends TreeLogSource {
  readonly harness: IngestHarness = 'deepseek';
  protected readonly label = 'DeepSeek';

  constructor(options: DeepSeekSourceOptions) {
    super(options);
  }

  protected matchesExportFile(name: string): boolean {
    return name === CONVERSATIONS_FILE;
  }

  protected conversationsOf(parsed: unknown, locator: string): readonly unknown[] {
    // 顶层不是数组说明这份导出不可用。静默返回 0 个会话会让「导入完了但什么都
    // 没发生」看起来像正常状态，所以这里明确抛错，由 `IngestService` 记进报告。
    if (!Array.isArray(parsed)) {
      throw new ComemError('INVALID_ARGUMENT', `DeepSeek 导出文件的顶层不是数组：${locator}`, {
        locator,
      });
    }
    return parsed;
  }

  protected toConversation(value: unknown): TreeConversation | null {
    return conversationOf(value);
  }
}
