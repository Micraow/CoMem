/**
 * 嵌入应用封装（架构文档 §8.3 的检索接口、§18 的 `providers.embedding`）。
 *
 * 这一层只依赖 `domain/embedding.ts` 的 `EmbeddingProvider` 接口，**永远不**
 * import `ai`：供应商适配器在 `adapters/llm/embedding-provider.ts`。它负责三件事：
 *
 * 1. **永不把失败抛给调用方。** 嵌入是派生数据（§7：文件是真相，索引是派生）。
 *    写记忆的主路径不能因为供应商抖动而失败——派生数据丢了大不了下次重建，而
 *    一次写失败会直接丢掉用户的数据。
 * 2. **熔断。** 供应商挂掉时每个请求都打满超时预算，比直接返回降级结果慢几个
 *    数量级。连续失败够多之后直接短路，给供应商一个恢复窗口。
 * 3. **按 `maxBatchSize` 分批。** 供应商自己也会分，服务层再切一次是为了让「一批
 *    失败只影响这一批」——不把一次 1000 条的调用压成一个不可用的整体。
 *
 * ## 降级语义
 *
 * `degraded: true` 表示「这次没拿到向量」，**不是**「没有相关结果」。调用方据此
 * 决定怎么办：`hybrid` 退化成纯 FTS5，`vector` 返回空命中并说明原因。两种都不
 * 静默换引擎——静默换引擎比空结果更让人困惑。
 */

import type { EmbeddingProvider, EmbeddingResult } from '../domain/embedding.js';
import { assertValidVector, normalizeVector, quantizeVector } from '../domain/embedding.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';

export interface EmbeddingServiceDeps {
  /** `null` = 未配置（`type: disabled`） */
  readonly provider: EmbeddingProvider | null;
  readonly logger: Logger;
  readonly config: {
    readonly dimension: number;
    readonly maxBatchSize: number;
    readonly timeoutMs: number;
  };
}

export interface EmbedOutcome {
  /** 与入参同序的向量；失败时是空数组 */
  readonly vectors: readonly (readonly number[])[];
  /** 是否降级（没配置 / 熔断打开 / 供应商失败） */
  readonly degraded: boolean;
  /** 降级原因；`degraded: false` 时是 `null` */
  readonly reason: string | null;
}

export interface EmbeddingStats {
  /** 打出去的供应商请求数（一批算一次） */
  readonly calls: number;
  /** 失败的供应商请求数 */
  readonly failures: number;
  /** 供应商返回的 token 总数（只累加成功的批次） */
  readonly tokens: number;
  /** 返回 `degraded: true` 的 `embed()` 调用次数。熔断打开过一定体现在这里 */
  readonly degradedCalls: number;
}

/**
 * 连续失败多少次后打开熔断。
 *
 * 5 是经验值：单次失败可能是抖动（网络闪断、供应商偶发 5xx），连续 5 次已经能
 * 确认不是抖动。取更大值会让供应商挂掉后的每个请求都白等一个超时；取更小值会在
 * 正常抖动时过早短路。
 */
const FAILURE_THRESHOLD = 5;

/**
 * 熔断打开后多久允许探测，毫秒。
 *
 * 30 秒是经验值：给供应商一个恢复窗口，同时不让写路径在整段故障期间持续打网络。
 * 与 `timeoutSeconds` 默认 30 秒是同一个量级——探测本身要花掉一个超时预算。
 */
const COOLDOWN_MS = 30_000;

/**
 * 量化上界。与 `domain/embedding.ts` 的 `INT8_MAX` 是同一个数，那个常量没有
 * 导出；这里重复一个字面量而不是把领域层内部常量抬成公共 API。
 */
const QUANTIZATION_MAX = 127;

type CircuitState = 'closed' | 'open' | 'half-open';

interface MutableStats {
  calls: number;
  failures: number;
  tokens: number;
  degradedCalls: number;
}

