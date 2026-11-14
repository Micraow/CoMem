/**
 * 配置连接探针（架构文档 §18 的 `POST /config/test`）。
 *
 * 无 values 时测试运行配置；传 values 时由装配层构造临时供应商测试表单草稿，
 * 不写盘、不替换运行实例、不建索引。草稿嵌入检测实际维度，不以旧维度判失败。
 *
 * 从路由文件拆出来：三个探针各自的成功 / 失败分支是独立的一组判断，混在请求解析
 * 里会让路由超过形状门禁。
 */

import { randomUUID } from 'node:crypto';

import { ComemError } from '../../../domain/errors.js';
import { isRecord } from '../../../domain/guards.js';
import type { EmbeddingService } from '../../../services/embedding.js';
import type { LlmService } from '../../../services/llm.js';

import type { HttpRouteServices } from './index.js';

/** 探针只依赖模型服务的两个方法：测试可以传一个只实现它们的替身。 */
export interface ConfigProbeServices {
  readonly llm: Pick<LlmService, 'generate'>;
  readonly embedding: Pick<EmbeddingService, 'embed'>;
  readonly detectEmbeddingDimension?: () => Promise<number>;
}

export type ConfigRouteServices = Pick<
  HttpRouteServices,
  'config' | 'configSnapshot' | 'systemAdmin'
> & Pick<HttpRouteServices, 'draftProbe'> &
  ConfigProbeServices;

export interface ConfigTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
  readonly dimension?: number;
}

export type ConfigTarget = 'llm' | 'embedding' | 'rerank';

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function parseTarget(value: unknown): ConfigTarget {
  if (value === 'llm' || value === 'embedding' || value === 'rerank') {
    return value;
  }
  throw new ComemError('INVALID_ARGUMENT', 'target 必须是 llm / embedding / rerank。', {
    field: 'target',
    value,
  });
}

/** LLM 探针：发一条 `maxTokens: 1` 的普通 completion。 */
async function probeLlm(services: ConfigProbeServices & Pick<HttpRouteServices, 'config'>): Promise<ConfigTestResult> {
  const startedAt = performance.now();
  const model = services.config.providers.llm.default.model;
  try {
    await services.llm.generate(
      {
        system: '你是连接测试探针。只回复一个词。',
        messages: [{ role: 'user', content: 'ping' }],
      },
      { maxTokens: 1 },
    );
    return { ok: true, latencyMs: elapsedMs(startedAt), detail: `模型 ${model} 可用。` };
  } catch (error) {
    const failure = ComemError.from(error);
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      detail: `模型调用失败（${failure.code}）：请检查地址、认证与模型配置。`,
    };
  }
}

/**
 * 嵌入探针：嵌一个**唯一**短串。
 *
 * 不用空数组——空输入在 `EmbeddingService` 里直接返回、不打网络，探针会假成功。
 * 唯一串同时避开嵌入缓存：缓存命中同样不能证明供应商可用。
 *
 * `type: disabled` 不抛错，只 `degraded`；维度不匹配也在这里显式判，否则
 * 「返回了一个向量」会被当成可用，而检索时整批向量都会因长度不符被跳过。
 */
async function probeEmbedding(services: ConfigProbeServices & Pick<HttpRouteServices, 'config'>): Promise<ConfigTestResult> {
  const startedAt = performance.now();
  const { dimension, model } = services.config.providers.embedding;
  if (services.detectEmbeddingDimension !== undefined) {
    try {
      const actual = await services.detectEmbeddingDimension();
      return { ok: true, latencyMs: elapsedMs(startedAt), detail: `嵌入模型 ${model} 返回 ${actual} 维向量。`, dimension: actual };
    } catch (error) {
      return { ok: false, latencyMs: elapsedMs(startedAt), detail: `嵌入调用失败（${ComemError.from(error).code}）：请检查地址、认证与模型配置。` };
    }
  }
  const outcome = await services.embedding.embed([`comem-config-probe-${randomUUID()}`]);
  const latencyMs = elapsedMs(startedAt);
  if (outcome.degraded) {
    return {
      ok: false,
      latencyMs,
      detail: `嵌入不可用：${outcome.reason ?? '供应商没有返回原因'}`,
    };
  }
  const vector = outcome.vectors[0];
  if (vector === undefined) {
    return { ok: false, latencyMs, detail: '嵌入供应商没有返回向量。' };
  }
  if (vector.length !== dimension) {
    return {
      ok: false,
      latencyMs,
      detail: `向量维度不一致：providers.embedding.dimension 配置为 ${dimension}，供应商返回 ${vector.length}。`,
    };
  }
  return { ok: true, latencyMs, detail: `嵌入模型 ${model} 返回 ${dimension} 维向量。` };
}

/** 重排探针：直接 `POST <baseUrl>/rerank`，不经过检索路径。 */
async function probeRerank(services: Pick<HttpRouteServices, 'config'>): Promise<ConfigTestResult> {
  const startedAt = performance.now();
  const config = services.config.providers.rerank;
  if (config.type !== 'http' || config.baseUrl.trim() === '') {
    return {
      ok: false,
      latencyMs: 0,
      detail: '未配置重排供应商：providers.rerank.type 不是 http 或 baseUrl 为空。',
    };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== '') {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        query: 'comem config probe',
        documents: ['pong'],
        top_n: 1,
      }),
      signal: AbortSignal.timeout(config.timeoutSeconds * 1_000),
    });
    const latencyMs = elapsedMs(startedAt);
    if (!response.ok) {
      return { ok: false, latencyMs, detail: `重排供应商返回 HTTP ${response.status}。` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, latencyMs, detail: '重排供应商返回的不是 JSON。' };
    }
    const results = isRecord(body) ? body['results'] : undefined;
    if (!Array.isArray(results)) {
      return {
        ok: false,
        latencyMs,
        detail: '重排供应商响应缺少 results 数组，请确认 baseUrl 指向 Cohere 兼容的 /rerank 接口。',
      };
    }
    return {
      ok: true,
      latencyMs,
      detail: `重排模型 ${config.model} 返回 ${results.length} 条结果。`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      detail: `重排调用失败（${ComemError.from(error).code}）：请检查地址、认证与模型配置。`,
    };
  }
}

export function probe(
  target: ConfigTarget,
  services: ConfigProbeServices & Pick<HttpRouteServices, 'config'>,
): Promise<ConfigTestResult> {
  switch (target) {
    case 'llm':
      return probeLlm(services);
    case 'embedding':
      return probeEmbedding(services);
    case 'rerank':
      return probeRerank(services);
  }
}
