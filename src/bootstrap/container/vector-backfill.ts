import { documentsMissingVectors, embedMissingNodes, type EmbedMissingNodesProgress } from '../../commands/reindex.js';
import { countDocumentsMissingVectors } from '../../commands/reindex/missing-vectors.js';
import { ComemError, errorMessage } from '../../domain/errors.js';
import type { EmbeddingService } from '../../services/embedding.js';
import type { Foundation } from './foundation.js';

export function createVectorBackfill(core: Pick<Foundation, 'config' | 'db' | 'logger' | 'store' | 'embeddings'>, embedding: EmbeddingService) {
  const { config, db, logger, store, embeddings } = core;
  const currentModel = () => config.retrieval.engine === 'fts5' ? null : embedding.model;
  let active: { readonly done: Promise<void>; stop(): Promise<void> } | null = null;
  let progress: (EmbedMissingNodesProgress & { readonly total: number }) | null = null;
  let error: string | null = null;

  function status() {
    const model = currentModel();
    const missing = model === null ? null : active !== null && progress !== null
      ? progress.remaining + progress.failed
      : countDocumentsMissingVectors(db, model);
    return { missing, running: active !== null, progress, error };
  }

  function start() {
    if (active !== null) return active;
    const abort = new AbortController();
    const done = Promise.resolve().then(async () => {
      const model = currentModel();
      if (model === null) return;
      const uris = documentsMissingVectors(db, model);
      progress = { embedded: 0, skipped: 0, failed: 0, remaining: uris.length, total: uris.length };
      if (uris.length === 0) return;
      logger.info('存量节点没有向量，开始在后台补齐。', { model, missing: uris.length });
      const result = await embedMissingNodes(uris, {
        store, embeddings, embedding, logger, signal: abort.signal, batchSize: embedding.maxBatchSize,
        onBatch: (batch) => {
          progress = { ...batch, total: uris.length };
          logger.info('向量回填进度。', { ...progress });
        },
      });
      const counts = { embedded: result.embeddedUris.length, skipped: result.skipped, failed: result.failedUris.length };
      if (result.aborted) logger.info('存量向量回填已中止（进程正在退出）。', counts);
      else if (counts.failed > 0) logger.warn('存量向量回填仍有失败，缺失项未写入。', counts);
      else logger.info('存量向量回填完成。', counts);
    }).catch((failure: unknown) => {
      error = '向量补齐中断，请检查服务端日志。';
      logger.error(error, { error: errorMessage(failure) });
    }).finally(() => { active = null; });
    error = null;
    progress = null;
    active = { done, stop: async () => { abort.abort(); await done; } };
    return active;
  }

  return {
    store,
    status,
    start,
    resume() {
      if (currentModel() === null) throw new ComemError('CONFLICT', '当前未启用向量检索。');
      start();
      return status();
    },
    async stop() { await active?.stop(); },
  };
}
