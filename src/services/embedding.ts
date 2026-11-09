/**
 * 嵌入应用封装（架构文档 §8.3 的检索接口、§18 的 `providers.embedding`）。
 *
 * 这一层只依赖 `domain/embedding.ts` 的 `EmbeddingProvider` 接口，**永远不**
 * import `ai`：供应商适配器在 `adapters/llm/embedding-provider.ts`。它负责四件事：
 *
 * 1. **永不把失败抛给调用方。** 嵌入是派生数据（§7：文件是真相，索引是派生）。
 *    写记忆的主路径不能因为供应商抖动而失败——派生数据丢了大不了下次重建，而
 *    一次写失败会直接丢掉用户的数据。
 * 2. **熔断。** 供应商挂掉时每个请求都打满超时预算，比直接返回降级结果慢几个
 *    数量级。连续失败够多之后直接短路，给供应商一个恢复窗口。
 * 3. **按 `maxBatchSize` 分批。** 供应商自己也会分，服务层再切一次是为了让「一批
 *    失败只影响这一批」——不把一次 1000 条的调用压成一个不可用的整体。
 * 4. **跨调用缓存。** `(model, content_digest) → 向量` 命中就不打网络（见
 *    `adapters/sqlite/embedding-cache.ts`）。放在这一层而不是某个调用方，是因为
 *    「同一段文本嵌过没有」与调用方无关：写路径、检索路径、回填路径都该命中。
 *
 * ## 降级语义
 *
 * `degraded: true` 表示「这次没拿到向量」，**不是**「没有相关结果」。调用方据此
 * 决定怎么办：`hybrid` 退化成纯 FTS5，`vector` 返回空命中并说明原因。两种都不
 * 静默换引擎——静默换引擎比空结果更让人困惑。
 *
 * ## 缓存与熔断的关系
 *
 * **命中不推进熔断状态**：命中证明不了供应商可用，拿它 `#recordSuccess` 会让熔断
 * 在供应商仍然挂着时被一次缓存命中关掉。反过来，缓存**读失败**按未命中处理、**写
 * 失败**只记 warn——缓存坏掉不能变成嵌入失败（§7 的同一原则）。
 *
 * 部分命中时只把未命中的那几条送供应商：省 token 是次要的，主要是一条坏缓存行
 * 不会把整批拖成未命中。
 */

import type { EmbeddingCacheEntry } from '../adapters/sqlite/embedding-cache.js';
import type {
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingResult,
} from '../domain/embedding.js';
import { assertValidVector } from '../domain/embedding.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { stableDigest } from '../domain/node.js';

export interface EmbeddingServiceDeps {
  /** `null` = 未配置（`type: disabled`） */
  readonly provider: EmbeddingProvider | null;
  readonly logger: Logger;
  /**
   * 嵌入缓存。`null` = 不用缓存（`providers.embedding.cache.enabled: false`）。
   *
   * 必填 `| null` 而不是可选：`pnpm check:config` 的 L2 门禁要求「配置派生依赖
   * 写成必填属性」，可选属性漏传时类型系统不报错，而症状是缓存静默失效。
   */
  readonly cache: EmbeddingCachePort | null;
  readonly config: {
    readonly dimension: number;
    readonly maxBatchSize: number;
    readonly timeoutMs: number;
  };
}

/**
 * 缓存的最小接口。`EmbeddingCacheRepository` 结构化满足它。
 *
 * 声明在这里而不是直接 `Pick<EmbeddingCacheRepository, ...>`：测试需要一个「写就
 * 抛错」的替身来验证写失败降级，而真实仓储的 `put` 不会抛（除非磁盘满）。
 */
export interface EmbeddingCachePort {
  getMany(
    model: string,
    digests: readonly string[],
    dimension: number,
  ): ReadonlyMap<string, readonly number[]>;
  put(entries: readonly EmbeddingCacheEntry[]): void;
}

export interface EmbedOutcome {
  /** 与入参同序的向量；失败时是空数组 */
  readonly vectors: readonly (readonly number[])[];
  /** 是否降级（没配置 / 熔断打开 / 供应商失败） */
  readonly degraded: boolean;
  /** 降级原因；`degraded: false` 时是 `null` */
  readonly reason: string | null;
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

type CircuitState = 'closed' | 'open' | 'half-open';

/** 一次供应商批量调用的结果：成功给向量，失败给降级结果（已记日志、已计数）。 */
type BatchOutcome =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly outcome: EmbedOutcome };

