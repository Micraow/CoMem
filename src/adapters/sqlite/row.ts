/**
 * SQLite 行映射的共用取值函数。
 *
 * 仓储把 `SQLOutputValue` 转成领域类型时反复用到这几个：各存一份时的出错方式不是
 * 编译失败，而是某张表把 `null` 读成 `"null"` 之类只在特定查询上暴露的偏差。
 *
 * `text` 的参数是 `unknown`：嵌入向量表的行类型是 `Record<string, unknown>`，
 * 其余仓储传 `SQLOutputValue`。`String()` 对两者是同一个转换。
 */

import type { SQLOutputValue } from 'node:sqlite';

/** SQLite 扩展错误码：1555 = PRIMARY KEY，2067 = UNIQUE。两者都表示「主键已存在」。 */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function text(value: unknown): string {
  return String(value);
}

export function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function extendedErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return null;
  }
  const code = error.errcode;
  return typeof code === 'number' ? code : null;
}

export function isDuplicateKey(error: unknown): boolean {
  const code = extendedErrorCode(error);
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}
