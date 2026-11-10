/**
 * 装配阶段 2：模型（对话 / 嵌入 / 重排）。
 *
 * 三条「关掉就不该有空转」的规则都在这里，语句与拆分前逐字一致：
 *
 * - `type: disabled` 时构造 `DisabledLlmProvider`：每个方法都抛 `INVALID_ARGUMENT`，
 *   保证「关掉模型」不会产生任何网络调用。选桩而不是 `null`，理由见
 *   `adapters/llm/disabled-provider.ts`。
 * - 嵌入 `type: disabled`（默认）时传 `null`，`EmbeddingService` 因此
 *   `available: false`，写路径与检索路径都不会打网络。
 * - `retrieval.rerank.enabled` 为 false（默认）时不构造 provider，`SearchService`
 *   拿到 `undefined`，整条重排路径不执行——默认路径与接线前逐字一致。
 */

import { AiSdkEmbeddingProvider } from '../../adapters/llm/embedding-provider.js';
import { AiSdkLlmProvider } from '../../adapters/llm/ai-sdk-provider.js';
import { DisabledLlmProvider } from '../../adapters/llm/disabled-provider.js';
import { HttpRerankProvider } from '../../adapters/llm/rerank-provider.js';
import { EmbeddingCacheRepository } from '../../adapters/sqlite/embedding-cache.js';
import { EmbeddingService } from '../../services/embedding.js';
import { LlmService } from '../../services/llm.js';
import type { Foundation } from './foundation.js';
import { MILLISECONDS_PER_SECOND, llmBaseUrlIsPlaceholder } from './support.js';

/** 模型层产物。`embeddingConfig` / `rerankConfig` 一并带出，调用点不再重读配置。 */
export interface Models {
  readonly llm: LlmService;
  readonly embedding: EmbeddingService;
  readonly embeddingConfig: Foundation['config']['providers']['embedding'];
  readonly rerankConfig: Foundation['config']['providers']['rerank'];
  readonly rerankProvider: HttpRerankProvider | undefined;
}

export function createModels(core: Foundation): Models {
  const { config, logger, db, embeddings } = core;

  // ── 模型 ──
  const llmConfig = config.providers.llm.default;
  if (llmConfig.type !== 'disabled' && llmBaseUrlIsPlaceholder(llmConfig.baseUrl)) {
    // 模板里的 `https://api.example.com/v1` 是 IANA 保留域名（RFC 2606），永远
    // 不可达。把它当默认值等于「默认配置下有一个功能静默不工作」——摘要失效投递
    // 会失败、HTTP 仍然 200，用户只会看到「写成功了」。启动时明说比事后排查好。
    logger.warn(
      'providers.llm.default.baseUrl 是占位值 api.example.com（保留域名，永远不可达）：摘要、记忆抽取、合并与检索改写都不会工作。配置真实的 baseUrl；不需要模型时把 type 改成 disabled 并把 summary.generator 改成 rule。',
      { baseUrl: llmConfig.baseUrl },
    );
  }
  const llmProvider =
    llmConfig.type === 'disabled'
      ? new DisabledLlmProvider()
      : new AiSdkLlmProvider({
          type: llmConfig.type,
          ...(llmConfig.baseUrl === '' ? {} : { baseUrl: llmConfig.baseUrl }),
          model: llmConfig.model,
          apiKey: llmConfig.apiKey,
          maxTokens: llmConfig.maxTokens,
          timeoutSeconds: llmConfig.timeoutSeconds,
          pricing: llmConfig.pricing,
          logger,
        });
  const llm = new LlmService({
    provider: llmProvider,
    logger,
    pricing: llmConfig.pricing,
    model: llmConfig.model,
  });

  // ── 嵌入 ──
  const embeddingConfig = config.providers.embedding;
  const embeddingProvider =
    embeddingConfig.type === 'disabled'
      ? null
      : new AiSdkEmbeddingProvider({
          type: embeddingConfig.type,
          ...(embeddingConfig.baseUrl === '' ? {} : { baseUrl: embeddingConfig.baseUrl }),
          model: embeddingConfig.model,
          apiKey: embeddingConfig.apiKey,
          dimension: embeddingConfig.dimension,
          maxBatchSize: embeddingConfig.maxBatchSize,
          timeoutSeconds: embeddingConfig.timeoutSeconds,
          logger,
        });
  const embedding = new EmbeddingService({
    provider: embeddingProvider,
    logger,
    // 缓存按 `(model, content_digest)` 去重，与「配了哪个引擎」无关：`reindex`
    // 回填、检索查询、写路径都该共享同一份结果。关掉只对「每次都要新向量」的
    // 调试场景有意义。
    cache: embeddingConfig.cache.enabled
      ? new EmbeddingCacheRepository({
          db,
          logger,
          maxEntries: embeddingConfig.cache.maxEntries,
        })
      : null,
    config: {
      dimension: embeddingConfig.dimension,
      maxBatchSize: embeddingConfig.maxBatchSize,
      timeoutMs: embeddingConfig.timeoutSeconds * MILLISECONDS_PER_SECOND,
    },
  });
  // 启动期就把向量表建好、把维度与配置对齐：等到第一次写入才发现维度不一致，
  // 那时错误已经落在「用户等着检索结果」的路径上，而且症状是「一条都搜不到」。
  //
  // 未配置嵌入时不建表：默认维度 1536 会写进元数据，之后换成 1024 维的模型要先
  // 跑一次 `reindex` 才能启动，而那次重建没有任何数据要救。
  if (embeddingConfig.type !== 'disabled') {
    embeddings.ensureSchema(embeddingConfig.dimension, embeddingConfig.model);
  }
  if (config.retrieval.engine !== 'fts5' && embedding.available) {
    logger.info('向量检索已启用', {
      engine: config.retrieval.engine,
      model: embedding.model,
      dimension: embeddingConfig.dimension,
    });
  }

  // ── 重排 ──
  //
  // 交叉校验（`config/schema.ts`）保证 enabled 为 true 时 `providers.rerank.type`
  // 不是 `disabled`；这里只按 `http` 构造，不静默降级成「不重排」。
  const rerankConfig = config.providers.rerank;
  const rerankProvider =
    config.retrieval.rerank.enabled && rerankConfig.type === 'http'
      ? new HttpRerankProvider({
          baseUrl: rerankConfig.baseUrl,
          model: rerankConfig.model,
          apiKey: rerankConfig.apiKey,
          timeoutSeconds: rerankConfig.timeoutSeconds,
          logger,
        })
      : undefined;
  if (rerankProvider !== undefined) {
    logger.info('重排已启用', {
      model: rerankProvider.model,
      topN: rerankConfig.topN,
      keepTopN: config.retrieval.rerank.keepTopN,
    });
  }

  return { llm, embedding, embeddingConfig, rerankConfig, rerankProvider };
}
