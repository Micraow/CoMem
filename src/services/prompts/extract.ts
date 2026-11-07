/**
 * 记忆抽取提示词（架构文档 §11.3、§11.4）。
 *
 * 纯字符串拼接，不调模型：模板是确定的，测试只需要断言关键片段出现，不需要
 * 跑一次真实的 LLM。
 *
 * 抽取采用**预取**（§11.3）：调用方先按 schema 做一次检索，把命中的记忆连同
 * `page_id` 一起塞进来。模型看不到原始 URI，只看到编号；输出里的操作引用
 * `page_id`，服务端再映射回 URI（§11.4）。
 *
 * 编号规则是接口的一部分：**新建项用 ≥ 100 的编号**，避免和已读项冲突。
 */

import type { LlmMessage, LlmPrompt } from '../../domain/llm.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';

/** 新建记忆的起始编号（§11.4：≥ 100）。 */
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

function buildSystemPrompt(memoryTypes: readonly MemoryTypeSchema[]): string {
  return [
    '你是 CoMem 的记忆抽取器。阅读一段会话记录，把值得长期保留的信息抽取成结构化操作。',
    '',
    '## 记忆类型',
    renderMemoryTypes(memoryTypes),
    '',
    '## page_id 编号规则',
    `- 「已读记忆」里的每条记忆有一个编号。修改或删除已有记忆时，引用它的 page_id。`,
    `- 新建的记忆必须使用 ≥ ${NEW_PAGE_ID_START} 的编号（${NEW_PAGE_ID_START}、${NEW_PAGE_ID_START + 1}、${NEW_PAGE_ID_START + 2}……），按出现顺序递增。`,
    '- 新建编号不能与已读记忆的 page_id 冲突。',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或其它文本。结构：',
    [
      '{',
      '  "operations": [',
      '    {',
      '      "kind": "upsert",',
      '      "pageId": 100,',
      '      "type": "preferences",',
      '      "identity": { "topic": "code-style" },',
      '      "operations": [',
      '        { "kind": "replace", "field": "content", "value": "..." }',
      '      ]',
      '    },',
      '    { "kind": "delete", "pageId": 3 }',
      '  ]',
      '}',
    ].join('\n'),
    '规则：',
    '- `kind` 只能是 `upsert` 或 `delete`。',
    '- `operations[].kind` 只能是 `patch` / `replace` / `sum` / `immutable`。',
    '- `patch` 操作把块放在 `blocks` 键下，形如 `{ "kind": "patch", "field": "content", "blocks": [{ "search": "...", "replace": "..." }] }`。**SEARCH 必须在当前正文里唯一命中**：零命中或多处命中都会让整条操作被丢弃。',
    '- `replace` 用 `value`，`sum` 用 `delta`，`immutable` 用 `value`。`patch` 不用 `value`。',
    '- `identity` 必须覆盖该类型文件名模板里的全部占位符。',
    '- 没有值得保留的信息时输出 `{"operations": []}`。',
  ].join('\n');
}

function buildUserContent(input: ExtractPromptInput): string {
  const sections = ['## 已读记忆', renderPages(input.pages)];

  if (input.previousOverview !== undefined && input.previousOverview.trim() !== '') {
    sections.push('## 上一次归档的概览', input.previousOverview);
  }

  sections.push('## 会话记录', renderMessages(input.messages));
  sections.push('## 任务', '按上面的格式输出 JSON。');
  return sections.join('\n\n');
}

export function buildExtractPrompt(input: ExtractPromptInput): LlmPrompt {
  return {
    system: buildSystemPrompt(input.memoryTypes),
    messages: [{ role: 'user', content: buildUserContent(input) }],
  };
}
