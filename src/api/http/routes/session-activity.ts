import type { FastifyInstance } from 'fastify';

import { COMMIT_STEP_NAMES } from '../../../domain/archive.js';
import { isRecord } from '../../../domain/guards.js';
import type { Uri } from '../../../domain/uri.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalQueryInteger, requireRecord } from '../server.js';
import type { HttpRouteServices } from './index.js';
import { scopeFrom, sessionUriOf } from './sessions-request.js';

async function archiveActivity(services: HttpRouteServices, uri: Uri) {
  const meta = await services.session.readArchiveMeta(uri);
  if (meta === null) return null;
  const task = meta.taskId === null ? null : services.taskStore.get(meta.taskId);
  const status = task?.type === 'archive' && isRecord(task.payload) && task.payload['archiveUri'] === uri.toString()
    ? task.status : null;
  const diff = await services.readArchiveDiff(uri);
  const changes = diff === null ? null : {
    added: diff.operations.adds.length,
    updated: diff.operations.updates.length,
    deleted: diff.operations.deletes.length,
    skipped: Array.isArray(diff.skippedOperations) ? diff.skippedOperations.length : null,
  };
  return {
    uri: uri.toString(), status, changes, skippedSteps: meta.skippedSteps,
    nextStep: COMMIT_STEP_NAMES.find((step) => !meta.stepsDone.includes(step)) ?? null,
  };
}

export function registerSessionActivity(app: FastifyInstance, services: HttpRouteServices): void {
  app.get<{ Params: { id: string }; Querystring: unknown }>('/:id/activity', async (request) => {
    const { subject, principals } = requestContextOf(request);
    const query = requireRecord(request.query, 'sessions/activity');
    const uri = sessionUriOf(scopeFrom(query, subject), request.params.id);
    const limit = optionalQueryInteger(query, 'limit', 5, { min: 1, max: 20 });
    await services.authorizer.assert(uri, 1, principals);
    await services.session.load(uri);
    const archives = await services.session.listArchives(uri);
    const readable = await services.authorizer.filterReadable(archives, principals);
    const recent = archives.filter((archive) => readable.has(archive.toString())).slice(-limit).reverse();
    const [items, acknowledged] = await Promise.all([
      Promise.all(recent.map((archive) => archiveActivity(services, archive))),
      services.ledger.acknowledgedCount(uri, (uris) => services.authorizer.filterReadable(uris, principals)),
    ]);
    return ok({ items: items.filter((item) => item !== null), acknowledged });
  });
}
