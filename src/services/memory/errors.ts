/**
 * 记忆读写的入参错误：格式、identity、未知类型三类都走同一个 `INVALID_ARGUMENT`
 * 形状。放在最低层，供文档格式、YAML 子集与写入编排共用。
 */

import { ComemError } from '../../domain/errors.js';

export function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}
