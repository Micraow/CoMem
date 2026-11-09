/**
 * 上下文组装（架构文档 §8.6）。
 *
 * 「检索结果 → 模型输入」的独立一层，解决三个问题：给多少（token 预算）、给多细
 * （分层投放与升级）、重复几次（去重 + 配额 + 跨轮账本）。
 *
 * 这一层是**纯编排**：不读文件，`readOverview` / `readBody` 由注入的
 * `AssemblyPorts` 提供。这样预算与降级逻辑可以用假数据穷举测试，不需要临时目录、
 * 不需要真的写 40 个文件。
 *
 * ## 四步（严格按 §8.6）
 *
 * 1. **token 预算**：总预算 `maxTokens`，单条上限走 `ranking.perItemTokenCap`
 *    （`maxTokens / 条目数 × 2`）。单条上限只作用在升级轮次，见第 2 步。
 * 2. **分层投放**：起始层由记忆类型决定（`events` 从 L1 概览起，其余从 L0 摘要
 *    起），放不下就沿 `full → overview → abstract → 只有 URI` 降级，降到底还装不下
 *    就丢弃。然后按分数降序做三轮升级：`overview` → 受单条上限约束的 `full` →
 *    无单条上限的 `full`。天花板在升级时生效，降级不设限。
 * 3. **去重**：渲染后正文完全相同的条目只留分数最高的（`ranking.dedupeByRenderedText`）。
 * 4. **配额**：按类别分配条目数；去重之后、渲染之前生效，超出配额的计入 `dropped`。
 *
 * ## 读取成本（`local/notes/comparison.md` 第 1 条）
 *
 * L0 摘要在索引里，取它不花钱；L1 概览和 L2 原文要打开文件。所以：
 *
 * - **同一条目只读一次**：读数按 URI 记忆化，连「并发发起两次读」也只算一次。
 * - **并发有界**：每个升级轮次内部并发，但同时最多 `READ_CONCURRENCY` 个。打开
 *   40 个文件会打满 fd 上限（默认 `ulimit -n` 常见 1024，但每个文件占的 fd 不止
 *   一个，且同一进程还有 SQLite、日志、socket 在抢）。
 * - **不白读**：只剩 URI 都装不下的条目在**任何读之前**就被丢弃。
 *
 * ## 与 `services/` 的分工
 *
 * `readOverview` 返回 `null` 时，这一层只当成「概览不可用」，继续降级。用「标题树 +
 * 首段」合成概览需要读原文，属于 `services/` 的实现细节（§8.6 的调用方），
 * `domain/` 不碰 IO。
 */

import { ComemError } from './errors.js';
import type { Level } from './level.js';
import type { Logger } from './log.js';
import type { ContextType } from './node.js';
import { dedupeByRenderedText, perItemTokenCap } from './ranking.js';
import type { RankedCandidate } from './ranking.js';
import { renderAll, renderItem } from './render.js';
import type { ContextDetail } from './render.js';

export interface AssemblyCandidate {
  readonly uri: string;
  readonly contextType: ContextType;
  /**
   * 记忆类型（`domain/memory-types` 里的 `type`），非记忆节点是 `null`。
   *
   * 为什么需要这个字段：起始层按「是不是 `events`」决定（§8.6 第 2 步的表格），
   * 而 `events` 是**记忆类型**，不是 `contextType`。两者正交——`contextType ===
   * 'memory'` 的节点可以是 events、preferences、rules 等任意记忆类型。所以起始层
   * 不能从 `contextType` 推，必须单独带进来。
   */
  readonly memoryType: string | null;
  /** 命中记录本身的层级 */
  readonly level: Level;
  /** 原始 bm25 取负后的分数，越大越相关 */
  readonly score: number;
  /** L0 摘要；索引里就有，取值不花钱 */
  readonly abstract: string | null;
}

export interface AssemblyPorts {
  /** 读 L1 概览。没有摘要文件时返回 null（不要抛错） */
  readonly readOverview: (uri: string) => Promise<string | null>;
  /** 读 L2 原文 */
  readonly readBody: (uri: string) => Promise<string | null>;
  readonly estimateTokens: (text: string) => number;
  readonly logger: Logger;
}

export type QuotaPreset = 'chat' | 'coding';

