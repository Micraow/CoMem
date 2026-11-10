/**
 * 内容路由的请求解析与参数校验。
 *
 * 这里只做请求解析与参数校验，不碰响应形状——响应 DTO 在 `content.ts` 顶部。
 * 函数体与拆分前逐字相同，只改了 import 与导出。
 */

import { ComemError } from '../../../domain/errors.js';
import type { PatchBlock } from '../../../domain/patch.js';
import type { Uri } from '../../../domain/uri.js';
import { isWriteMode, WRITE_MODES, type WriteMode } from '../../write-mode.js';
import { requireRecord, requireString } from '../server.js';

import type { HttpRouteServices } from './index.js';

export function parseWriteMode(value: unknown): WriteMode {
  if (value === undefined) {
    return 'replace';
  }
  if (!isWriteMode(value)) {
    throw new ComemError('INVALID_ARGUMENT', `write 的 mode 只能是 ${WRITE_MODES.join(' / ')}。`, {
      mode: value,
    });
  }
  return value;
}

export function parsePatchBlocks(value: unknown): readonly PatchBlock[] {
  if (!Array.isArray(value)) {
    throw new ComemError('INVALID_ARGUMENT', 'edit 的 blocks 必须是数组。', {
      field: 'blocks',
    });
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ComemError('INVALID_ARGUMENT', `edit 的 blocks[${index}] 必须是对象。`, {
        index,
      });
    }
    const record = requireRecord(item, `edit.blocks[${index}]`);
    return {
      search: requireString(record, 'search'),
      replace: requireString(record, 'replace'),
    };
  });
}

export async function readExisting(
  services: HttpRouteServices,
  uri: Uri,
  principals: readonly string[],
): Promise<string> {
  try {
    return (await services.filesystem.read(uri, principals)).text;
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return '';
    }
    throw error;
  }
}
