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
  /** 记忆类型。画像的收敛指令要靠它认出「哪一条是 profile」（单文件类型只有一条）。 */
  readonly memoryType: string;
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
  /**
   * 用户画像正文的字符上限（`memory.profile.maxChars`）。
   *
   * 画像整段注入每次会话的开头，长度是固定成本。超过这个值时，提示词要求这次
   * 输出一条 `replace content` 的整份重写——**不是额外一次模型调用**，压缩骑在
   * 本来就要跑的 `memory_extract` 上。
   */
  readonly profileMaxChars: number;
  /**
   * 今天的日期，`YYYY-MM-DD`。
   *
   * 格式契约要求每条画像以 `(as of YYYY-MM-DD)` 结尾，而模型不知道今天几号。
   * 不注入日期它就会编一个，而编出来的日期在「只留最新值」的判定里是噪声。
   */
  readonly today: string;
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

/**
 * 用户画像的收敛指令。
 *
 * 只给规则不给数字，模型判断不了「现在算不算超」——所以这里同时给出当前字数、
 * 上限与这次的处置方式。三个分支：没有画像（新建）、未超上限（增量维护）、
 * 超上限（整份重写）。
 *
 * 「未超上限但格式不合规」也要重写：格式契约是判定「这条该不该进画像」的一部分，
 * 一份没有日期后缀、留着历史值的旧画像会持续污染后续判定。
 */
function renderProfileDirective(input: ExtractPromptInput): string {
  const profile = input.pages.find((page) => page.memoryType === 'profile');
  const dateSuffix = `日期后缀用 ${input.today}`;

  if (profile === undefined) {
    return [
      `这次没有读到用户画像。出现稳定身份时，用 ≥ ${String(NEW_PAGE_ID_START)} 的编号新建一条 \`profile\`，${dateSuffix}。`,
    ].join('\n');
  }

  const chars = profile.content.length;
  const overBudget = chars > input.profileMaxChars;
  return [
    `当前用户画像在第 ${String(profile.pageId)} 条，正文 ${String(chars)} 字，上限 ${String(input.profileMaxChars)} 字。`,
    overBudget
      ? '**已超上限**：这次必须输出一条 `replace content` 的整份重写，只保留稳定身份。重写后比原文短是预期结果。'
      : '未超上限：用 `patch` 增量维护；如果正文不符合上面的格式契约（缺日期后缀、单条超长、同一状态留了旧值），也要整份重写。',
    `重写时 \`pageId\` 用 ${String(profile.pageId)}，\`type\` 用 \`profile\`，\`identity.name\` 用画像里已有的名字，\`operations\` 只放一条 \`replace content\`；${dateSuffix}。`,
  ].join('\n');
}

export function buildExtractPrompt(input: ExtractPromptInput): LlmPrompt {
  const renderer = promptRenderer();

  return {
    system: renderer.render('extract-system', {
      memoryTypes: renderMemoryTypes(input.memoryTypes),
      profileDirective: renderProfileDirective(input),
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
