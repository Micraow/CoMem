import type { ComemConfig } from '../../config/schema.js';
import type { Logger } from '../../domain/log.js';
import { ComemError } from '../../domain/errors.js';
import { AiSdkLlmProvider } from '../../adapters/llm/ai-sdk-provider.js';
import { detectEmbeddingDimension } from '../../adapters/llm/embedding-provider.js';
import { DisabledLlmProvider } from '../../adapters/llm/disabled-provider.js';
import { probe, type ConfigTarget } from '../../api/http/routes/config-probes.js';
import { LlmService } from '../../services/llm.js';

export function createDraftProbe(logger: Logger) {
  return async (target: ConfigTarget, config: ComemConfig) => {
    const settings = config.providers.llm.default;
    const provider = settings.type === 'disabled' ? new DisabledLlmProvider() : new AiSdkLlmProvider({ ...settings, type: settings.type, logger });
    return probe(target, {
      config,
      llm: new LlmService({ provider, logger, maxAttempts: 1 }),
      embedding: { embed: async () => { throw new ComemError('INTERNAL', '草稿嵌入探测必须检测实际维度。'); } },
      detectEmbeddingDimension: async () => {
        const embedding = config.providers.embedding;
        if (embedding.type === 'disabled') throw new ComemError('INVALID_ARGUMENT', '嵌入模型已停用。');
        return detectEmbeddingDimension({ ...embedding, type: embedding.type, logger });
      },
    });
  };
}
