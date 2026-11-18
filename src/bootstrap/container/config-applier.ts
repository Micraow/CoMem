import { getPath, mergeConfig, nestedFromFlat, type ConfigRecord } from '../../config/merge.js';
import { changedConfigLeaves, configWithOverride, readOverride, writeOverrideFile } from '../../config/override.js';
import { llmConfigured } from '../../config/readiness.js';
import { ComemError } from '../../domain/errors.js';
import type { Foundation } from './foundation.js';
import { createEmbeddingProvider, createLlmProvider, embeddingRuntimeOptions, type Models } from './models.js';

const LLM_PREFIX = 'providers.llm.default.';
const EMBEDDING_CONNECTION = new Set(['baseUrl', 'apiKey', 'maxBatchSize', 'timeoutSeconds'].map(
  (key) => `providers.embedding.${key}`,
));
const COMPRESSION_PATHS = new Set(['retrieval.assembly.compressRecall', 'retrieval.assembly.compressRecallTimeoutMs']);

export function createConfigApplier(core: Foundation, models: Models) {
  const { config, configSnapshot: snapshot, logger } = core;
  let queue = Promise.resolve();
  let runtimeOverrides = snapshot.overrideConfig;

  async function save(values: Readonly<ConfigRecord>) {
    const entries = Object.entries(values);
    const next = mergeConfig(readOverride(snapshot), nestedFromFlat(values));
    const saved = configWithOverride(snapshot, next);
    const llm = saved.providers.llm.default;
    const embedding = saved.providers.embedding;
    const runningLlm = config.providers.llm.default;
    const runningEmbedding = config.providers.embedding;

    // A new credential must not be applied to an endpoint (or vice versa) still pending on disk.
    const pairedConnection = (prefix: string) => ['baseUrl', 'apiKey'].every((key) => {
      const path = `${prefix}${key}`;
      const parts = path.split('.');
      return Object.hasOwn(values, path) || getPath(saved, parts) === getPath(config, parts);
    });
    const liveLlm = llm.type !== 'disabled' && runningLlm.type === llm.type &&
      llmConfigured(config) && llmConfigured(saved) && pairedConnection(LLM_PREFIX);
    const liveEmbedding = embedding.type === 'openai-compatible' && runningEmbedding.type === embedding.type &&
      runningEmbedding.model === embedding.model && runningEmbedding.dimension === embedding.dimension &&
      pairedConnection('providers.embedding.');
    if (embedding.type === 'anthropic') {
      throw new ComemError('INVALID_ARGUMENT', 'Anthropic 不提供嵌入接口，请选择 OpenAI 兼容接口。', { field: 'providers.embedding.type' });
    }
    const hot = entries.filter(([path]) => COMPRESSION_PATHS.has(path) ||
      (liveLlm && path.startsWith(LLM_PREFIX)) || (liveEmbedding && EMBEDDING_CONNECTION.has(path)));
    const applied = hot.map(([path]) => path);
    const nextRuntime = mergeConfig(runtimeOverrides, nestedFromFlat(Object.fromEntries(hot)));
    const running = configWithOverride(snapshot, nextRuntime);
    const nextLlm = running.providers.llm.default;
    const nextEmbedding = running.providers.embedding;
    const llmProvider = applied.some((path) => path.startsWith(LLM_PREFIX)) ? createLlmProvider(nextLlm, logger) : null;
    const embeddingProvider = applied.some((path) => EMBEDDING_CONNECTION.has(path)) ? createEmbeddingProvider(nextEmbedding, logger) : null;
    await writeOverrideFile(snapshot.overridePath, next);
    if (llmProvider !== null) {
      models.llm.applyRuntime(llmProvider, nextLlm.pricing, nextLlm.model);
      config.providers.llm.default = nextLlm;
    }
    if (embeddingProvider !== null) {
      models.embedding.applyRuntime(embeddingProvider, embeddingRuntimeOptions(nextEmbedding));
      config.providers.embedding = nextEmbedding;
    }
    if (applied.some((path) => COMPRESSION_PATHS.has(path))) {
      const { compressRecall, compressRecallTimeoutMs } = running.retrieval.assembly;
      Object.assign(config.retrieval.assembly, { compressRecall, compressRecallTimeoutMs });
    }
    runtimeOverrides = nextRuntime;
    for (const path of applied) snapshot.sources.set(path, 'override');
    return { restartRequired: changedConfigLeaves(snapshot, saved).length > 0, applied };
  }

  return (values: Readonly<ConfigRecord>) => {
    const pending = queue.then(() => save(values));
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
}
