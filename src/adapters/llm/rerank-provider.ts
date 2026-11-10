/**
 * Cohere / Jina 兼容的重排适配器（架构文档 §18 的 `providers.rerank`）。
 *
 * 这一层只做四件事：把 `(query, documents)` 编码成 `POST /v1/rerank` 的请求体、
 * 按 `index` 把响应回填成与入参等长的数组、把 HTTP 错误收敛成 `ComemError`、把
 * 超时变成可重试的错误。
 *
 * **不重试。** 与 `ai-sdk-provider.ts` / `embedding-provider.ts` 同一条理由：重试
 * 策略在上层，它还要判断「超时该降级到融合分」这类事；适配器里再重试一次只会
 * 把「重排慢」变成「检索慢 3 倍」。
 *
 * **错误映射与生成、嵌入共用。** 三份各自复制时，同一个故障在两条链路上给出相反
 * 的重试结论没有任何机制能拦住；规则与理由见 `provider-error-mapping.ts`。重排
 * 唯一多出来的约定是超时在 `details` 里带 `timeout: true`，见 `ERROR_MAP_OPTIONS`。
 */

import { ComemError } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type { Logger } from '../../domain/log.js';
import { isFiniteScore, type RerankOptions, type RerankProvider } from '../../domain/rerank.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';
import {
  mapProviderError,
  type ProviderErrorContext,
  type ProviderErrorMapOptions,
} from './provider-error-mapping.js';

export interface HttpRerankProviderOptions {
  /** 供应商根地址，如 `https://api.jina.ai/v1`。末尾斜杠会被去掉。 */
  readonly baseUrl: string;
  /** 重排模型标识，如 `BAAI/bge-reranker-v2-m3`。 */
  readonly model: string;
  /** 为空时不发 `Authorization` 头（本地部署的重排服务通常不校验）。 */
  readonly apiKey: string;
  /**
   * 单次重排超时，秒。默认 30（`config/schema.ts` 的 `providers.rerank.timeoutSeconds`）。
   *
   * 重排在检索路径上串行执行，超时预算直接加在用户等待时间上。30 秒来自实测：
   * 本地 `Qwen3-Reranker-0.6B` 重排 50 条候选 8.05 秒 p50 / 9.35 秒 p95
   * （`eval/README.md` 的 105 条基线）。远程 8B 重排 50 条只要 1.8–2.7 秒。
   */
  readonly timeoutSeconds: number;
  readonly logger: Logger;
  /** 注入 fetch 便于测试；默认全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Cohere 兼容的重排路径（相对 `baseUrl`）。
 *
 * Cohere v1 / v2 与 Jina 都是 `POST /rerank`；`baseUrl` 里已经带 `/v1` 时拼出来
 * 就是 `/v1/rerank`。
 */
const RERANK_PATH = '/rerank';

/**
 * 重排链路的错误映射参数（架构文档 §19）。
 *
 * `markTimeout` 是三条链路里唯一需要保留的差异：`services/search.ts` 靠
 * `details.timeout === true` 把降级原因记成「超时」而不是「网络」。
 */
const ERROR_MAP_OPTIONS: ProviderErrorMapOptions = {
  call: '重排调用',
  vendor: '重排供应商',
  invalidArgumentHint: '请检查模型名、baseUrl 与请求体格式',
  networkHint: '请检查网络与 baseUrl',
  markTimeout: true,
};

/** 保留本地名字：`services/search.ts` 的注释按这个名字指路。 */
function mapRerankError(error: unknown, context: ProviderErrorContext): ComemError {
  return mapProviderError(error, context, ERROR_MAP_OPTIONS);
}

/**
 * 把响应体回填成与 `documents` 等长的数组，缺失 / 不可用的位置是 `null`。
 *
 * **按 `index` 回填，不是按结果顺序**：供应商只返回 `top_n` 条时结果是「最相关的
 * N 条」，顺序与文档顺序无关。按顺序回填会把第 3 条文档的分数写到第 1 条上，
 * 而且不报错。
 *
 * 越界的 `index` 直接丢弃：写进数组会越界（JS 里不会抛，只是多一个不被读取的
 * 属性），当作「没返回」比让调用方拿到脏数据好。
 */
function readResults(body: unknown, count: number): (number | null)[] {
  const results = isRecord(body) ? body['results'] : undefined;
  if (!Array.isArray(results)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '重排供应商的响应缺少 results 数组，请确认 baseUrl 指向 Cohere 兼容的 /rerank 接口。',
      { field: 'results' },
    );
  }

