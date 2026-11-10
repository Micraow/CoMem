/**
 * 记忆请求解析与参数校验。
 *
 * 这里只做请求解析与参数校验，不碰响应形状——响应 DTO 在 `memories.ts` 顶部。
 * 函数体与拆分前逐字相同，只改了 import 与导出。
 */

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import type { MemoryLink } from '../../../domain/memory-link.js';
import { Uri } from '../../../domain/uri.js';
import type { Authorizer } from '../../../services/authorizer.js';

export function parseMemoryUri(raw: string): Uri {
  if (raw === '') {
    throw new ComemError('INVALID_URI', '记忆 URI 不能为空。', { uri: raw });
  }
  return Uri.parse(raw);
}

export function scopeOfSubject(subject: string): string {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `记忆身份必须是 user 主体：${subject}`, { subject });
  }
  return `comem://user/${principal.id}`;
}

/**
 * `direction`：`links`（默认，正向）或 `backlinks`（派生）。
 *
 * 缺省正向：调用方通常先说「这条记忆关联了哪些东西」，反查是第二问。
 */
export function parseLinkDirection(raw: unknown): 'links' | 'backlinks' {
  if (raw === undefined) {
    return 'links';
  }
  if (raw === 'links' || raw === 'backlinks') {
    return raw;
  }
  throw new ComemError('INVALID_ARGUMENT', 'links 的 direction 只能是 links 或 backlinks。', {
    field: 'direction',
    value: raw,
  });
}

/**
 * 只保留「另一端也可读」的边（§12.4）。
 *
 * 查询的 URI 已经在路由里 `assert` 过；边的另一端是一个独立资源，要单独求 read：
 * `links` 查 `to`、`backlinks` 查 `from`。不查的后果是 `backlinks` 会把「哪些记忆
 * 来自这次归档」列给一个读不到那些记忆的调用方，而 URI 自己就是内容。
 *
 * 无权限的边**整条不返回**。占位（`to: null`）或打码（`comem://***`）仍在回答「这里
 * 有一条边」，而边的存在与否也是信息；安静地少一条不构成侧面提示。
 *
 * 用 `Authorizer` 已有的 `filterReadable`：它的语义正是 §12.4 的「无权限节点完全
 * 不出现」，一次查询拿到可读集合。不用逐条 `assert` 吞 `PERMISSION_DENIED`——那样
 * 还得区分权限错误与真实的存储故障，而把故障当成无权限会静默隐藏问题。
 */
export async function readableLinks(
  authorizer: Authorizer,
  links: readonly MemoryLink[],
  direction: 'links' | 'backlinks',
  principals: readonly string[],
): Promise<readonly MemoryLink[]> {
  if (links.length === 0) {
    return links;
  }
  const otherEndOf = (link: MemoryLink): Uri =>
    direction === 'backlinks' ? link.fromUri : link.toUri;
  // 按字符串去重：同一个另一端在多条边上重复出现时只求一次权。
  const otherEnds = new Map<string, Uri>();
  for (const link of links) {
    const otherEnd = otherEndOf(link);
    otherEnds.set(otherEnd.toString(), otherEnd);
  }
  const readable = await authorizer.filterReadable([...otherEnds.values()], principals);
  return links.filter((link) => readable.has(otherEndOf(link).toString()));
}

export function requireRecordReason(body: Record<string, unknown>): string {
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ComemError('INVALID_ARGUMENT', 'reject 的 reason 必须是非空字符串。', {
      field: 'reason',
    });
  }
  return reason;
}

/** 可选的布尔参数。缺省返回 `undefined`（由服务端的默认值决定）。 */
export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ComemError('INVALID_ARGUMENT', `参数 ${field} 必须是布尔值。`, { field });
  }
  return value;
}
