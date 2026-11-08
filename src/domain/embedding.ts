/**
 * 嵌入契约（架构文档 §8.3 的检索接口、§18 的 `retrieval.engine`）。
 *
 * 与 `LlmProvider` 分开，不是「一个模型一个接口」的对称美学：嵌入的失败语义不同。
 * 限流、维度不匹配、模型不支持嵌入是三种不同的处置（前两种重试，后一种改配置），
 * 混进 `complete()` 之后每个调用方都要重新判断「这个错误该不该重试」。
 *
 * **距离计算与量化由 `sqlite-vec` 在 C 层完成，这里只保留入参校验与归一化。**
 * 向量落库走 `vec0` 虚拟表（`FLOAT[N] distance_metric=cosine`），检索走它的
 * `MATCH ... AND k = N`，所以 JS 侧的余弦实现与 int8 量化循环都是死代码：它们
 * 只会在「有人绕过索引层」时被调用，而那条路径不存在。实测 10,000 条 × 1024 维
 * 单次 KNN 是 8–10ms，同一份数据用 JS 标量循环按 128 维实测外推约 300ms。
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
 * 归一化到单位长度。
 *
 * 写库前做一次：`distance_metric=cosine` 下 `vec0` 返回的距离是 `1 - 余弦`，归一化
 * 不改变这个值，但它让「同一份向量在内存里与落库后算出的分数」逐位一致，也让
 * 换距离度量（内积）时不需要改写入侧。bge-m3 这类模型返回的已经是单位向量，但
 * 不应假设——供应商实现差异不在契约里。
 *
 * 全零向量没有方向，原样返回（模长 0 而不是 `NaN`）：`assertValidVector` 会拒绝它，
 * 这里不替调用方做决定。
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
 * 进索引之前挡掉这三类：维度不匹配会让 `vec0` 在 `INSERT` 时报一句没有上下文的
 * SQL 错误，NaN 会污染整批排序结果，全零向量在余弦下和任何向量都正交、写进去
 * 等于一条死记录。
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
