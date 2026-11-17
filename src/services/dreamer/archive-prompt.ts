/**
 * 经验归纳提示词（架构文档 §10.1 的第 5 步 `dreamer`、§11.6 的复核闸门；
 * 已有经验的预取见 §11.3）。
 *
 * 提示词的静态骨架在 `prompts/experience-system.md` 与 `prompts/experience-user.md`，
 * 可以在控制台查看和修改。本文件只负责把动态部分（已有经验、会话记录、今天日期）
 * 渲染成字符串，再按 `{{name}}` 注入模板。
 *
 * ## 与抽取提示词的区别
 *
 * 抽取是「读消息 → 产出字段级操作」，模型看不到已有经验的 URI，只看到 `page_id`；
 * 归纳是「读会话 + 已有经验 → 产出整段正文」，同一个 topic 的旧正文由服务端整段
 * 覆盖。所以这里不需要 `page_id`：输出的 `topic` 直接推出文件路径。
 *
 * 模板里没有控制流，两处「空列表要说一句明确的话」的判断留在这里：
 *
 * - 没有预取到已有经验时说明，否则模型会把「没有参考」当成「可以随便编」；
 * - 没有会话消息时同样说明。
 */

import type { LlmMessage, LlmPrompt } from '../../domain/llm.js';
import { renderMessageText, type SessionMessage } from '../../domain/session.js';

import { promptRenderer } from '../prompts/registry.js';
import type { ExperienceCatalogEntry } from './experience.js';

/**
 * 经验归纳唯一允许引用的会话消息。
 *
 * 角色限制在 user / assistant：工具输出不进入经验归纳，也不能被模型包装成
 * “已实测”。ID 原样登录提示词，写入时用同一视图核对引用。
 */
export interface ExperiencePromptMessage extends LlmMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
}

/** 归档消息 → 经验归纳输入。工具内容与非对话角色整体丢弃。 */
export function experiencePromptMessages(
  messages: readonly SessionMessage[],
): readonly ExperiencePromptMessage[] {
  return messages.flatMap((message): ExperiencePromptMessage[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = renderMessageText({
      ...message,
      parts: message.parts.filter(
        (part) => part.kind !== 'tool_use' && part.kind !== 'tool_result',
      ),
    });
    return content.trim() === ''
      ? []
      : [{ id: message.id, role: message.role, content }];
  });
}

/**
 * 一条已经在盘上的经验。
 *
 * 有效期读自 frontmatter 的保留键（`valid_from` / `valid_until`），`null` 表示无界：
 * 旧文件没有这两个键，或者这条经验仍然有效。模型需要它来判断「这条旧结论是不是
 * 已经被后来的经验换掉了」。
 */
export interface ExistingExperience {
  readonly category?: string;
  readonly topic: string;
  readonly content: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface ExperiencePromptInput {
  /**
   * 全部生效经验的最小目录。目录始终完整进入提示词；正文只由下面 `existing`
   * 提供少量候选，避免模型把“没预取到”误认为“不存在”。
   */
  readonly catalog: readonly ExperienceCatalogEntry[];
  readonly entities?: readonly { readonly pageId: number; readonly content: string; readonly aliases: unknown }[];
  /** 会话消息；ID 是 evidence 引用的唯一稳定地址。 */
  readonly messages: readonly ExperiencePromptMessage[];
  /** 预取到的已有经验（§11.3）。 */
  readonly existing: readonly ExistingExperience[];
  /** 已生效的明确偏好；经验归纳只能引用它们，不能把同一事实再写成经验。 */
  readonly preferences: readonly { readonly topic: unknown; readonly content: string }[];
  /**
   * 今天的日期，`YYYY-MM-DD`。
   *
   * 经验正文里常要写「截至什么时候」。不注入日期模型会自己编一个，而编出来的日期
   * 在「这条结论还成不成立」的判断里是噪声。
   */
  readonly today: string;
}

/** 有效区间的一句话说明。两个端点都缺时是「不限」（旧文件没有时间区间字段）。 */
function renderValidity(from: string | null, until: string | null): string {
  if (from === null && until === null) {
    return '有效期：不限';
  }
  if (from === null) {
    return `有效期：至 ${until ?? ''}`;
  }
  if (until === null) {
    return `有效期：${from} 起，仍然有效`;
  }
  return `有效期：${from} 至 ${until}`;
}

/**
 * 已有经验列表。空列表时明确说「没有」，避免模型把空段落当成「可以自由发挥」。
 */
function renderExistingExperiences(existing: readonly ExistingExperience[]): string {
  if (existing.length === 0) {
    return '（这次没有预取到已有经验。）';
  }
  return existing
    .map((experience) =>
      [
        `### ${experience.topic}`,
        ...(experience.category === undefined ? [] : [`分类：${experience.category}`]),
        renderValidity(experience.validFrom, experience.validUntil),
        '正文：',
        experience.content,
      ].join('\n'),
    )
    .join('\n\n');
}

function renderCatalog(catalog: readonly ExperienceCatalogEntry[]): string {
  if (catalog.length === 0) {
    return '（没有已生效经验。）';
  }
  return catalog.map((experience) => [
    `### ${experience.topic}`,
    ...(experience.category === undefined ? [] : [`分类：${experience.category}`]),
    `地址：${experience.uri}`,
    `状态：${experience.status}`,
    renderValidity(experience.validFrom, experience.validUntil),
    `摘要：${experience.summary}`,
  ].join('\n')).join('\n\n');
}

function renderPreferences(preferences: ExperiencePromptInput['preferences']): string {
  if (preferences.length === 0) {
    return '（没有已生效的明确偏好。）';
  }
  return preferences.map((preference) => `### ${String(preference.topic)}\n${preference.content}`).join('\n\n');
}

/** 会话记录。ID 与角色是 evidence 的服务端校验锚点。 */
function renderMessages(messages: readonly ExperiencePromptMessage[]): string {
  if (messages.length === 0) {
    return '（这次没有会话消息。）';
  }
  return messages.map((message) => [
    `### messageId: ${message.id}`,
    `角色：${message.role}`,
    '正文：',
    message.content,
  ].join('\n')).join('\n\n');
}

export function buildExperiencePrompt(input: ExperiencePromptInput): LlmPrompt {
  const renderer = promptRenderer();

  return {
    system: renderer.render('experience-system', {
      today: input.today,
    }),
    messages: [
      {
        role: 'user',
        content: renderer.render('experience-user', {
          existingExperiences: [
            '### 全部当前经验目录',
            '先在这份完整目录中寻找可合并的已有 topic。pending 记录还不能作为检索依据，但同一路径已有正文；看到 pending 时也必须先合并或保留，不能把“未生效”当成不存在。目录没有正文，不能因为候选正文未预取就认为该经验不存在。',
            renderCatalog(input.catalog),
            '### 已预取的候选正文',
            renderExistingExperiences(input.existing),
            '### 已生效的明确偏好',
            renderPreferences(input.preferences),
            '### 实体候选',
            '仅在明确属于同一实体时引用：',
            JSON.stringify(input.entities ?? []),
          ].join('\n\n'),
          messages: renderMessages(input.messages),
        }),
      },
    ],
  };
}
