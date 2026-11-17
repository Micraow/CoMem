/** `POST /memories/{uri}/approve` 的可选编辑请求解析。 */

import { invalidArgument } from '../../../domain/errors.js';
import type { MemoryApprovalEdit } from '../../../services/memory.js';
import { optionalString, requireRecord, requireText } from '../server.js';

/** 空 body 走旧审批；有正文时同时要求待复核版本标记。 */
export function parseApprovalEdit(body: unknown): MemoryApprovalEdit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  const record = requireRecord(body, 'memories/approve');
  const rawContent = record['content'];
  if (rawContent === undefined) {
    if (record['expectedUpdatedAt'] !== undefined) {
      throw invalidArgument('expectedUpdatedAt 只能与 content 一起使用。', {
        field: 'expectedUpdatedAt',
      });
    }
    return undefined;
  }
  const content = requireText(record, 'content');
  if (content.trim() === '') {
    throw invalidArgument('内容不能为空。', { field: 'content' });
  }
  const expectedUpdatedAt = optionalString(record, 'expectedUpdatedAt');
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === '') {
    throw invalidArgument('编辑复核必须提供待复核项的 expectedUpdatedAt。', {
      field: 'expectedUpdatedAt',
    });
  }
  return { content, expectedUpdatedAt };
}
