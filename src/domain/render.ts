/**
 * 上下文块的渲染与转义（架构文档 §8.6）。
 *
 * 组装的结果是一段**可直接塞进模型上下文**的文本，不是命中列表。这一层只做
 * 「条目 → 字符串」，不判预算、不选层级——那些是 `domain/assembly.ts` 的事。
 *
 * 格式（§8.6 原文）：
 *
 * ```text
 * <memory uri="comem://user/alice/projects/comem/memories/preferences/code-style" type="memory" score="0.87" detail="abstract">
 * 用户在代码风格上的偏好：TypeScript 严格模式、2 空格缩进、偏好函数式写法。
 * </memory>
 * ```
 *
 * 标签名由 `contextType` 决定（`memory` / `resource` / `skill` / `session`），不是
 * 统一的 `<context type="...">`：模型对 `<memory>` 这种语义标签的理解比
 * `<context type="memory">` 更直接，而这个格式的目的就是让模型一次读对。
 */

import type { ContextType } from './node.js';

/**
 * 实际投放的粒度（§8.6 第 2 步）。`null` 表示只剩 URI，没有正文。
 *
 * 单独成类型是因为 `render.ts`、`assembly.ts`、`services/recall-ledger.ts` 三处
 * 都要用它，而「投到哪一层」在三个模块里必须是同一个概念。
 */
export type ContextDetail = 'abstract' | 'overview' | 'full';

export interface RenderedItem {
  readonly uri: string;
  readonly contextType: ContextType;
  readonly score: number;
  /** 实际投放的层级；只剩 URI 时是 `null` */
  readonly detail: ContextDetail | null;
  readonly text: string;
}

/**
 * `score` 保留的小数位（§8.6 的示例是 `0.87`）。
 *
 * 两位小数足够让模型区分相关性档位，又不会把 BM25 的浮点尾巴带进提示词。
 */
const SCORE_FRACTION_DIGITS = 2;

/**
 * 属性值的转义。
 *
 * 正文转义挡不住属性注入：`Uri` 的路径段允许 `"`（§6.2 只拒绝斜杠、控制字符、
 * `.`/`..` 和保留名），所以 URI 里出现引号时会把 `uri="..."` 提前闭合。把 `&` 和
 * `"` 转成实体后属性始终是一个整体；正常 URI 不含这两个字符，转义是恒等变换。
 */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * 正文转义：`&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;`。
 *
 * 这是安全边界。正文里出现 `</memory>`、`</resource>` 这类串时，如果不转义，记忆
 * 内容就能伪造闭合标签，把后面的内容挪到标签外（提示词结构劫持）。
 *
 * **为什么不需要转义正文里的 `uri="`**：属性只出现在开标签内部，解析器在遇到
 * `>` 时就结束了开标签；正文在 `>` 之后，里面的引号只是普通字符，不可能改变属性
 * 解析。真正能提前闭合标签的只有 `<`，所以转义 `<` 就够了。
 *
 * **顺序**：`&` 必须最先替换。反过来做的话，`<` 转出来的 `&lt;` 会被再转一次，
 * 变成字面的 `&amp;lt;`。
 */
export function escapeBody(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 渲染成一段可注入模型的上下文块（§8.6）。 */
export function renderItem(item: RenderedItem): string {
  const tag = item.contextType;
  const detail = item.detail === null ? '' : ` detail="${item.detail}"`;
  const attributes =
    `uri="${escapeAttribute(item.uri)}" type="${tag}" ` +
    `score="${item.score.toFixed(SCORE_FRACTION_DIGITS)}"${detail}`;

  // 只剩 URI 时输出单行自闭合标签：多出来的空行会占预算，也会让模型以为正文是空的。
  if (item.text === '') {
    return `<${tag} ${attributes} />`;
  }

  return `<${tag} ${attributes}>\n${escapeBody(item.text)}\n</${tag}>`;
}

/** 把多条渲染结果拼成最终文本，条目之间空一行。 */
export function renderAll(items: readonly RenderedItem[]): string {
  return items.map(renderItem).join('\n\n');
}
