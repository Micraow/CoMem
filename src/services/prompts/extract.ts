/**
 * 记忆抽取提示词（架构文档 §11.3、§11.4）。
 *
 * 提示词的静态骨架在 `prompts/extract-system.md` 与 `prompts/extract-user.md`，
 * 可以在控制台查看和修改。本文件只负责把动态部分（记忆类型清单、已读记忆、会话
 * 记录）渲染成字符串，再按 `{{name}}` 注入模板。
 *
 * 模板里没有控制流，所以「空列表要说一句明确的话」这类判断留在这里——它们是领域
 * 规则，不是排版：
 *
 * - 没有预取到已读记忆时要说明，否则模型会自己编造编号；
 * - 没有会话消息时同样说明；
 * - 「上一次归档的概览」整段是**可选**的：没有时连同小标题一起去掉，而不是留一个
 *   空的二级标题。
 *
 * 抽取采用**预取**（§11.3）：调用方先按 schema 做一次检索，把命中的记忆连同
 * `page_id` 一起塞进来。模型看不到原始 URI，只看到编号；输出里的操作引用
 * `page_id`，服务端再映射回 URI（§11.4）。
 *
 * 编号规则是接口的一部分：**新建项用 ≥ 100 的编号**，避免和已读项冲突。
 */

import type { LlmMessage, LlmPrompt } from '../../domain/llm.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';

import { promptRenderer } from './registry.js';

/** 新建记忆的起始编号（§11.4：≥ 100）。模板通过 `{{newPageIdStart}}` 引用。 */
export const NEW_PAGE_ID_START = 100;

/** 一条「已读过」的记忆。`pageId` 是给模型看的编号，不是 URI。 */
export interface ExtractPage {
  readonly pageId: number;
  readonly uri: string;
  readonly content: string;
}

export interface ExtractPromptInput {
  /** 会话消息（§10.1 的 part 渲染成文本后的结果）。 */
  readonly messages: readonly LlmMessage[];
  /** 内置记忆类型（§11.1），决定模型能产出哪些 `type`。 */
  readonly memoryTypes: readonly MemoryTypeSchema[];
  /** 预取到的已读记忆（§11.3），每条带 `page_id`（§11.4）。 */
  readonly pages: readonly ExtractPage[];
  /** 上一次归档的工作记忆概览（§10.5）。第一次提交没有。 */
  readonly previousOverview?: string;
}

/** 把类型定义渲染成模型能读的字段清单。 */
function renderMemoryTypes(memoryTypes: readonly MemoryTypeSchema[]): string {
  return memoryTypes
    .map((schema) => {
      const fields = schema.fields
        .map((field) => {
          const flags = [field.identity === true ? 'identity' : null, field.required === true ? '必填' : null]
            .filter((flag) => flag !== null)
            .join('，');
          const merge = field.merge === undefined ? '' : `，合并策略 ${field.merge}`;
          return `  - ${field.name} (${field.type}${flags === '' ? '' : `，${flags}`}${merge})：${field.description}`;
        })
        .join('\n');
      return [
        `### ${schema.type}`,
        `- 说明：${schema.description}`,
        `- 目录：${schema.directory}`,
        `- 写入模式：${schema.operationMode}`,
        '- 字段：',
        fields,
      ].join('\n');
    })
    .join('\n\n');
}

/** 已读记忆列表。空列表时明确说「没有」，避免模型自己编造编号。 */
function renderPages(pages: readonly ExtractPage[]): string {
  if (pages.length === 0) {
    return '（这次没有预取到已读记忆。）';
  }
  return pages
    .map((page) =>
      [`<page_id: ${page.pageId}>`, `uri: ${page.uri}`, '正文：', page.content].join('\n'),
    )
    .join('\n\n');
}

/** 会话记录。角色用 Markdown 小标题标出，模型能分清谁说的。 */
function renderMessages(messages: readonly LlmMessage[]): string {
  if (messages.length === 0) {
    return '（这次没有会话消息。）';
  }
  return messages.map((message) => `### ${message.role}\n${message.content}`).join('\n\n');
}

/**
 * 「上一次归档的概览」整段，含小标题与两个空行；没有时是空串。
 *
 * 小标题留在这里而不是模板里：模板没有条件语法（见 `domain/prompt.ts` 的取舍），
 * 而「没有概览就不要这一节」是领域判断——留一个空标题会让模型以为上次什么都没记。
 */
function renderPreviousOverviewSection(overview: string | undefined): string {
  if (overview === undefined || overview.trim() === '') {
    return '';
  }
  return `## 上一次归档的概览\n\n${overview}\n\n`;
}

export function buildExtractPrompt(input: ExtractPromptInput): LlmPrompt {
  const renderer = promptRenderer();

  return {
    system: renderer.render('extract-system', {
      memoryTypes: renderMemoryTypes(input.memoryTypes),
      newPageIdStart: String(NEW_PAGE_ID_START),
      newPageIdExamples: [
        NEW_PAGE_ID_START,
        NEW_PAGE_ID_START + 1,
        NEW_PAGE_ID_START + 2,
      ].join('、'),
    }),
    messages: [
      {
        role: 'user',
        content: renderer.render('extract-user', {
          pages: renderPages(input.pages),
          previousOverviewSection: renderPreviousOverviewSection(input.previousOverview),
          messages: renderMessages(input.messages),
        }),
      },
    ],
  };
}
