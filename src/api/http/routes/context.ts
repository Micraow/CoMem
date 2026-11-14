import type { FastifyInstance } from 'fastify';
import { API_CALL_DEADLINE_MS } from '../../deadline.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalInteger, optionalString, requireRecord, requireString, type HttpRouteGroup } from '../server.js';
import { runRetrieval } from './search-request.js';
import type { HttpRouteServices } from './index.js';
import { ComemError } from '../../../domain/errors.js';

export function createContextRoutes({ search, observability }: Pick<HttpRouteServices, 'search' | 'observability'>): HttpRouteGroup {
  return {
    prefix: '/context',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('', async (request) => {
        const body = requireRecord(request.body, 'context');
        const identity = requestContextOf(request);
        const query = optionalString(body, 'query') ?? '';
        const budgetMs = optionalInteger(body, 'budgetMs', API_CALL_DEADLINE_MS, { min: 1, max: API_CALL_DEADLINE_MS });
        const result = await runRetrieval(budgetMs, async (deadline) => observability.phase('recall', async () => {
          const previous = optionalString(body, 'previousDeliveryToken');
          if (previous !== undefined) await search.acknowledgeContext(previous, identity).catch((error: unknown) => {
            if (!(error instanceof ComemError) || error.details?.['reason'] !== 'invalid_context_receipt') throw error;
          });
          return search.automaticContext(query, {
            ...identity, scopes: await search.defaultScopes(identity.subject, identity.principals), sessionId: optionalString(body, 'sessionId'),
            contextEpoch: optionalString(body, 'contextEpoch'),
            maxTokens: optionalInteger(body, 'maxTokens', 1600, { min: 1, max: 16000 }),
            maxBytes: optionalInteger(body, 'maxBytes', 9000, { min: 0, max: 64000 }),
            limit: optionalInteger(body, 'limit', 10, { min: 1, max: 50 }),
            backgroundOnly: query.trim() === '',
            deadlineAt: deadline.deadlineAt, onUpstream: (upstream) => deadline.mark(upstream),
          });
        }));
        return ok(result);
      });
      app.post<{ Body: unknown }>('/ack', async (request) => {
        const body = requireRecord(request.body, 'context/ack');
        await search.acknowledgeContext(requireString(body, 'deliveryToken'), requestContextOf(request));
        return ok({ acknowledged: true });
      });
    },
  };
}
