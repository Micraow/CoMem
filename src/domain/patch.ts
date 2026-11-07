/**
 * SEARCH/REPLACE 补丁块（架构文档 §11.2、§11.5）。
 *
 * 格式：
 *
 * ```
 * <<<<<<< SEARCH
 * 原文
 * =======
 * 替换文本
 * >>>>>>> REPLACE
 * ```
 *
 * 三条语义由架构文档固定：
 *
 * - SEARCH 必须**唯一命中**。零命中返回 `not_found`，多处命中返回 `ambiguous`，
 *   不做模糊匹配、不猜一个（§11.2）。猜错的代价是静默改坏一条记忆。
 * - 多块 patch 按顺序应用。第 2 条的 SEARCH 在第 1 条应用后的正文上匹配（§11.5）。
 * - 空 SEARCH 表示「插入到末尾」。多个空块按出现顺序依次追加。
 *
 * 换行处理：匹配前把 `\r\n` 归一化成 `\n`（正文与块体都归一化），输出统一使用
 * `\n`。这样同一段记忆从 Windows 客户端写入再从 Linux 读取不会因为换行不同而
 * 匹配失败。单独的 `\r`（旧 Mac 换行）不做归一化，避免改动正文里的其它控制字符。
 *
 * 格式边界：三个标记都必须**顶格**出现在行首，只忽略行尾空白。块内容里出现
 * `=======` 作为普通文本（例如 `const divider = '=======';` 或缩进后的 `  =======`）
 * 不会被误判为分隔符；但一整行恰好是 `=======` 时无法与分隔符区分，按格式约定
 * 视为分隔符。
 */

import { ComemError } from './errors.js';

export interface PatchBlock {
  readonly search: string;
  readonly replace: string;
}

export type PatchResult =
  | { readonly ok: true; readonly content: string; readonly appliedCount: number }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'ambiguous';
      readonly blockIndex: number;
      readonly matches: number;
    };

const SEARCH_MARKER = '<<<<<<< SEARCH';
const SEPARATOR_MARKER = '=======';
const REPLACE_MARKER = '>>>>>>> REPLACE';

/** 只归一化 CRLF；单独的 CR 保持原样。 */
function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function malformed(message: string): ComemError {
  return new ComemError('INVALID_ARGUMENT', `补丁格式不合法：${message}`, { reason: message });
}

/**
 * 解析补丁文本，提取所有 SEARCH/REPLACE 块。
 *
 * 块外的普通文本被忽略，方便模型在块前后附带说明。块不完整（缺分隔符、缺结束
 * 标记、块内又出现开始标记）时抛 `INVALID_ARGUMENT`——静默丢掉半截块会让抽取结果
 * 少写一条记忆，比报错更危险。
 */
export function parsePatchBlocks(text: string): PatchBlock[] {
  const lines = normalizeLineEndings(text).split('\n');
  const blocks: PatchBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trimEnd() !== SEARCH_MARKER) {
      index += 1;
      continue;
    }

    index += 1;
    const searchLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (current === undefined) {
        break;
      }
      const trimmed = current.trimEnd();
      if (trimmed === SEPARATOR_MARKER) {
        break;
      }
      if (trimmed === SEARCH_MARKER || trimmed === REPLACE_MARKER) {
        throw malformed('SEARCH 块缺少 ======= 分隔符');
      }
      searchLines.push(current);
      index += 1;
    }

    if (index >= lines.length || lines[index]?.trimEnd() !== SEPARATOR_MARKER) {
      throw malformed('SEARCH 块缺少 ======= 分隔符');
    }
    index += 1;

    const replaceLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (current === undefined) {
        break;
      }
      const trimmed = current.trimEnd();
      if (trimmed === REPLACE_MARKER) {
        break;
      }
      if (trimmed === SEARCH_MARKER) {
        throw malformed('SEARCH 块缺少 >>>>>>> REPLACE 结束标记');
      }
      replaceLines.push(current);
      index += 1;
    }

    if (index >= lines.length || lines[index]?.trimEnd() !== REPLACE_MARKER) {
      throw malformed('SEARCH 块缺少 >>>>>>> REPLACE 结束标记');
    }
    index += 1;

    blocks.push({
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n'),
    });
  }

  return blocks;
}

/** 统计 SEARCH 在正文里的命中次数。重叠命中也要算：`aaa` 里的 `aa` 有两个落点。 */
function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = content.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(search, index + 1);
  }
  return count;
}

/**
 * 空 SEARCH 的追加语义：插入到末尾。
 *
 * 正文非空且不以换行结尾时先补一个 `\n`，否则两段内容会粘成一行。追加内容为空
 * 时不改动正文（仍然算应用成功，保持 `appliedCount` 与块数一致）。
 */
function appendAtEnd(content: string, addition: string): string {
  if (content === '') {
    return addition;
  }
  if (addition === '') {
    return content;
  }
  return content.endsWith('\n') ? content + addition : `${content}\n${addition}`;
}

/**
 * 按顺序应用所有补丁块。
 *
 * 失败时返回第一个失败块的 `blockIndex` 和命中次数，不返回部分结果——调用方要么
 * 拿到完整的新正文，要么知道哪一条操作被跳过（§11.5 的 `skippedOperations`）。
 * 输入正文和块体都不会被修改。
 */
export function applyPatch(content: string, blocks: readonly PatchBlock[]): PatchResult {
  let next = normalizeLineEndings(content);

  for (const [blockIndex, block] of blocks.entries()) {
    const search = normalizeLineEndings(block.search);
    const replace = normalizeLineEndings(block.replace);

    if (search === '') {
      next = appendAtEnd(next, replace);
      continue;
    }

    const matches = countOccurrences(next, search);
    if (matches === 0) {
      return { ok: false, reason: 'not_found', blockIndex, matches };
    }
    if (matches > 1) {
      return { ok: false, reason: 'ambiguous', blockIndex, matches };
    }

    const matchIndex = next.indexOf(search);
    next = `${next.slice(0, matchIndex)}${replace}${next.slice(matchIndex + search.length)}`;
  }

  return { ok: true, content: next, appliedCount: blocks.length };
}