export interface AssemblyOptions {
  /**
   * 注入模型的 token 预算。默认 1600（§18 的 `retrieval.assembly.maxTokens`），
   * 由调用方从配置传入——领域层不读配置，也不硬编码这个数字。
   */
  readonly maxTokens: number;
  readonly quotaPreset: QuotaPreset;
  /** 跳过的 URI（上一轮已经投过的，来自召回账本） */
  readonly excludedUris?: ReadonlySet<string>;
}

export interface AssembledItem {
  readonly uri: string;
  readonly contextType: AssemblyCandidate['contextType'];
  readonly level: Level;
  readonly score: number;
  /** 实际投放的层级 */
  readonly detail: ContextDetail | null;
  readonly text: string;
  readonly tokens: number;
}

export interface AssemblyResult {
  readonly items: readonly AssembledItem[];
  readonly rendered: string;
  /** 因为预算或配额被丢弃的条数 */
  readonly dropped: number;
  readonly tokensUsed: number;
}

/**
 * 记忆类型里从 L1 概览起投的那一个（§8.6 第 2 步）。
 *
 * 事件是「什么时候发生了什么」，摘要一句话说不清前因后果，从概览起投质量更好；
 * 其余记忆类型（偏好、规则、实体）本身就以一句话为粒度，L0 摘要够用。
 */
const EVENT_MEMORY_TYPE = 'events';

/**
 * 层级天花板（`local/notes/comparison.md` 第 3 条）。
 *
 * 天花板在**升级**时生效，降级不设限：一个技能包即使从 abstract 起投，也永远升不到
 * full——`SKILL.md` 动辄几万字，塞进 1600 token 的预算里会把别的条目全挤掉。
 * 会话（§8.7 的账本粒度）只给摘要：同一段对话的原文对下一轮的检索没有增量信息，
 * 反而重复占预算。资源与记忆没有理由设限，全文有用就升。
 */
export const DEPTH_CEILING: Readonly<Record<ContextType, ContextDetail>> = Object.freeze({
  memory: 'full',
  resource: 'full',
  skill: 'overview',
  session: 'abstract',
});

/**
 * 类别配额（§8.6 第 4 步的表格）。
 *
 * `chat` 预设偏向记忆（对话里最常引用的是偏好与结论），`coding` 偏向资源
 * （代码库里最常引用的是文件与文档）。
 *
 * `session` 在 §8.6 的表格里也给 2。理由：会话摘要只用于接上「上一轮聊到哪」，
 * 当前轮 + 上一轮就够，再多只是在重复同一段对话的不同摘要；2 也是「一对」的最小
 * 有意义取值。
 */
export const QUOTA_BY_PRESET: Readonly<
  Record<QuotaPreset, Readonly<Record<ContextType, number>>>
> = Object.freeze({
  chat: Object.freeze({ memory: 5, resource: 3, skill: 2, session: 2 }),
  coding: Object.freeze({ memory: 3, resource: 5, skill: 2, session: 2 }),
});

/**
 * 升级轮次内部的并发上限（`local/notes/comparison.md` 第 1 条）。
 *
 * 经验值，来源未知：一次组装最多几十个候选，8 个并发已足够把 IO 延迟藏在
 * 其它条目的计算后面，又不会让打开的文件描述符数量失控。
 */
const READ_CONCURRENCY = 8;

/** 降级顺序：`full → overview → abstract → 只有 URI`（§8.6 第 2 步）。 */
const COARSER_DETAIL: Readonly<Record<ContextDetail, ContextDetail | null>> = Object.freeze({
  full: 'overview',
  overview: 'abstract',
  abstract: null,
});

interface Slot {
  readonly candidate: AssemblyCandidate;
  detail: ContextDetail | null;
  text: string;
  tokens: number;
}

interface AssemblyState {
  readonly ports: AssemblyPorts;
  readonly readOverview: (uri: string) => Promise<string | null>;
  readonly readBody: (uri: string) => Promise<string | null>;
  remaining: number;
  dropped: number;
}

/**
 * 分数降序；同分按 URI 码点序，保证结果可复现（不依赖输入顺序，也不用
 * `localeCompare`——那会依赖运行环境的 ICU 数据）。
 */
function compareByScore(a: AssemblyCandidate, b: AssemblyCandidate): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.uri < b.uri) {
    return -1;
  }
  if (a.uri > b.uri) {
    return 1;
  }
  return 0;
}

/**
 * 按 URI 记忆化一次读。缓存的是 **Promise** 而不是结果：三个升级轮次可能对同一个
 * URI 各发一次读，缓存 Promise 让并发的两次也合并成一次 IO。
 */
