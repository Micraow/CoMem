/**
 * 目录摘要提示词（架构文档 §9.1、§9.2）。
 *
 * 提示词的静态骨架在 `prompts/summarize-system.md` 与 `prompts/summarize-user.md`，
 * 可以在控制台查看和修改。本文件只负责渲染动态部分（目录地址、直接子节点）并把
 * 字数预算注入模板。
 *
 * L1 的四段结构（标题、简述、快速导航、逐条详述）与 §9.2 的示例一致；L0 由服务端
 * 从 L1 正文提取（`domain/summary.ts` 的 `extractAbstract`），本模板只负责生成 L1。
 *
 * **不输出 frontmatter。** `---` 包起来的元数据（uri、generated_at、freshness）
 * 由服务端生成：让模型输出它，等于让模型决定「什么时候生成的」，而模型的时间是
 * 幻觉高发区。
 */

import type { LlmPrompt } from '../../domain/llm.js';
import { ABSTRACT_MAX_CHARS, OVERVIEW_MAX_CHARS, type SummaryInput } from '../../domain/summary.js';

import { promptRenderer } from './registry.js';

export interface SummaryPromptInput extends SummaryInput {
  /** L0 预算，默认取 §9.1 的 256 字符（`domain/summary.ts` 是同一份常量）。 */
  readonly abstractMaxChars?: number;
  /** L1 预算，默认取 §9.1 的 4000 字符。 */
  readonly overviewMaxChars?: number;
}

function renderChildren(input: SummaryPromptInput): string {
  if (input.children.length === 0) {
    return '（这个目录是空的。）';
  }
  return input.children
    .map((child) =>
      [`### ${child.name}（${child.kind}）`, `uri: ${child.uri.toString()}`, '摘要：', child.abstract].join(
        '\n',
      ),
    )
    .join('\n\n');
}

export function buildSummaryPrompt(input: SummaryPromptInput): LlmPrompt {
  // 预算由配置提供，模板里只留 `{{abstractMaxChars}}` / `{{overviewMaxChars}}`：
  // 把 256 写死在 `.md` 里之后，改配置不会改变模型看到的数字。
  const abstractMaxChars = input.abstractMaxChars ?? ABSTRACT_MAX_CHARS;
  const overviewMaxChars = input.overviewMaxChars ?? OVERVIEW_MAX_CHARS;
  const renderer = promptRenderer();

  return {
    system: renderer.render('summarize-system', {
      abstractMaxChars: String(abstractMaxChars),
      overviewMaxChars: String(overviewMaxChars),
    }),
    messages: [
      {
        role: 'user',
        content: renderer.render('summarize-user', {
          uri: input.uri.toString(),
          children: renderChildren(input),
        }),
      },
    ],
  };
}
