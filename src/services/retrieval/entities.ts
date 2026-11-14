import { reciprocalRankFusion, type SearchHit } from '../../domain/retrieval.js';
import type { FindOptions, PreHotnessHit, SearchServiceDeps } from './types.js';
import { enrichVectorHits } from './enrich.js';

export async function entityCandidates(
  deps: SearchServiceDeps, query: string, options: FindOptions,
  hits: readonly PreHotnessHit[], limit: number,
  queryVector?: readonly number[],
): Promise<readonly PreHotnessHit[]> {
  if (deps.memoryStructure === undefined || options.deadlineAt !== undefined && Date.now() >= options.deadlineAt ||
      options.contextTypes?.length && !options.contextTypes.includes('memory') ||
      options.levels?.length && !options.levels.includes('L2')) return hits;
  const readable = await deps.index.glob({
    pattern: '**', scopes: options.scopes, principals: options.principals,
    asOf: new Date().toISOString(), limit: Number.MAX_SAFE_INTEGER,
  });
  const neighborhood = deps.memoryStructure.neighborhood(query, readable, limit * deps.config.candidateMultiplier);
  if (neighborhood.entities.length === 0) return hits;
  const allowed = new Set([...neighborhood.entities, ...neighborhood.memories]);
  const reduced = neighborhood.names.reduce((text, name) => text.replaceAll(new RegExp(escapePattern(name), 'giu'), ' '), query).trim();
  const related: SearchHit[] = [];
  const scopes = [...allowed];
  const chunkSize = 100;
  if (reduced !== '') for (let start = 0; start < scopes.length; start += chunkSize) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break;
    related.push(...await deps.index.search({ ...options, text: reduced, scopes: scopes.slice(start, start + chunkSize), asOf: new Date().toISOString(), limit }));
  }
  related.sort((left, right) => right.score - left.score);
  const eligible = await deps.index.glob({ pattern: '**', scopes: options.scopes,
    principals: options.principals, memoryTypes: options.memoryTypes, updatedAfter: options.updatedAfter,
    updatedBefore: options.updatedBefore, asOf: new Date().toISOString(), limit: Number.MAX_SAFE_INTEGER });
  const neighbors = new Set(neighborhood.memories);
  const candidates = eligible.filter((uri) => neighbors.has(uri));
  const semantic = queryVector === undefined || deps.vectors === undefined || deps.nodes === undefined || deps.embedding?.model == null || candidates.length === 0 ||
    options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
    ? [] : enrichVectorHits(await deps.vectors.search({ vector: queryVector, model: deps.embedding.model, uris: candidates, limit }), options, deps.nodes);
  const entities = [];
  for (const uri of neighborhood.entities) {
    const node = await deps.index.stat(uri);
    if (node === null || options.memoryTypes?.length && !options.memoryTypes.includes(node.memoryType ?? '') ||
      options.updatedAfter !== undefined && node.updatedAt < new Date(options.updatedAfter).toISOString() ||
      options.updatedBefore !== undefined && node.updatedAt > new Date(options.updatedBefore).toISOString()) continue;
    entities.push({ ...node, level: 'L2' as const, score: 0 });
  }
  const selected = reciprocalRankFusion([{ engine: 'fts5', hits: related }, { engine: 'vector', hits: semantic }], { limit });
  const supplements = [...entities, ...selected.filter((hit) => allowed.has(hit.uri))];
  if (supplements.length === 0) return hits;
  return reciprocalRankFusion([
    { engine: 'hybrid', hits }, { engine: 'fts5', hits: supplements },
  ], { limit, levelWeights: deps.config.levelWeights }).map((hit) => ({ ...hit, ranks: hits.find((base) => base.uri === hit.uri)?.ranks ?? null }));
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
