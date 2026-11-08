/**
 * 嵌入契约（架构文档 §8.3 的检索接口、§18 的 `retrieval.engine`）。
 *
 * 与 `LlmProvider` 分开，不是「一个模型一个接口」的对称美学：嵌入的失败语义不同。
 * 限流、维度不匹配、模型不支持嵌入是三种不同的处置（前两种重试，后一种改配置），
 * 混进 `complete()` 之后每个调用方都要重新判断「这个错误该不该重试」。
 *
 * 架构文档 §4.4 的接口清单把它列为「需要时再加」——向量检索落地时就是那个时候，
 * §4.4 与 §18 的「v1 不做向量检索」需要同步。
 *
 * **纯数值，无 IO。** 这里的函数只做内存里的向量运算，可以穷举测试；网络调用在
 * `adapters/llm/embedding-provider.ts`。
 */

import { ComemError } from './errors.js';

/**
 * 一次嵌入请求的结果。
 *
 * `vectors` 与输入 `texts` 按下标一一对应，顺序是契约的一部分：调用方直接把结果
 * 写回 `node_embedding`，错位一个就整库向量对错文本。
 */
export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: { readonly promptTokens: number; readonly totalTokens: number };
}

/**
 * 嵌入提供者。
 *
 * 与 `LlmProvider` 分开：嵌入的失败语义不同（限流、维度不匹配、模型不支持），
 * 混成一个接口会让两边都在判断「这个错误该不该重试」。
 */
export interface EmbeddingProvider {
  /** 模型标识，如 `text-embedding-3-small`。写进索引用来检测换模型后的失效。 */
  readonly model: string;
  /** 向量维度。换模型后维度可能变，索引要据此判断能否复用。 */
  readonly dimension: number;

  /**
   * 批量嵌入。
   *
   * 批量是**接口的一等公民**不是优化：单条调用在回填一万个节点时会被限流打穿。
   */
  embed(texts: readonly string[], options?: EmbeddingOptions): Promise<EmbeddingResult>;
}

export interface EmbeddingOptions {
  /** 覆盖构造时的超时，毫秒 */
  readonly timeoutMs?: number;
  /** 调用方取消（HTTP 断开、进程退出） */
  readonly signal?: AbortSignal;
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/**
 * 余弦相似度。两个向量都必须是有限数。
 *
 * 只校验长度：这是唯一能用 O(1) 挡住调用的错误。逐元素校验有限性会让这个函数在
 * 检索热路径上多一遍 O(n) 扫描（1 万节点 × 128 维就是 128 万次判断），而调用方
 * 写库前已经过一次 `assertValidVector`。
 *
 * 全零向量返回 0：它的方向无定义，返回 `NaN` 会让排序把整批结果污染成 `NaN`。
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw invalidArgument('向量维度必须相同且非空。', {
      left: left.length,
      right: right.length,
    });
  }

  let dot = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (const [index, leftValue] of left.entries()) {
    // 长度已经相等，`?? 0` 只是让 noUncheckedIndexedAccess 收窄，走不到。
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftSquares += leftValue * leftValue;
    rightSquares += rightValue * rightValue;
  }

  if (leftSquares === 0 || rightSquares === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftSquares) * Math.sqrt(rightSquares));
}

/** `Int8Array` 的取值区间。量化把浮点线性映射到它上面，越界会被数组静默回绕。 */
const INT8_MAX = 127;
const INT8_MIN = -128;

/**
 * 把浮点向量量化成 int8，体积降到 1/4，精度损失在检索场景可忽略。
 *
 * 用「最大绝对值」定 scale：`scale = maxAbs / 127`，每个分量四舍五入到最近的整数。
 * 这样最大分量恰好落在 `±127` 上，不会因为超出上界被回绕成反号——那会让最相关的
 * 那个维度变成最不相关的。
 *
 * scale 不在返回值里（接口只给 `Int8Array`），调用方要落库时按同一个公式
 * `maxAbs / 127` 算一遍；`dequantizeVector` 收的就是这个值。
 */
export function quantizeVector(vector: readonly number[]): Int8Array {
  const quantized = new Int8Array(vector.length);
  let maxAbs = 0;
  for (const value of vector) {
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  if (maxAbs === 0) {
    // 全零向量：scale = 0，整段都是 0。`dequantizeVector` 对 scale = 0 返回全零。
    return quantized;
  }

  const scale = maxAbs / INT8_MAX;
  for (const [index, value] of vector.entries()) {
    quantized[index] = Math.max(INT8_MIN, Math.min(INT8_MAX, Math.round(value / scale)));
  }
  return quantized;
}

/**
 * 量化还原。
 *
 * 全零向量的 scale 是 0，还原结果也是全零——这不是特例分支，`0 * 0` 本来就等于 0，
 * 但负数或非有限的 scale 是调用方的 bug（数据库里被写坏），在这里挡掉比在下游算出一
 * 堆负数向量再排查便宜。
 */
export function dequantizeVector(quantized: Int8Array, scale: number): number[] {
  if (!Number.isFinite(scale) || scale < 0) {
    throw invalidArgument('量化 scale 必须是非负有限数。', { scale });
  }
  const vector = new Array<number>(quantized.length);
  for (const [index, value] of quantized.entries()) {
    vector[index] = value * scale;
  }
  return vector;
}

/**
 * 归一化到单位长度。余弦相似度在单位向量上退化成点积，快一个量级。
 *
 * 全零向量没有方向，原样返回（模长 0 而不是 `NaN`）：调用方拿它去算余弦会在
 * `cosineSimilarity` 里得到 0，不是崩溃。
 */
export function normalizeVector(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return [...vector];
  }
  return vector.map((value) => value / norm);
}

/**
 * 维度不匹配 / 含 NaN / 全零向量 → 抛 INVALID_ARGUMENT。
 *
 * 进索引之前挡掉这三类：维度不匹配会让 `cosineSimilarity` 每行都抛一次，NaN 会污染
 * 整批排序结果，全零向量在余弦下和任何向量都正交、写进去等于一条死记录。
 */
export function assertValidVector(vector: readonly number[], dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw invalidArgument('向量维度必须是正整数。', { dimension });
  }
  if (vector.length !== dimension) {
    throw invalidArgument('向量长度与维度不匹配。', {
      expected: dimension,
      actual: vector.length,
    });
  }

  let allZero = true;
  for (const [index, value] of vector.entries()) {
    if (!Number.isFinite(value)) {
      throw invalidArgument('向量含非有限数（NaN 或 Infinity）。', { index, value });
    }
    if (value !== 0) {
      allZero = false;
    }
  }
  if (allZero) {
    throw invalidArgument('全零向量没有方向，不能用于余弦检索。', { dimension });
  }
}
