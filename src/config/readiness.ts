import type { ComemConfig } from './schema.js';

export function llmConfigured(config: ComemConfig): boolean {
  const { type, baseUrl } = config.providers.llm.default;
  if (type === 'disabled') return false;
  try {
    return baseUrl === '' || new URL(baseUrl).hostname !== 'api.example.com';
  } catch {
    return false;
  }
}

export function retrievalConfigured(config: ComemConfig): boolean {
  return config.retrieval.engine === 'fts5' || config.providers.embedding.type !== 'disabled';
}

export function llmSkipReason(config: ComemConfig): 'llm_disabled' | 'llm_unconfigured' | null {
  return llmConfigured(config) ? null : config.providers.llm.default.type === 'disabled' ? 'llm_disabled' : 'llm_unconfigured';
}
