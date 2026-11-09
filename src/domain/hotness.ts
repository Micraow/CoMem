/**
 * 热度衰减（架构文档 §17.5 记忆健康度）。
 *
 * 热度回答的问题是「这条记忆现在还值得留着吗」：三个月前的临时笔记和昨天的核心
 * 约定在检索分上不区分，在热度上必须区分。
 *
 * **纯函数，无 IO。** 时间通过 `now` 注入，测试不需要假时钟，也不需要等真实时间
 * 流逝一小时才能断言「越旧分数越低」。
 *
 * 输入来自 `node.access_count` / `node.last_accessed_at` 两列
 * （`0001_init.sql` 的 `node` 表）。这两列由 `NodeRepository.recordAccess` 在检索命中
 * 时累加，**不碰 `updated_at`**——访问不是修改。
 */

import { ComemError } from './errors.js';

/**
 * 默认半衰期：7 天。
 *
 * 来源：一周是一个自然的工作节奏，超过它的记忆需要主动回忆才会被访问。与架构文档
 * §17.5 的 `telemetry.hotness.halfLifeHours` 默认值（168 小时）是同一个数，两处
 * 必须同时改。
 */
export const DEFAULT_HALF_LIFE_DAYS = 7;

/** 一天的毫秒数。时间差是毫秒，公式的输入是天，换算只有这一处。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 一条记忆的热度分，`[0, 1]`。
 *
 * `score = sigmoid(log1p(activeCount)) × exp(-ln2 × ageDays / halfLifeDays)`
 *
 * **为什么频率取对数再 sigmoid**：访问次数是长尾分布，1 次和 10 次的差别很大，
 * 10 次和 100 次的差别就小了。`log1p` 压长尾，`sigmoid` 把无界值压进 `(0, 1)`。
 * 直接拿次数归一化会让「被访问 1000 次的索引页」永久霸占榜首。
 *
 * **为什么用指数衰减而不是线性**：记忆的相关性不随天数线性下降。「一周前的笔记」
 * 和「一个月前的笔记」的差别，比「一天前」和「一周前」的差别小得多。指数衰减
 * 的表达是「每过一个半衰期，权重减半」，这个语义可以直接向用户解释。
 *
 * **参数校验先于 `lastAccessedAt` 的短路返回**：半衰期是除数，0 会让整个公式变成
 * `Infinity`，而 `Infinity` 参与比较时不报错，只让排序结果毫无意义。配置错误不该
 * 因为这条记忆恰好没被访问过就被掩盖。
 *
 * **未来时间戳按 0 天算**：多机部署时客户端与服务器时钟可能不同步，访问时间落在
 * 「未来」是正常现象。按负年龄算会让衰减变成放大，分数冲破 1；按 0 天算至少保持
 * 单调。结果再 clamp 到 `[0, 1]` 兜住浮点误差。
 */
export function hotnessScore(input: {
  readonly activeCount: number;
  readonly lastAccessedAt: string | null;
  readonly now?: Date;
  readonly halfLifeDays: number;
}): number {
  const { activeCount, lastAccessedAt, halfLifeDays } = input;

  if (!Number.isFinite(activeCount) || activeCount < 0) {
    throw new ComemError('INVALID_ARGUMENT', 'activeCount 必须是非负有限数。', { activeCount });
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    // 半衰期是除数。0 得到 Infinity，负数得到「越旧越热」，两者都不报错，只是让
    // 排序结果失去意义——这是最难排查的一类缺陷，所以在入口处拒绝。
    throw new ComemError('INVALID_ARGUMENT', 'halfLifeDays 必须是正的有限数。', { halfLifeDays });
  }
  if (lastAccessedAt === null) {
    // 从没访问过的记忆热度是 0，不是「最热」：`log1p(0)` 是 0，`sigmoid(0)` 是 0.5，
    // 直接代入公式会得到「半热」，而「从没被读过」本身不是热度。
    return 0;
  }

  const lastAccessMs = Date.parse(lastAccessedAt);
  if (Number.isNaN(lastAccessMs)) {
    // 不要当 0 处理：静默当 0 会让「数据坏了」表现成「这条记忆很冷」，然后被淘汰掉。
    throw new ComemError(
      'INVALID_ARGUMENT',
      `lastAccessedAt 不是合法的时间串：${lastAccessedAt}`,
      { lastAccessedAt },
    );
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) {
    throw new ComemError('INVALID_ARGUMENT', 'now 不是合法的 Date。', { now: now.toString() });
  }

  const ageDays = Math.max(0, (nowMs - lastAccessMs) / MILLISECONDS_PER_DAY);
  const frequency = 1 / (1 + Math.exp(-Math.log1p(activeCount)));
  const decay = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);

  return Math.min(1, Math.max(0, frequency * decay));
}