  const scores: (number | null)[] = new Array<number | null>(count).fill(null);
  for (const entry of results) {
    if (!isRecord(entry)) {
      continue;
    }
    const index: unknown = entry['index'];
    const score: unknown = entry['relevance_score'];
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      continue;
    }
    if (index < 0 || index >= count || !isFiniteScore(score)) {
      // 越界或分数不可用（`null` / `NaN` / 字符串）：当作「这一条没返回」，
      // 由 `applyRerank` 用兜底分填。
      continue;
    }
    scores[index] = score;
  }
  return scores;
}

export class HttpRerankProvider implements RerankProvider {
  readonly model: string;

  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutSeconds: number;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  constructor(options: HttpRerankProviderOptions) {
    if (options.baseUrl.trim() === '') {
      throw new ComemError(
        'INVALID_ARGUMENT',
        'providers.rerank.type 为 http 时 baseUrl 不能为空。',
        { field: 'providers.rerank.baseUrl' },
      );
    }
    const timeoutSeconds = options.timeoutSeconds;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new ComemError('INVALID_ARGUMENT', '重排超时必须是正的有限数（秒）。', {
        timeoutSeconds,
      });
    }

    this.model = options.model;
    // 去掉末尾斜杠再拼路径：`https://host/v1/` 与 `https://host/v1` 必须得到同一个 URL。
    this.#endpoint = `${options.baseUrl.replace(/\/+$/, '')}${RERANK_PATH}`;
    this.#apiKey = options.apiKey;
    this.#timeoutSeconds = timeoutSeconds;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * 给候选打分。
   *
   * 空 `documents` 直接返回，**不调网络**：没有候选时发一次请求只会多一次计费
   * 调用，还会因为供应商不可用让一次本来正常的检索失败。
   *
   * `top_n` 取 `documents.length`：调用方已经按 `providers.rerank.topN` 截过候选，
   * 适配器这一层要的是「给这些文档全部打分」，再截一次会把「候选宽度」这个决策
   * 分散到两个地方。
   */
  async score(
    query: string,
    documents: readonly string[],
    options?: RerankOptions,
  ): Promise<readonly (number | null)[]> {
    if (documents.length === 0) {
      return [];
    }

    return this.#run(async (abortSignal) => {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          model: this.model,
          query,
          documents: [...documents],
          top_n: documents.length,
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        // 交给 mapRerankError 按状态码收敛；这里不自己拼 ComemError，否则两处
        // 映射规则会漂移。
        throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // 200 但不是 JSON：baseUrl 大概率指向了一个网页而不是重排接口。重试同样的
        // 地址只会再拿到一次 HTML，所以映射成不可重试的 INVALID_ARGUMENT。
        throw new ComemError(
          'INVALID_ARGUMENT',
          '重排供应商返回的不是合法 JSON，请确认 baseUrl 指向 Cohere 兼容的 /rerank 接口。',
          { field: 'providers.rerank.baseUrl' },
        );
      }

      const scores = readResults(body, documents.length);
      this.#logger.debug('重排调用', {
        model: this.model,
        documents: documents.length,
        scored: scores.filter((score) => score !== null).length,
      });
      return scores;
    }, options);
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey !== '') {
      headers['authorization'] = `Bearer ${this.#apiKey}`;
    }
    return headers;
  }

  /**
   * 单次调用的超时与取消。
   *
   * 超时用 `AbortController` + `setTimeout` 取消底层请求。`RerankOptions.signal`
   * （HTTP 请求断开时由接口层传入）与超时信号用 `AbortSignal.any` 合并——任一
   * 触发都中止这次调用。
   *
   * `RerankOptions.timeoutMs` 是**上限**：实际取
   * `min(构造时的 timeoutSeconds * 1000, timeoutMs)`，内部预算只能收紧用户配置。
   *
   * 定时器 `unref()`：正常结束时它会清掉，但进程退出时不该被一个 10 秒的计时器拖住。
   */
  async #run<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
    options?: RerankOptions,
  ): Promise<T> {
    // `timeoutMs` 是**上限**，不是覆盖值：`providers.rerank.timeoutSeconds` 是
    // 用户配的预算，检索在总上限内只能收紧它（`QUERY_RERANK_TIMEOUT_MS`）。反过来
    // 放宽会让「配置 1 秒」实际等 12 秒，配置项等于没生效。
    const configuredMs = this.#timeoutSeconds * MILLISECONDS_PER_SECOND;
    const timeoutMs =
      options?.timeoutMs === undefined ? configuredMs : Math.min(configuredMs, options.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    const abortSignal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);

    try {
      return await operation(abortSignal);
    } catch (error) {
      throw mapRerankError(error, { timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }
}
