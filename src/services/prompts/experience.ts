/**
 * 经验归纳提示词（架构文档 §10.1 的第 5 步 `experience_distill`、§11.6 的复核闸门；
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

import { promptRenderer } from './registry.js';

/**
 * 一条已经在盘上的经验。
 *
 * 有效期读自 frontmatter 的保留键（`valid_from` / `valid_until`），`null` 表示无界：
 * 旧文件没有这两个键，或者这条经验仍然有效。模型需要它来判断「这条旧结论是不是
 * 已经被后来的经验换掉了」。
 */
export interface ExistingExperience {
  readonly topic: string;
  readonly content: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface ExperiencePromptInput {
  /** 会话消息（§10.1 的 part 渲染成文本后的结果）。 */
  readonly messages: readonly LlmMessage[];
  /** 预取到的已有经验（§11.3）。 */
  readonly existing: readonly ExistingExperience[];
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
        renderValidity(experience.validFrom, experience.validUntil),
        '正文：',
        experience.content,
      ].join('\n'),
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
          existingExperiences: renderExistingExperiences(input.existing),
          messages: renderMessages(input.messages),
        }),
      },
    ],
  };
}