function memoizeRead(
  read: (uri: string) => Promise<string | null>,
): (uri: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (uri) => {
    const cached = cache.get(uri);
    if (cached !== undefined) {
      return cached;
    }
    const pending = read(uri);
    cache.set(uri, pending);
    return pending;
  };
}

/**
 * 有界并发映射：同时最多 `limit` 个任务在跑，结果按输入顺序返回。
 *
 * 不用 `Promise.all(items.map(task))` 是因为那会同时发起全部 IO。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await task(item);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** 一条候选投到某个层级时的 token 成本。按**渲染后**的整块算，标签也占预算。 */
function costOf(
  ports: AssemblyPorts,
  candidate: AssemblyCandidate,
  detail: ContextDetail | null,
  text: string,
): number {
  return ports.estimateTokens(
    renderItem({
      uri: candidate.uri,
      contextType: candidate.contextType,
      score: candidate.score,
      detail,
      text,
    }),
  );
}

/** 取某个层级的正文。`abstract` 来自候选本身，不产生 IO。 */
function textAt(
  state: AssemblyState,
  candidate: AssemblyCandidate,
  detail: ContextDetail,
): Promise<string | null> {
  switch (detail) {
    case 'abstract':
      return Promise.resolve(candidate.abstract);
    case 'overview':
      return state.readOverview(candidate.uri);
    case 'full':
      return state.readBody(candidate.uri);
  }
}

/**
 * 起始投放 + 降级（§8.6 第 2 步的前半段）。
 *
 * 先算「只剩 URI」的成本：装不下就直接丢弃，**不读任何文件**。装得下再沿起始层
 * 往下找第一个放得下的层级。
 *
 * 单条上限不在这里生效：降级是「这条正文放不进总预算」，而单条上限是「高价值条目
 * 可以比平均多占预算」的公平机制，只约束升级。
 */
async function placeSlot(
  state: AssemblyState,
  candidate: AssemblyCandidate,
): Promise<Slot | null> {
  const uriOnlyTokens = costOf(state.ports, candidate, null, '');
  if (uriOnlyTokens > state.remaining) {
    state.dropped += 1;
    return null;
  }

  let detail: ContextDetail | null =
    candidate.memoryType === EVENT_MEMORY_TYPE ? 'overview' : 'abstract';

  while (detail !== null) {
    const text = await textAt(state, candidate, detail);
    if (text !== null) {
      const tokens = costOf(state.ports, candidate, detail, text);
      if (tokens <= state.remaining) {
        state.remaining -= tokens;
        return { candidate, detail, text, tokens };
      }
    }
    detail = COARSER_DETAIL[detail];
  }

  state.remaining -= uriOnlyTokens;
  return { candidate, detail: null, text: '', tokens: uriOnlyTokens };
}

/**
 * 一个升级轮次（§8.6 第 2 步的后半段）。
 *
 * 并发读、顺序判：读可以先发生，但「升不升」必须按分数序贪心，否则预算分配依赖
 * 响应到达顺序，结果不可复现。`cap` 为 `null` 表示这一轮不受单条上限约束。
 *
 * 总预算已经用完时直接返回，不发任何读请求。
 */
async function upgradeRound(
  state: AssemblyState,
  slots: readonly Slot[],
  target: ContextDetail,
  cap: number | null,
): Promise<void> {
  if (state.remaining <= 0 || slots.length === 0) {
    return;
  }

  const results = await mapWithConcurrency(slots, READ_CONCURRENCY, async (slot) => ({
    slot,
    text: await textAt(state, slot.candidate, target),
  }));

  for (const { slot, text } of results) {
    if (text === null) {
      continue;
    }
    const tokens = costOf(state.ports, slot.candidate, target, text);
    if (cap !== null && tokens > cap) {
      continue;
    }
    const delta = tokens - slot.tokens;
    if (delta > state.remaining) {
      continue;
    }
    state.remaining -= delta;
    slot.detail = target;
    slot.text = text;
    slot.tokens = tokens;
  }
}

/**
 * 去重键（§8.6 第 3 步）。
 *
 * 给正文就按正文去重：同一个文件的 L0 摘要和 L2 原文如果内容一样，注入两次只是
 * 浪费。只剩 URI 的条目用 URI 当键——它渲染出来就只有地址，正文为空时按空串去重
 * 会把「两个不同的 URI」误判成重复，而它们下一轮都还得给。
 */
