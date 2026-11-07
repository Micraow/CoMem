/**
 * 会话与归档（架构文档 §10、§15）。
 *
 * 会话是提交管线的输入：消息进来、攒够阈值、走两阶段提交（§10.1）。
 * 这里只放数据形状与纯判定，落盘在 `services/session.ts` 与 `adapters/`。
 */

import type { Uri } from './uri.js';
import { ComemError } from './errors.js';

/** 提交管线的阶段（架构文档 §10.1）。 */
export type SessionStatus = 'open' | 'committing' | 'committed' | 'failed';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息的组成部分（架构文档 §10.1 的四种 part）。
 *
 * 工具调用不能省：经验常常藏在工具输出里（「这个命令报错了，因为 X」）。
 * 但用户记忆抽取默认隐藏工具输出——它会泄漏环境变量与文件系统结构。
 *
 * 图片只存 URL 不存二进制：解析交给 agent，后端不做视觉理解。
 * 上下文引用记录「这条消息引用了哪段记忆」，是召回账本的输入之一。
 */
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly url: string; readonly alt: string | null }
  | {
      readonly kind: 'context';
      readonly uri: string;
      /** 引用时的摘要快照，不回读文件 */
      readonly abstract: string;
    }
  | {
      readonly kind: 'tool_use';
      readonly toolUseId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolUseId: string;
      readonly output: string;
      readonly isError: boolean;
    };

export interface SessionMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly parts: readonly ContentPart[];
  /** ISO 8601 时间串 */
  readonly createdAt: string;
  /** 轮次时钟，等于生成这条消息时的消息总数（架构文档 §8.7），从 1 开始 */
  readonly turn: number;
}

export interface Session {
  readonly id: string;
  readonly uri: Uri;
  readonly status: SessionStatus;
  readonly messages: readonly SessionMessage[];
  /** 未提交的消息数 */
  readonly messageCount: number;
  /** 未提交的估算 token 数 */
  readonly pendingTokens: number;
  readonly lastCommitAt: string | null;
}

/** 归档阶段的状态（架构文档 §10.1 的 `phase1.status`）。 */
export type ArchiveStatus = 'pending' | 'archived' | 'failed';

/** 自动提交策略（架构文档 §10.2.1）。`0` 表示关闭对应的触发条件。 */
export interface AutoCommitPolicy {
  readonly enabled: boolean;
  readonly pendingTokenThreshold: number;
  readonly messageCountThreshold: number;
  /** 两次自动提交的最小间隔，秒 */
  readonly minCommitIntervalSeconds: number;
  /** 空闲多久后提交，秒；0 = 关 */
  readonly idleTimeoutSeconds: number;
  /** 自动提交时保留最近 N 条 */
  readonly keepRecentCount: number;
}

/**
 * 粗估 token 数（架构文档 §10.2.1 的阈值判断用）。
 *
 * 公式：`ceil(CJK 码点数 × 1 + 其余码点数 × 0.25)`。
 * 依据是常见 BPE 分词器的经验值：汉字约 1 码点/token，拉丁字母、数字与空白约
 * 4 码点/token。与真实分词器相比误差在 ±30% 量级，emoji 会偏低（一个 emoji
 * 通常 2–3 token，这里按 1 算）。
 *
 * 只用于「该不该自动提交」这种量级判断，不用于计费：阈值是 150000，30% 的误差
 * 不改变结论。
 */
export function estimateTokens(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.ceil(cjkChars + otherChars / 4);
}

