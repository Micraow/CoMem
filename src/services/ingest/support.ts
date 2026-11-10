/**
 * 导入过程中共用的小函数：错误文本、源文件定位、时间戳兜底与游标 URI 解析。
 *
 * 它们不持有状态，也不碰端口，只把「同一件事在多处各写一遍」收成一份。
 */

import { ComemError } from '../../domain/errors.js';
import { Uri } from '../../domain/uri.js';

export function errorMessage(error: unknown): string {
  return ComemError.from(error).message;
}

/** 错误里带的源文件路径；发现阶段的失败（如整份 Qwen 导出损坏）要靠它定位。 */
export function locatorOf(error: unknown): string | null {
  if (!(error instanceof ComemError)) {
    return null;
  }
  const locator = error.details?.['locator'];
  return typeof locator === 'string' ? locator : null;
}

/** 源时间戳不是合法 ISO 时用导入时刻兜底：`SessionMessage.createdAt` 必须是 ISO。 */
export function normalizeTimestamp(value: string | null): string {
  if (value !== null && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

export function isBefore(value: string | null, since: string): boolean {
  if (value === null) {
    return false;
  }
  const startedAt = Date.parse(value);
  if (Number.isNaN(startedAt)) {
    return false;
  }
  return startedAt < Date.parse(since);
}

export function parseUri(value: string, locator: string): Uri {
  try {
    return Uri.parse(value);
  } catch (error) {
    throw new ComemError('INTERNAL', `游标里的会话 URI 不合法：${locator}`, {
      locator,
      uri: value,
      reason: errorMessage(error),
    });
  }
}