function dedupeKey(slot: Slot): string {
  return slot.detail === null ? slot.candidate.uri : slot.text;
}

/**
 * 组装。返回可直接注入模型的文本，以及每条的投放层级与 token 成本。
 *
 * `excludedUris` 里的候选在第一步之前就被过滤掉，且**不计入** `dropped`：
 * 它们不是「被预算或配额丢掉」，而是上一轮已经给过、这一轮主动不重复。同理，
 * 第 3 步去重造成的条目减少也不计入——`dropped` 只回答「预算不够丢了几条」和
 * 「配额满了丢了几条」。
 */
export async function assembleContext(
  candidates: readonly AssemblyCandidate[],
  options: AssemblyOptions,
  ports: AssemblyPorts,
): Promise<AssemblyResult> {
  const budget = options.maxTokens;
  if (!Number.isFinite(budget) || budget < 0) {
    throw new ComemError('INVALID_ARGUMENT', 'maxTokens 必须是非负有限数。', {
      maxTokens: budget,
    });
  }

  const excluded = options.excludedUris;
  const included =
    excluded === undefined
      ? [...candidates]
      : candidates.filter((candidate) => !excluded.has(candidate.uri));
  const ordered = included.sort(compareByScore);

  // 单条上限按**参与组装**的条目数算：被 `excludedUris` 过滤掉的条目不占预算。
  const perItemCap = perItemTokenCap(budget, ordered.length);

  const state: AssemblyState = {
    ports,
    readOverview: memoizeRead(ports.readOverview),
    readBody: memoizeRead(ports.readBody),
    remaining: budget,
    dropped: 0,
  };

  // 第 1、2 步前半：按分数序贪心投放。
  const slots: Slot[] = [];
  for (const candidate of ordered) {
    const slot = await placeSlot(state, candidate);
    if (slot !== null) {
      slots.push(slot);
    }
  }

  // 第 2 步后半：三轮升级。天花板只剩 `overview` 的类别（技能）不进入后两轮。
  await upgradeRound(
    state,
    slots.filter(
      (slot) =>
        slot.detail === 'abstract' && DEPTH_CEILING[slot.candidate.contextType] !== 'abstract',
    ),
    'overview',
    perItemCap,
  );
  await upgradeRound(
    state,
    slots.filter(
      (slot) => slot.detail !== 'full' && DEPTH_CEILING[slot.candidate.contextType] === 'full',
    ),
    'full',
    perItemCap,
  );
  await upgradeRound(
    state,
    slots.filter(
      (slot) => slot.detail !== 'full' && DEPTH_CEILING[slot.candidate.contextType] === 'full',
    ),
    'full',
    null,
  );

  // 第 3 步：去重。借 `ranking` 已有的实现，按对象引用映射回 slot。
  const slotByRanked = new Map<RankedCandidate, Slot>();
  const ranked = slots.map((slot) => {
    const entry: RankedCandidate = {
      uri: slot.candidate.uri,
      level: slot.candidate.level,
      score: slot.candidate.score,
      rendered: dedupeKey(slot),
    };
    slotByRanked.set(entry, slot);
    return entry;
  });
  const deduped = dedupeByRenderedText(ranked)
    .map((entry) => slotByRanked.get(entry))
    .filter((slot): slot is Slot => slot !== undefined);

  // 第 4 步：配额。去重之后、渲染之前。
  const quota = QUOTA_BY_PRESET[options.quotaPreset];
  const used: Record<ContextType, number> = { memory: 0, resource: 0, skill: 0, session: 0 };
  const kept: Slot[] = [];
  for (const slot of deduped) {
    const contextType = slot.candidate.contextType;
    if (used[contextType] >= quota[contextType]) {
      state.dropped += 1;
      continue;
    }
    used[contextType] += 1;
    kept.push(slot);
  }

  const items: AssembledItem[] = kept.map((slot) => ({
    uri: slot.candidate.uri,
    contextType: slot.candidate.contextType,
    level: slot.candidate.level,
    score: slot.candidate.score,
    detail: slot.detail,
    text: slot.text,
    tokens: slot.tokens,
  }));
  const tokensUsed = items.reduce((sum, item) => sum + item.tokens, 0);

  ports.logger.debug('上下文组装完成', {
    candidates: ordered.length,
    kept: items.length,
    dropped: state.dropped,
    tokensUsed,
    maxTokens: budget,
  });

  return { items, rendered: renderAll(items), dropped: state.dropped, tokensUsed };
}
