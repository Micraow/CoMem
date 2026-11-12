/**
 * 会话请求解析与参数校验。
 *
 * 这里只做请求解析与参数校验，不碰响应形状——响应 DTO 在 `sessions.ts` 顶部。
 * 函数体与拆分前逐字相同，只改了 import 与导出。
 */

import { userScopeOf } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import {
  isMessageRole,
  MESSAGE_ROLES,
  type ContentPart,
  type MessageRole,
  type SessionMessage,
} from '../../../domain/session.js';
import { Uri } from '../../../domain/uri.js';
import { optionalString, requireRecord } from '../server.js';

export function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** `user:alice` → `comem://user/alice`。 */
function scopeOfSubject(subject: string): Uri {
  return userScopeOf(subject, '会话身份');
}

/** 作用域根 + 会话 ID。ID 走 `Uri.child` 校验（保留名、空段、控制字符都会被拒）。 */
export function sessionUriOf(scope: Uri, id: string): Uri {
  if (id === '') {
    throw invalid('会话 ID 不能为空。', { field: 'id' });
  }
  return scope.child('sessions', id);
}

/** body 里可选的 `scopeUri` 覆盖；缺省用当前身份的个人根。 */
export function scopeFrom(body: Record<string, unknown>, subject: string): Uri {
  const scopeUri = optionalString(body, 'scopeUri');
  return scopeUri === undefined ? scopeOfSubject(subject) : Uri.parse(scopeUri);
}

function requireStringField(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw invalid(`${where}.${field} 必须是字符串。`, { field });
  }
  return value;
}

function parseRole(value: unknown): MessageRole {
  if (typeof value !== 'string') {
    throw invalid('role 必须是字符串。', { field: 'role' });
  }
  if (!isMessageRole(value)) {
    throw invalid(`role 只能是 ${MESSAGE_ROLES.join(' / ')}。`, { field: 'role' });
  }
  return value;
}

/** 一条 `ContentPart`。五种 kind 各自校验字段，不接受未校验的值进服务层。 */
function parsePart(value: unknown, index: number): ContentPart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`parts[${index}] 必须是对象。`, { index });
  }
  const record = requireRecord(value, `parts[${index}]`);
  const where = `parts[${index}]`;
  switch (record['kind']) {
    case 'text':
      return { kind: 'text', text: requireStringField(record, 'text', where) };
    case 'image': {
      const alt = record['alt'];
      if (alt !== undefined && alt !== null && typeof alt !== 'string') {
        throw invalid(`${where}.alt 必须是字符串或 null。`, { index });
      }
      return {
        kind: 'image',
        url: requireStringField(record, 'url', where),
        alt: typeof alt === 'string' ? alt : null,
      };
    }
    case 'context':
      return {
        kind: 'context',
        uri: requireStringField(record, 'uri', where),
        abstract: requireStringField(record, 'abstract', where),
      };
    case 'tool_use':
      return {
        kind: 'tool_use',
        toolUseId: requireStringField(record, 'toolUseId', where),
        name: requireStringField(record, 'name', where),
        input: record['input'],
      };
    case 'tool_result': {
      const isError = record['isError'];
      if (typeof isError !== 'boolean') {
        throw invalid(`${where}.isError 必须是布尔值。`, { index });
      }
      return {
        kind: 'tool_result',
        toolUseId: requireStringField(record, 'toolUseId', where),
        output: requireStringField(record, 'output', where),
        isError,
      };
    }
    default:
      throw invalid(`${where}.kind 只能是 text / image / context / tool_use / tool_result。`, {
        index,
      });
  }
}

/** 一条待追加的消息。`turn` 由服务层按消息总数分配，不接受调用方传（§8.7）。 */
export function parseMessage(body: Record<string, unknown>): Omit<SessionMessage, 'turn'> {
  const id = body['id'];
  const createdAt = body['createdAt'];
  const parts = body['parts'];
  if (id !== undefined && typeof id !== 'string') {
    throw invalid('id 必须是字符串。', { field: 'id' });
  }
  if (createdAt !== undefined && typeof createdAt !== 'string') {
    throw invalid('createdAt 必须是字符串。', { field: 'createdAt' });
  }
  if (!Array.isArray(parts)) {
    throw invalid('parts 必须是数组。', { field: 'parts' });
  }
  return {
    id: typeof id === 'string' ? id : crypto.randomUUID(),
    role: parseRole(body['role']),
    parts: parts.map((part, index) => parsePart(part, index)),
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
  };
}
