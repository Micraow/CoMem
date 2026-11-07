/**
 * 目录摘要提示词（架构文档 §9.1、§9.2）。
 *
 * 纯字符串拼接，不调模型。L1 的四段结构（标题、简述、快速导航、逐条详述）与
 * §9.2 的示例一致；L0 由服务端从 L1 正文提取（`domain/summary.ts` 的
 * `extractAbstract`），本模板只负责生成 L1。
 *
 * **不输出 frontmatter。** `---` 包起来的元数据（uri、generated_at、freshness）
 * 由服务端生成：让模型输出它，等于让模型决定「什么时候生成的」，而模型的时间是
 * 幻觉高发区。
 */

import type { LlmPrompt } from '../../domain/llm.js';
import { ABSTRACT_MAX_CHARS, OVERVIEW_MAX_CHARS, type SummaryInput } from '../../domain/summary.js';

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

function buildSystemPrompt(abstractMaxChars: number, overviewMaxChars: number): string {
  return [
    '你是 CoMem 的目录摘要生成器。根据一个目录的直接子节点，写出这个目录的完整概览（L1），让读者不用打开子文件就能判断该读哪一个。',
    '',
    '## 输出结构',
    '只输出 Markdown 正文，结构如下：',
    [
      '# <标题：这个目录是什么>',
      '',
      '<简述：一到三句话，不超过 ' + abstractMaxChars + ' 字符>',
      '',
      '## 快速导航',
      '',
      '- `<子节点名>` —— 一句话说明',
      '',
      '## 详细说明',
      '',
      '### <子节点名>',
      '',
      '<逐条详述，每个子节点一段>',
    ].join('\n'),
    '',
    '## 约束',
    `- 整篇正文不超过 ${overviewMaxChars} 字符。`,
    '- 标题是一级标题，只出现一次；「快速导航」「详细说明」是二级标题。',
    '- 不要输出 frontmatter：`---` 包起来的元数据由服务端生成。',
    '- 不要用代码块包裹整篇输出，也不要在正文前后加解释。',
    '- 每个子节点都要在「快速导航」与「详细说明」里各出现一次，顺序与输入一致。',
    '- 不要编造输入里没有的事实；信息不足时只描述子节点写了什么。',
  ].join('\n');
}

export function buildSummaryPrompt(input: SummaryPromptInput): LlmPrompt {
  const abstractMaxChars = input.abstractMaxChars ?? ABSTRACT_MAX_CHARS;
  const overviewMaxChars = input.overviewMaxChars ?? OVERVIEW_MAX_CHARS;

  return {
    system: buildSystemPrompt(abstractMaxChars, overviewMaxChars),
    messages: [
      {
        role: 'user',
        content: ['## 目录', `uri: ${input.uri.toString()}`, '## 直接子节点', renderChildren(input)].join(
          '\n\n',
        ),
      },
    ],
  };
}
