/**
 * 供应商错误 → `ComemError` 的统一映射（架构文档 §19）。
 *
 * 生成（`ai-sdk-provider.ts`）、嵌入（`embedding-provider.ts`）、重排
 * （`rerank-provider.ts`）三条链路各有一份「把 HTTP 状态码、超时与连接错误翻译成
 * 领域失败」的逻辑。三份逐行比对后，状态码与重试结论本来就已经对齐；真正的差异
 * 只有两处，都作为选项保留：
 *
 * 1. **超时的 `details`。** 重排在 `details` 里多带一个 `timeout: true`，
 *    `services/search.ts` 靠它把降级原因记成 `timeout` 而不是 `network`。生成与
 *    嵌入没有消费者，保持原来的 `{ timeoutMs }`。
 * 2. **结构化输出失败。** 只有生成链路有 `generateObject`，解析失败 / 截断由
 *    `classify` 回调在状态码分支之前处理。嵌入与重排不传这个回调。
 *
 * 共享的理由不是「以后可能加第四家」，而是这三份必须在**同一个故障上给出同一个
 * 重试结论**：同一个供应商的 429 在对话补全里被判成可重试、在嵌入里被判成不可
 * 重试，会让回填与归档出现两套完全不同的失败节奏。三份各写一遍时这种漂移没有
 * 任何机制能拦住。
 *
 * **保守原则：不可重试优先于可重试，除非有证据表明必须重试。** 重试一次确定性
 * 失败只会把「立刻失败」拖成「几秒后失败」，还会在监控里留下假故障。
 *
 * **不解析响应 body 里的错误码，也不读限流头。** 仓库里没有真实供应商的错误
 * body 样本（fixture），凭空按某家的 JSON 形状写规则会在别的兼容实现上误判；
 * `retry-after` 之类只影响退避时长，而退避在 `services/llm.ts`，不在适配器。
 * 这两类形态属于已知缺口，不是已支持。
 */

import { ComemError } from '../../domain/errors.js';

/** 单次调用的超时上下文。区分「超时」与「上游取消」只能靠 `timedOut`。 */
export interface ProviderErrorContext {
  /** 超时定时器是否已经触发。 */
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

export interface ProviderErrorMapOptions {
  /** 调用名，用于超时消息，如「模型调用」「嵌入调用」「重排调用」。 */
  readonly call: string;
  /** 供应商名，用于状态码与网络错误消息，如「模型供应商」。 */
  readonly vendor: string;
  /** 400 类错误的排查提示（不含句末句号），如「请检查模型名、maxTokens 与请求体格式」。 */
  readonly invalidArgumentHint: string;
  /** 网络错误消息的后半句（不含句末句号），如「请检查网络」。 */
  readonly networkHint: string;
  /**
   * 超时时是否在 `details` 里带 `timeout: true`。
   *
   * 只有重排打开它：`services/search.ts` 的 `rerankFailureReason` 用这个标记区分
   * 「超时该调大 timeoutSeconds」与「网络该查 baseUrl」。生成与嵌入链路没有消费者，
   * 打开只会多一个没人读的字段。
   */
  readonly markTimeout?: boolean;
  /**
   * 状态码与网络错误之外的专用分类，在超时判断之后、状态码判断之前调用。
   *
   * 生成适配器用它把结构化输出的解析失败与截断分别映射成 `INVALID_ARGUMENT` 与
   * `PROVIDER_UNAVAILABLE`。返回 `undefined` 表示不属于它处理的形态，继续走
   * 状态码 / 网络 / 兜底 `INTERNAL`。
   */
  readonly classify?: (error: unknown) => ComemError | undefined;
}

/**
 * `APICallError` 的 `statusCode`。用结构判断而不是 `instanceof`：测试替身不必
 * 构造真类，不同 SDK 的错误类也不共享原型链。
 */
function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * 把供应商的错误收敛成稳定的领域失败。
 *
 * 判定顺序有语义：超时 → 专用分类 → 状态码 → 网络 → 兜底。超时排在最前，因为
 * 超时定时器中止请求时底层抛的是 `AbortError`（`DOMException`），它没有状态码，
 * 掉到兜底会变成 `INTERNAL`，既掩盖「该调大 timeoutSeconds」这个处置，又会让步骤层
 * 把一个确定性的超时当成未知异常多重放几次。
 *
 * 状态码映射（与架构文档 §19 的表一致）：
 *
 * - 401 / 403 → `UNAUTHENTICATED`（API Key 无效或没有模型权限，重试结果一样）；
 * - 400 / 404 / 413 / 422 → `INVALID_ARGUMENT`（请求本身不合法，重试结果一样）；
 * - 429 → `RESOURCE_EXHAUSTED`（限流 / 配额不足，可重试）；
 * - 5xx → `PROVIDER_UNAVAILABLE`（供应商暂时不可用，可重试）。
 *
 * **413 是这次合并里唯一的映射变更。** 合并前它不在任何一条状态码分支里，落进
 * `ComemError.from` 变成 `INTERNAL`。`isRetryable` 对 `INTERNAL` 本来就是 false，
 * 所以两条映射在「一次模型调用要不要重试」上结论相同；差别在**步骤层**：
 * `INTERNAL` 不在 `isTerminalStepError` 的终态集合里，会被重放，而 413 是「请求体 /
 * 上下文超出供应商上限」的确定性失败，同一份输入重发一次仍然超限。按保守原则把它
 * 并进 400 类，让领域码与「重发无意义」这个事实一致。
 */
export function mapProviderError(
  error: unknown,
  context: ProviderErrorContext,
  options: ProviderErrorMapOptions,
): ComemError {
  if (error instanceof ComemError) {
    return error;
  }
  if (context.timedOut) {
    return new ComemError(
      'PROVIDER_UNAVAILABLE',
      `${options.call}超时（${context.timeoutMs} 毫秒），请检查供应商可用性或调大 timeoutSeconds。`,
      options.markTimeout === true
        ? { timeout: true, timeoutMs: context.timeoutMs }
        : { timeoutMs: context.timeoutMs },
    );
  }

  const classified = options.classify?.(error);
  if (classified !== undefined) {
    return classified;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return new ComemError(
      'UNAUTHENTICATED',
      `${options.vendor}拒绝了这次请求：API Key 无效，或没有访问该模型的权限。`,
      { statusCode },
    );
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 413 || statusCode === 422) {
    return new ComemError(
      'INVALID_ARGUMENT',
      `${options.vendor}拒绝了这次请求：${options.invalidArgumentHint}。`,
      { statusCode },
    );
  }
  if (statusCode === 429) {
    return new ComemError('RESOURCE_EXHAUSTED', `${options.vendor}限流或配额不足，请稍后重试。`, {
      statusCode,
    });
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return new ComemError(
      'PROVIDER_UNAVAILABLE',
      `${options.vendor}暂时不可用（HTTP ${statusCode}）。`,
      { statusCode },
    );
  }
  // fetch 在网络不可达时抛 TypeError；SDK 不会把它包成 APICallError。
  if (error instanceof TypeError) {
    return new ComemError(
      'PROVIDER_UNAVAILABLE',
      `无法连接${options.vendor}，${options.networkHint}。`,
      { cause: error.message },
    );
  }
  return ComemError.from(error);
}