/**
 * 量化并算出落库用的 scale。
 *
 * 先归一化再量化：余弦相似度在单位向量上退化成点积，而 `SqliteVectorIndex` 读取
 * 时按同一个公式还原。`scale = maxAbs / 127` 与 `quantizeVector` 内部的映射一致
 * （见 `domain/embedding.ts` 的 `quantizeVector` 注释）。
 */
export function quantizeForStorage(vector: readonly number[]): {
  readonly vector: Uint8Array;
  readonly scale: number;
} {
  const normalized = normalizeVector(vector);
  let maxAbs = 0;
  for (const value of normalized) {
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  const quantized = quantizeVector(normalized);
  return {
    // `Int8Array` 与 SQLite BLOB 的 `Uint8Array` 位模式相同，按同一段内存重解释。
    vector: new Uint8Array(quantized.buffer, quantized.byteOffset, quantized.length),
    scale: maxAbs === 0 ? 0 : maxAbs / QUANTIZATION_MAX,
  };
}

export class EmbeddingService {
  readonly #provider: EmbeddingProvider | null;
  readonly #logger: Logger;
  readonly #config: EmbeddingServiceDeps['config'];

  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #openedAt = 0;
  /** 半开状态下是否已经放出一个探测请求。并发调用只有一个能成为探测。 */
  #probeInFlight = false;
  #stats: MutableStats = { calls: 0, failures: 0, tokens: 0, degradedCalls: 0 };

  constructor(deps: EmbeddingServiceDeps) {
    const { dimension, maxBatchSize, timeoutMs } = deps.config;
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new ComemError('INVALID_ARGUMENT', '嵌入维度必须是正整数。', { dimension });
    }
    if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
      throw new ComemError('INVALID_ARGUMENT', 'maxBatchSize 必须是正整数。', { maxBatchSize });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ComemError('INVALID_ARGUMENT', 'timeoutMs 必须是正整数。', { timeoutMs });
    }

    this.#provider = deps.provider;
    this.#logger = deps.logger;
    this.#config = deps.config;
  }

  /**
   * 是否可用于检索：有供应商，且熔断没有处于「打开且仍在冷却」的状态。
   *
   * 半开状态返回 `false`：探测在途时让其它调用走降级路径，不要一起打网络。
   * 冷却结束但还没人探测时返回 `true`——下一次 `embed()` 会成为探测。
   */
  get available(): boolean {
    if (this.#provider === null) {
      return false;
    }
    switch (this.#state) {
      case 'closed':
        return true;
      case 'half-open':
        return false;
      case 'open':
        return Date.now() - this.#openedAt >= COOLDOWN_MS;
    }
  }

  /** 索引里记录的模型标识；未配置时是 `null`。`SqliteVectorIndex.search` 要用它过滤旧行。 */
  get model(): string | null {
    return this.#provider?.model ?? null;
  }

  /**
   * 批量嵌入。**永不抛**（除非入参本身非法）。
   *
   * 空输入直接返回、**不调网络**：回填任务在「没有待处理节点」时不应该产生一次
   * 计费请求，也不应该因为供应商不可用而失败。
   */
  async embed(texts: readonly string[]): Promise<EmbedOutcome> {
    if (texts.length === 0) {
      return { vectors: [], degraded: false, reason: null };
    }

    const provider = this.#provider;
    if (provider === null) {
      return this.#degrade('没有配置 providers.embedding');
    }

    const admission = this.#admit();
    if (admission !== null) {
      return admission;
    }
    // `#admit` 把 `open` 转成 `half-open` 之后，这次调用就是唯一被放行的探测。
    // 用局部标记而不是在 `finally` 里读 `#state`：并发调用可能已经把它改回
    // `open`，只有本次调用有权释放占位。
    const isProbe = this.#state === 'half-open';
    if (isProbe) {
      this.#probeInFlight = true;
    }

    const vectors: number[][] = [];
    try {
      for (let start = 0; start < texts.length; start += this.#config.maxBatchSize) {
        const batch = texts.slice(start, start + this.#config.maxBatchSize);
        this.#stats.calls += 1;

        let result: EmbeddingResult;
        try {
          result = await provider.embed(batch, { timeoutMs: this.#config.timeoutMs });
        } catch (error) {
          this.#stats.failures += 1;
          this.#recordFailure();
          const failure = ComemError.from(error);
          return this.#degrade(`嵌入调用失败（${failure.code}）：${failure.message}`);
        }

        // 条数不一致是供应商的 bug：把结果写回 `node_embedding` 会让向量与 URI
        // 错位，比直接降级严重得多。
        if (result.vectors.length !== batch.length) {
          this.#stats.failures += 1;
          this.#recordFailure();
          return this.#degrade(
            `嵌入供应商返回的向量条数不一致：期望 ${batch.length}，实际 ${result.vectors.length}。`,
          );
        }

        try {
          for (const vector of result.vectors) {
            assertValidVector(vector, this.#config.dimension);
            vectors.push([...vector]);
          }
        } catch (error) {
          // 维度 / NaN / 全零是配置或供应商的问题，不是「入参非法」：降级而不抛，
          // 让写路径继续，同时把原因留给日志。
          this.#stats.failures += 1;
          this.#recordFailure();
          const failure = ComemError.from(error);
          return this.#degrade(`嵌入供应商返回的向量不合法：${failure.message}`);
        }

        this.#stats.tokens += result.usage.totalTokens;
      }

      this.#recordSuccess();
      return { vectors, degraded: false, reason: null };
    } finally {
      // 探测不论成功失败都要释放占位，否则半开状态下永远没有下一次探测。
      if (isProbe) {
        this.#probeInFlight = false;
      }
    }
  }

  /** 用量统计（`/metrics` 与 `health` 用）。返回快照，调用方改不到内部状态。 */
  stats(): EmbeddingStats {
    return { ...this.#stats };
  }

  /**
   * 熔断准入。返回非 `null` 表示这次调用直接降级，不打网络。
   *
   * 状态机：`closed` 正常调用 → 连续失败够多转 `open` → 冷却结束后第一个调用转
   * `half-open` 当探测 → 成功回 `closed`，失败回 `open` 重新计时。
   */
  #admit(): EmbedOutcome | null {
    if (this.#state === 'open') {
      if (Date.now() - this.#openedAt < COOLDOWN_MS) {
        return this.#degrade(
          `嵌入熔断已打开（连续 ${this.#consecutiveFailures} 次失败），冷却 ${COOLDOWN_MS} 毫秒后再试。`,
        );
      }
      // 冷却结束：放一个探测。下面的 `#probeInFlight` 挡掉并发调用。
      this.#state = 'half-open';
    }
    if (this.#state === 'half-open' && this.#probeInFlight) {
      return this.#degrade('嵌入熔断半开，已有探测请求在途。');
    }
    return null;
  }

  #recordFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < FAILURE_THRESHOLD) {
      return;
    }
    const wasOpen = this.#state === 'open';
    this.#state = 'open';
    this.#openedAt = Date.now();
    if (!wasOpen) {
      this.#logger.warn('嵌入熔断打开', {
        consecutiveFailures: this.#consecutiveFailures,
        cooldownMs: COOLDOWN_MS,
      });
    }
  }

  #recordSuccess(): void {
    if (this.#state !== 'closed') {
      this.#logger.info('嵌入熔断恢复', {
        previousState: this.#state,
        consecutiveFailures: this.#consecutiveFailures,
      });
    }
    this.#state = 'closed';
    this.#consecutiveFailures = 0;
    this.#openedAt = 0;
  }

  #degrade(reason: string): EmbedOutcome {
    this.#stats.degradedCalls += 1;
    this.#logger.warn('嵌入降级', { reason });
    return { vectors: [], degraded: true, reason };
  }
}