/** 一条未命中的输入。带下标是为了把供应商返回的结果按原位置对回去。 */
interface CacheMiss {
  readonly index: number;
  readonly text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EmbeddingService {
  readonly #provider: EmbeddingProvider | null;
  readonly #logger: Logger;
  readonly #cache: EmbeddingCachePort | null;
  readonly #config: EmbeddingServiceDeps['config'];

  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #openedAt = 0;
  /** 半开状态下是否已经放出一个探测请求。并发调用只有一个能成为探测。 */
  #probeInFlight = false;

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
    this.#cache = deps.cache;
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
   * 单次供应商调用的条数上限。
   *
   * 写路径（`IndexObserver`）按它把队列切片：它自己已经排好队，再让 `embed()`
   * 内部切一次会让「N 条记录 → `ceil(N / maxBatchSize)` 次请求」这个契约依赖两层
   * 循环的对齐。
   */
  get maxBatchSize(): number {
    return this.#config.maxBatchSize;
  }

  /**
   * 批量嵌入。**永不抛**（除非入参本身非法）。
   *
   * 空输入直接返回、**不调网络**：回填任务在「没有待处理节点」时不应该产生一次
   * 计费请求，也不应该因为供应商不可用而失败。
   *
   * 缓存命中先短路：全部命中时不碰熔断状态、不打网络（见文件头）。
   *
   * `options` 只给**查询路径**用：MCP 工具的总预算比 `providers.embedding.timeoutSeconds`
   * 短（见 `services/search.ts` 的 `QUERY_EMBED_TIMEOUT_MS`），不把剩余预算传下去
   * 的话，接口层到点返回了、供应商请求还在后台跑到 30 秒。写路径不传，行为不变。
   */
  async embed(
    texts: readonly string[],
    options?: EmbeddingOptions,
  ): Promise<EmbedOutcome> {
    if (texts.length === 0) {
      return { vectors: [], degraded: false, reason: null };
    }

    const provider = this.#provider;
    if (provider === null) {
      return this.#degrade('没有配置 providers.embedding');
    }

    const cached = this.#lookup(texts, provider.model);
    if (cached.size === texts.length) {
      return { vectors: this.#merge(texts, cached, new Map()), degraded: false, reason: null };
    }
    const misses: CacheMiss[] = [];
    for (const [index, text] of texts.entries()) {
      if (!cached.has(index)) {
        misses.push({ index, text });
      }
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

    try {
      const produced = new Map<number, readonly number[]>();
      for (let start = 0; start < misses.length; start += this.#config.maxBatchSize) {
        const chunk = misses.slice(start, start + this.#config.maxBatchSize);
        const result = await this.#embedBatch(
          provider,
          chunk.map((miss) => miss.text),
          options,
        );
        if (!result.ok) {
          return result.outcome;
        }
        for (const [offset, miss] of chunk.entries()) {
          const vector = result.vectors[offset];
          if (vector !== undefined) {
            produced.set(miss.index, vector);
          }
        }
      }

      this.#recordSuccess();
      this.#store(texts, produced, provider.model);
      return { vectors: this.#merge(texts, cached, produced), degraded: false, reason: null };
    } finally {
      // 探测不论成功失败都要释放占位，否则半开状态下永远没有下一次探测。
      if (isProbe) {
        this.#probeInFlight = false;
      }
    }
  }

  /** 按输入下标合并「缓存命中」与「本次产出」，保证与入参同序。 */
  #merge(
    texts: readonly string[],
    cached: ReadonlyMap<number, readonly number[]>,
    produced: ReadonlyMap<number, readonly number[]>,
  ): readonly (readonly number[])[] {
    const vectors: (readonly number[])[] = [];
    for (let index = 0; index < texts.length; index += 1) {
      const vector = cached.get(index) ?? produced.get(index);
      // 两个 map 都没值只能是上游的 bug（未命中一定走供应商，成功一定写回）。
      // 抛比静默少一条更危险，所以按空向量塞回去——`assertValidVector` 的调用方
      // 会先看到维度不对，而不是看到「少了一条」。
      vectors.push(vector ?? []);
    }
    return vectors;
  }

  /**
   * 一次供应商批量调用。**不抛**：失败映射成降级结果并计数。
   *
   * 单独抽出来是因为它在 `embed()` 的循环里既要 `return` 降级、又要往里塞向量，
   * 内联时那两种退出路径会缠在一起。
   */
  async #embedBatch(
    provider: EmbeddingProvider,
    batch: readonly string[],
    options: EmbeddingOptions | undefined,
  ): Promise<BatchOutcome> {
    let result: EmbeddingResult;
    try {
      result = await provider.embed(batch, {
        // 调用方的预算只能收紧配置值，不能放宽（与 provider 的 `min` 同一语义）。
        timeoutMs: Math.min(options?.timeoutMs ?? this.#config.timeoutMs, this.#config.timeoutMs),
        ...(options?.signal === undefined ? { } : { signal: options.signal }),
      });
    } catch (error) {
      this.#recordFailure();
      const failure = ComemError.from(error);
      return { ok: false, outcome: this.#degrade(`嵌入调用失败（${failure.code}）：${failure.message}`) };
    }

    // 条数不一致是供应商的 bug：把结果写回 `node_embedding` 会让向量与 URI
    // 错位，比直接降级严重得多。
    if (result.vectors.length !== batch.length) {
      this.#recordFailure();
      return {
        ok: false,
        outcome: this.#degrade(
          `嵌入供应商返回的向量条数不一致：期望 ${batch.length}，实际 ${result.vectors.length}。`,
        ),
      };
    }

    const vectors: (readonly number[])[] = [];
    try {
      for (const vector of result.vectors) {
        // 维度不一致单独判，且消息里带两个数字：它最常见的成因是
        // `providers.embedding.dimension` 与模型不符，`assertValidVector` 的
        // 「长度与维度不匹配」不告诉用户该改哪一边。
        if (vector.length !== this.#config.dimension) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `向量维度与配置不一致：providers.embedding.dimension 配置为 ${this.#config.dimension}，供应商返回 ${vector.length}。`,
            { expected: this.#config.dimension, actual: vector.length, model: provider.model },
          );
        }
        assertValidVector(vector, this.#config.dimension);
        vectors.push([...vector]);
      }
    } catch (error) {
      // 维度 / NaN / 全零是配置或供应商的问题，不是「入参非法」：降级而不抛，
      // 让写路径继续，同时把原因留给日志。
      this.#recordFailure();
      const failure = ComemError.from(error);
      return { ok: false, outcome: this.#degrade(`嵌入供应商返回的向量不合法：${failure.message}`) };
    }

    return { ok: true, vectors };
  }

  /**
   * 缓存查询。**读失败按未命中处理**：缓存坏掉不能变成嵌入失败。
   *
   * 返回 `输入下标 → 向量`。同一段正文在入参里出现两次时两条都会被标成命中——
   * 供应商只会看到一条，这正是缓存与写路径去重叠加的效果。
   */
  #lookup(texts: readonly string[], model: string): ReadonlyMap<number, readonly number[]> {
    const hits = new Map<number, readonly number[]>();
    const cache = this.#cache;
    if (cache === null) {
      return hits;
    }
    const digests = texts.map((text) => stableDigest(text));
    let stored: ReadonlyMap<string, readonly number[]>;
    try {
      stored = cache.getMany(model, digests, this.#config.dimension);
    } catch (error) {
      this.#logger.warn('嵌入缓存读取失败，按未命中处理。', {
        model,
        count: digests.length,
        error: errorMessage(error),
      });
      return hits;
    }
    if (stored.size === 0) {
      return hits;
    }
    for (const [index, digest] of digests.entries()) {
      const vector = stored.get(digest);
      if (vector !== undefined) {
        hits.set(index, vector);
      }
    }
    return hits;
  }

  /**
   * 写回本次新产出的向量。**写失败只记 warn**：写入已经成功，缓存是派生数据的
   * 派生，不能反过来让嵌入失败。
   */
  #store(
    texts: readonly string[],
    produced: ReadonlyMap<number, readonly number[]>,
    model: string,
  ): void {
    const cache = this.#cache;
    if (cache === null || produced.size === 0) {
      return;
    }
    const entries: EmbeddingCacheEntry[] = [];
    for (const [index, vector] of produced) {
      const text = texts[index];
      if (text === undefined) {
        continue;
      }
      entries.push({
        model,
        contentDigest: stableDigest(text),
        dimension: this.#config.dimension,
        vector,
      });
    }
    try {
      cache.put(entries);
    } catch (error) {
      this.#logger.warn('嵌入缓存写入失败，已忽略。', {
        model,
        count: entries.length,
        // 写失败找不到是哪个 URI 的缓存行，调用方（写路径）会照常写
        // `node_embedding`——下一次命中不了只是多打一次供应商。
        error: errorMessage(error),
      });
    }
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
    this.#logger.warn('嵌入降级', { reason });
    return { vectors: [], degraded: true, reason };
  }
}
