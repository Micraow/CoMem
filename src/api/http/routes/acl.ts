/**
 * ACL 路由（架构文档 §14、§12.4）。
 *
 * **ACL 只走 Web/HTTP，不进 MCP**（AGENTS.md）：一个能给自己授权的 agent 就是提权
 * 漏洞。这里每个出口都要求 `manage`（§12.4 的出口清单），并且 `AclService` 自己
 * 会再求一次——路由层的 `assert` 是出口清单的执行点，服务层的是纵深防御。
 *
 * `grant` / `revoke` 是 `PUT /acl` 的语法糖：把一个「在现有条目上加/减一条」的
 * **转换函数**交给 `setAcl`，由后在 `exact(uri)` 锁内对**最新**快照求值。过去的
 * 「`getAcl`（锁外）+ 整份 `setAcl`」会让两个并发 grant 各拿一份旧条目、后写者
 * 整份覆盖——先写者的条目静默消失（§10.6）。写盘仍只有一份实现：
 * 「写 `.acl.json` → 重算整棵子树的 `node_permission`」。
 */

import type { FastifyInstance } from 'fastify';

import {
  ACL_EFFECTS,
  ACL_LEVELS,
  ACL_MODES,
  isAclEffect,
  isAclLevel,
  isAclMode,
  type AclEffect,
  type AclEntry,
  type AclLevel,
  type AclMode,
} from '../../../domain/acl.js';
import { ComemError, invalidArgument } from '../../../domain/errors.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { requireRecord, requireUri, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：manage = 7。ACL 的读写都要求它。 */
const MANAGE = 7;


function parseMode(value: unknown): AclMode {
  if (!isAclMode(value)) {
    throw invalidArgument(`mode 只能是 ${ACL_MODES.join(' / ')}。`, { mode: value });
  }
  return value;
}

function parseEffect(value: unknown): AclEffect {
  if (value === undefined) {
    return 'allow';
  }
  if (!isAclEffect(value)) {
    throw invalidArgument(`effect 只能是 ${ACL_EFFECTS.join(' / ')}。`, { effect: value });
  }
  return value;
}

function parseLevel(value: unknown): AclLevel {
  if (typeof value !== 'number') {
    throw invalidArgument('level 必须是数字。', { level: value });
  }
  if (!isAclLevel(value)) {
    throw invalidArgument(`level 只能是 ${ACL_LEVELS.join(' / ')}（read / write / manage）。`, {
      level: value,
    });
  }
  return value;
}

function requirePrincipal(body: Record<string, unknown>): string {
  const value = body['principal'];
  if (typeof value !== 'string' || value === '') {
    throw invalidArgument('principal 必须是非空字符串。', { field: 'principal' });
  }
  return value;
}

function parseEntries(value: unknown): readonly AclEntry[] {
  if (!Array.isArray(value)) {
    throw invalidArgument('entries 必须是数组。', { field: 'entries' });
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalidArgument(`entries[${index}] 必须是对象。`, { index });
    }
    const record = requireRecord(item, `entries[${index}]`);
    return {
      principal: requirePrincipal(record),
      level: parseLevel(record['level']),
      effect: parseEffect(record['effect']),
    };
  });
}

/** `GET /acl` 的响应体：节点快照 + 求值后的有效权限。 */
interface AclGetResponse {
  readonly uri: string;
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
  /** 按 principal 分组的有效级别（升序）。 */
  readonly effective: Readonly<Record<string, readonly AclLevel[]>>;
}

/** `PUT /acl` 的响应体：写入后的整份状态。 */
interface AclSetResponse {
  readonly uri: string;
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
}

/** `POST /acl/grant` 的响应体：写入的那一条条目。 */
interface AclGrantResponse {
  readonly uri: string;
  readonly entry: AclEntry;
}

/** `POST /acl/revoke` 的响应体。 */
interface AclRevokeResponse {
  readonly uri: string;
  readonly principal: string;
  readonly revoked: true;
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
        return ok<AclGetResponse>({
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
        return ok<AclSetResponse>({ uri: uri.toString(), mode, entries });
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

        // 转换函数在 `setAcl` 的 `exact(uri)` 锁内求值：两个并发 grant 各自看到
        // 对方写入后的最新条目，后写者不会用旧快照整份覆盖（§10.6）。
        await acl.setAcl(
          uri,
          (current) => ({
            mode: current.mode,
            // 同一主体只能有一条（`acl_entry` 的主键是 `(uri, principal)`），后写的覆盖。
            entries: [
              ...current.entries.filter((candidate) => candidate.principal !== entry.principal),
              entry,
            ],
          }),
          context.subject,
          context.principals,
        );
        return ok<AclGrantResponse>({ uri: uri.toString(), entry });
      });

      app.post<{ Body: unknown }>('/revoke', async (request) => {
        const body = requireRecord(request.body, 'acl/revoke');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const principal = requirePrincipal(body);
        await authorizer.assert(uri, MANAGE, context.principals);

        // 同样是锁内转换：`NOT_FOUND` 基于最新快照判断「该主体是否还有直接授权」。
        await acl.setAcl(
          uri,
          (current) => {
            const entries = current.entries.filter((candidate) => candidate.principal !== principal);
            if (entries.length === current.entries.length) {
              throw new ComemError('NOT_FOUND', `该主体没有直接授权：${principal}`, {
                uri: uri.toString(),
                principal,
              });
            }
            return { mode: current.mode, entries };
          },
          context.subject,
          context.principals,
        );
        return ok<AclRevokeResponse>({ uri: uri.toString(), principal, revoked: true });
      });
    },
  };
}