/**
 * 汉字与中文标点的码点范围。
 * 基本区 `U+4E00`–`U+9FFF`、扩展 A `U+3400`–`U+4DBF`、
 * 中文标点 `U+3000`–`U+303F`、全角字符 `U+FF00`–`U+FFEF`。
 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

/**
 * 该不该自动提交（架构文档 §10.2.1 的四个条件）。
 *
 * 触发条件（满足任一）：
 * - 未提交 token **严格大于** `pendingTokenThreshold`；
 * - 未提交消息数 **严格大于** `messageCountThreshold`；
 * - 空闲达到 `idleTimeoutSeconds` 且还有未提交内容。
 *
 * 两个条件默认关闭：`minCommitIntervalSeconds = 0` 不限速，`idleTimeoutSeconds = 0`
 * 不启用空闲提交（它需要服务端常驻扫描器）。
 *
 * 为什么阈值是「严格大于」：阈值 100 表示「第 101 条才提交」，这样「阈值 100」
 * 与「每 100 条提交一次」是同一个意思。
 *
 * `now` 由调用方注入：领域层不许有隐式时钟，否则这个判定没法用固定时间穷举测试。
 */
export function shouldAutoCommit(
  session: Session,
  policy: AutoCommitPolicy,
  now: Date,
): boolean {
  if (!policy.enabled) {
    return false;
  }

  const lastCommitAt = session.lastCommitAt === null ? null : parseTimestamp(session.lastCommitAt);

  // 限速器是全局闸门：任何触发条件都要先过它。
  if (lastCommitAt !== null && policy.minCommitIntervalSeconds > 0) {
    const sinceLastCommitSeconds = (now.getTime() - lastCommitAt) / 1000;
    if (sinceLastCommitSeconds < policy.minCommitIntervalSeconds) {
      return false;
    }
  }

  if (session.pendingTokens > policy.pendingTokenThreshold) {
    return true;
  }
  if (session.messageCount > policy.messageCountThreshold) {
    return true;
  }

  if (policy.idleTimeoutSeconds > 0 && hasPendingContent(session)) {
    const lastActivityAt = lastActivityTimestamp(session, lastCommitAt);
    if (lastActivityAt !== null) {
      const idleSeconds = (now.getTime() - lastActivityAt) / 1000;
      return idleSeconds >= policy.idleTimeoutSeconds;
    }
  }

  return false;
}

/**
 * 新消息的轮次（架构文档 §8.7：轮次时钟取消息总数）。
 *
 * 第一条消息是第 1 轮；空会话返回 1。调用方在追加前调用它。
 */
export function nextTurn(messages: readonly SessionMessage[]): number {
  return messages.length + 1;
}

/**
 * 把一条消息渲染成纯文本，供归档与抽取使用。
 *
 * 只渲染 parts，不重复加角色前缀——角色是独立字段，抽取侧拼 prompt 时自己决定
 * 怎么用。工具输出按 `[tool_use 名称 调用 ID]` / `[tool_result 调用 ID]` 包裹，
 * 让下游能按标记整体丢弃（默认隐藏工具输出，§10.1）。
 */
export function renderMessageText(message: SessionMessage): string {
  return message.parts.map(renderContentPart).join('\n');
}

function renderContentPart(part: ContentPart): string {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'image':
      return `[image ${part.url}${part.alt === null ? '' : ` ${part.alt}`}]`;
    case 'context':
      return `[context ${part.uri}] ${part.abstract}`;
    case 'tool_use':
      return `[tool_use ${part.name} ${part.toolUseId}] ${renderJson(part.input)}`;
    case 'tool_result':
      return `[tool_result ${part.toolUseId}${part.isError ? ' error' : ''}] ${part.output}`;
  }
}

function renderJson(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new ComemError('INVALID_ARGUMENT', '会话时间戳不是合法的 ISO 8601 时间。', {
      value,
    });
  }
  return timestamp;
}

function hasPendingContent(session: Session): boolean {
  return session.pendingTokens > 0 || session.messageCount > 0;
}

/** 最后活动时间：最新一条消息的时间，没有消息时退回上次提交时间。 */
function lastActivityTimestamp(session: Session, lastCommitAt: number | null): number | null {
  const latest = session.messages.at(-1);
  if (latest !== undefined) {
    return parseTimestamp(latest.createdAt);
  }
  return lastCommitAt;
}
