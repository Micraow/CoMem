/**
 * 补丁块（架构文档 §11.2、§11.5）。
 *
 * 一个补丁由若干 `{ search, replace }` 块组成。块由调用方从 JSON body 或 MCP 工具
 * 参数里解析后交给 `applyPatch`，这一层不解析文本格式。
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
 */

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

/** 只归一化 CRLF；单独的 CR 保持原样。 */
function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
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
