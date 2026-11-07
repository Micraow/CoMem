/**
 * 三层摘要与新鲜度（架构文档 §9）。
 *
 * L0 是 `.abstract.md` 的正文，L1 是 `.overview.md` 的正文，L2 是原文件。
 * L0 从 L1 正文里提取，两层因此不会互相矛盾（§9.1）。
 *
 * 本文件只有纯函数与接口：生成器（`LlmSummarizer` / `RuleSummarizer`）在
 * `services/summary.ts`，这里只定义 Strategy 的形状，不关心模型怎么调。
 */

import type { NodeKind } from './node.js';
import type { Uri } from './uri.js';

/**
 * L0 正文预算，单位是 Unicode 码点（架构文档 §9.1 的「256 字符」）。
 * 码点与「字符」在中文、常见 emoji 上一致；不按字节计，字节会把中文预算压成 1/3。
 */
export const ABSTRACT_MAX_CHARS = 256;

/** L1 正文预算，单位同 L0（架构文档 §9.1 的「4000 字符」）。 */
export const OVERVIEW_MAX_CHARS = 4000;

/**
 * 目录级摘要（架构文档 §6.6 的 `.abstract.md` / `.overview.md` 正文）。
 * `degraded` 为真表示这次是降级生成（断网走规则摘要），必须对调用方可见——静默降级等于骗人（§17.9）。
 */
export interface DirectorySummary {
  /** L0：一句话，256 字符以内 */
  readonly abstract: string;
  /** L1：完整概览，4000 字符以内 */
  readonly overview: string;
  readonly degraded: boolean;
}

/**
 * 摘要新鲜度（架构文档 §9.3）。
 *
 * `baseline` 是上次生成时 L0 正文的摘要；`null` 表示这个目录从未生成过摘要。
 * `pendingChanges` 是「L0 正文在生成之后又变了多少次」，不是脏标记——同一个文件反复改，
 * 脏标记只算一次，永远到不了阈值（§9.3）。
 */
export interface SummaryFreshness {
  readonly baseline: string | null;
  readonly pendingChanges: number;
  readonly totalEntries: number;
}

/** 生成 L1 时喂给生成器的一个直接子节点（§9.2：直接子文件的摘要 + 直接子目录的 L0 正文）。 */
export interface SummaryChild {
  readonly uri: Uri;
  readonly name: string;
  readonly kind: NodeKind;
  /** 文件的摘要；目录的 L0 正文 */
  readonly abstract: string;
}

export interface SummaryInput {
  readonly uri: Uri;
  readonly children: readonly SummaryChild[];
}

/** 摘要生成策略（架构文档 §9.2）。只有 `services/summary.ts` 需要实现它。 */
export interface SummaryGenerator {
  generate(input: SummaryInput): Promise<DirectorySummary>;
}

/** 触发「立刻重算」的两个阈值（架构文档 §9.3）。 */
export interface FreshnessThresholds {
  /** 条目数不多于这个值时，任何一次改动都立刻重算 */
  readonly immediateEntryLimit: number;
  /** 待刷新改动占比达到这个值时立刻重算 */
  readonly ratioThreshold: number;
}

/**
 * 默认阈值，来源是架构文档 §9.3 的代码块：`totalEntries <= 32` 与
 * `pendingChanges / totalEntries >= 0.10`。两个数都是「小目录重算便宜、
 * 大目录等积累」的经验分界，没有实测数据支撑。
 */
export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = Object.freeze({
  immediateEntryLimit: 32,
  ratioThreshold: 0.1,
});

/** 只匹配一级标题（Markdown 要求 `#` 后有空白）。 */
const H1_PATTERN = /^#[ \t]/;

/** 匹配二级及更深标题：`##`、`###` 都算「第一个 ##」。 */
const H2_PATTERN = /^##/;

/**
 * 从 L1 正文提取 L0：一级标题之后、第一个二级标题之前的段落（架构文档 §9.1）。
 *
 * 规则：
 * - 没有一级标题时从正文开头取（兼容没有标题的概览）；
 * - 一级标题后直接跟二级标题时返回空串——没有内容就是没有，不拿标题凑；
 * - 多个段落原样保留（段落之间留空行），不压缩成一行。
 *
 * 不做截断：预算是生成侧的职责（`truncateToChars`），提取只负责结构。
 * 入参是 L1 的**正文**，不含 frontmatter。
 */
export function extractAbstract(overview: string): string {
  const lines = overview.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => H1_PATTERN.test(line));
  const start = headingIndex < 0 ? 0 : headingIndex + 1;

  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (H2_PATTERN.test(line)) {
      break;
    }
    body.push(line);
  }

  return body.join('\n').trim();
}

/**
 * 按字符（Unicode 码点）截断，不切碎 emoji 与代理对。
 *
 * `String.prototype.slice` 按 UTF-16 码元切，`'😀'.slice(0, 1)` 会留下半个代理对；
 * `Array.from` 按码点切，一个 emoji 是一个元素。组合字符（如 `e` + U+0301）的
 * 字素边界不处理——那需要 `Intl.Segmenter`，而 L0/L1 的预算是给模型看的粗粒度数字，
 * 为此引入运行时分词器不值得。
 *
 * `max <= 0` 或非有限数返回空串。
 */
export function truncateToChars(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) {
    return '';
  }
  const chars = Array.from(text);
  const limit = Math.floor(max);
  if (chars.length <= limit) {
    return text;
  }
  return chars.slice(0, limit).join('');
}

/**
 * 是否该立刻重算摘要（架构文档 §9.3 的四条判定）。
 *
 * 1. 没有基线（从未生成过）→ 是；
 * 2. `totalEntries <= immediateEntryLimit` → 是；
 * 3. `pendingChanges / totalEntries >= ratioThreshold` → 是；
 * 4. 其余 → 否，只记脏。
 *
 * 第 2 条同时挡掉了 `totalEntries === 0` 的除零：空目录必然走「立刻重算」。
 */
export function shouldRecompute(
  freshness: SummaryFreshness,
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
): boolean {
  if (freshness.baseline === null) {
    return true;
  }
  if (freshness.totalEntries <= thresholds.immediateEntryLimit) {
    return true;
  }
  return freshness.pendingChanges / freshness.totalEntries >= thresholds.ratioThreshold;
}

/**
 * 消费待刷新计数（架构文档 §9.3）：`pending = max(pending - 快照, 0)`。
 *
 * 减而不是清零，是因为生成摘要期间可能又来了新改动。生成开始时记下快照，
 * 写回时只扣掉「这次生成覆盖到的改动」，生成期间到达的保留在计数里。
 */
export function consumeChanges(
  freshness: SummaryFreshness,
  snapshotPending: number,
): SummaryFreshness {
  return {
    ...freshness,
    pendingChanges: Math.max(freshness.pendingChanges - snapshotPending, 0),
  };
}

/** 记一次改动（架构文档 §9.3 的 `P.freshness.pendingChanges += 1`）。 */
export function recordChange(freshness: SummaryFreshness): SummaryFreshness {
  return { ...freshness, pendingChanges: freshness.pendingChanges + 1 };
}
