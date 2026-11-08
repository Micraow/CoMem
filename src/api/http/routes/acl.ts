/**
 * ACL 路由（架构文档 §14、§12.4）。
 *
 * **ACL 只走 Web/HTTP，不进 MCP**（AGENTS.md）：一个能给自己授权的 agent 就是提权
 * 漏洞。这里每个出口都要求 `manage`（§12.4 的出口清单），并且 `AclService` 自己
 * 会再求一次——路由层的 `assert` 是出口清单的执行点，服务层的是纵深防御。
 *
 * `grant` / `revoke` 是 `PUT /acl` 的语法糖：它们先读当前快照、改一条、再整体写回。
 * 写回走 `setAcl`，所以「写 `.acl.json` → 重算整棵子树的 `node_permission`」这条
 * 顺序只有一份实现。
 */

import type { FastifyInstance } from 'fastify';

import type { AclEffect, AclEntry, AclLevel, AclMode } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { requireRecord, requireUri, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：manage = 7。ACL 的读写都要求它。 */
const MANAGE = 7;

const MODES: readonly AclMode[] = ['inherit', 'restricted'];
const EFFECTS: readonly AclEffect[] = ['allow', 'deny'];
const LEVELS: readonly AclLevel[] = [1, 3, 7];

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function parseMode(value: unknown): AclMode {
  const mode = MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw invalid(`mode 只能是 ${MODES.join(' / ')}。`, { mode: value });
  }
  return mode;
}

function parseEffect(value: unknown): AclEffect {
  if (value === undefined) {
    return 'allow';
  }
  const effect = EFFECTS.find((candidate) => candidate === value);
  if (effect === undefined) {
    throw invalid(`effect 只能是 ${EFFECTS.join(' / ')}。`, { effect: value });
  }
  return effect;
}

function parseLevel(value: unknown): AclLevel {
  if (typeof value !== 'number') {
    throw invalid('level 必须是数字。', { level: value });
  }
  const level = LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw invalid(`level 只能是 ${LEVELS.join(' / ')}（read / write / manage）。`, {
      level: value,
    });
  }
  return level;
}

function requirePrincipal(body: Record<string, unknown>): string {
  const value = body['principal'];
  if (typeof value !== 'string' || value === '') {
    throw invalid('principal 必须是非空字符串。', { field: 'principal' });
  }
  return value;
}

function parseEntries(value: unknown): readonly AclEntry[] {
  if (!Array.isArray(value)) {
    throw invalid('entries 必须是数组。', { field: 'entries' });
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid(`entries[${index}] 必须是对象。`, { index });
    }
    const record = requireRecord(item, `entries[${index}]`);
    return {
      principal: requirePrincipal(record),
      level: parseLevel(record['level']),
      effect: parseEffect(record['effect']),
    };
  });
}

function serializeEffective(
  effective: ReadonlyMap<string, ReadonlySet<AclLevel>>,
): Record<string, readonly AclLevel[]> {
  const result: Record<string, readonly AclLevel[]> = {};
  for (const [principal, levels] of effective) {
    result[principal] = [...levels].sort((left, right) => left - right);
  }
  return result;
}

export function createAclRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { acl, authorizer } = services;

  return {
    prefix: '/acl',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        const query = requireRecord(request.query, 'acl/get');
        const context = requestContextOf(request);
        const uri = requireUri(query, 'uri');
        await authorizer.assert(uri, MANAGE, context.principals);
        const snapshot = await acl.getAcl(uri, context.subject, context.principals);
        return ok({
          uri: snapshot.uri.toString(),
          mode: snapshot.mode,
          entries: snapshot.entries,
          effective: serializeEffective(snapshot.effective),
        });
      });

      app.put<{ Body: unknown }>('/', async (request) => {
        const body = requireRecord(request.body, 'acl/set');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const mode = parseMode(body['mode']);
        const entries = parseEntries(body['entries']);
        await authorizer.assert(uri, MANAGE, context.principals);
        await acl.setAcl(uri, { mode, entries }, context.subject, context.principals);
        return ok({ uri: uri.toString(), mode, entries });
      });

      app.post<{ Body: unknown }>('/grant', async (request) => {
        const body = requireRecord(request.body, 'acl/grant');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const entry: AclEntry = {
          principal: requirePrincipal(body),
          level: parseLevel(body['level']),
          effect: parseEffect(body['effect']),
        };
        await authorizer.assert(uri, MANAGE, context.principals);

        const snapshot = await acl.getAcl(uri, context.subject, context.principals);
        // 同一主体只能有一条（`acl_entry` 的主键是 `(uri, principal)`），后写的覆盖。
        const entries = [
          ...snapshot.entries.filter((candidate) => candidate.principal !== entry.principal),
          entry,
        ];
        await acl.setAcl(uri, { mode: snapshot.mode, entries }, context.subject, context.principals);
        return ok({ uri: uri.toString(), entry });
      });

      app.post<{ Body: unknown }>('/revoke', async (request) => {
        const body = requireRecord(request.body, 'acl/revoke');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const principal = requirePrincipal(body);
        await authorizer.assert(uri, MANAGE, context.principals);

        const snapshot = await acl.getAcl(uri, context.subject, context.principals);
        const entries = snapshot.entries.filter((candidate) => candidate.principal !== principal);
        if (entries.length === snapshot.entries.length) {
          throw new ComemError('NOT_FOUND', `该主体没有直接授权：${principal}`, {
            uri: uri.toString(),
            principal,
          });
        }
        await acl.setAcl(uri, { mode: snapshot.mode, entries }, context.subject, context.principals);
        return ok({ uri: uri.toString(), principal, revoked: true });
      });
    },
  };
}
