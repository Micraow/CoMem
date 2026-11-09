/**
 * API Key 仓储（架构文档 §12.7）。
 *
 * `api_key` 表是凭据目录：一把 key 一行，`prefix` 明文（唯一索引，校验时按它
 * 等值查找），`key_hash` 是 scrypt 编码的 secret。**`key_hash` 绝不出这个
 * 仓储的读方法**——管理面列出 key 时只给 prefix 与 name。
 *
 * ## 一个用户多把 key
 *
 * 这是与「一把 key 绑一个账号」的实现的刻意分歧：`name` 用来区分用途
 * （`laptop` / `ci` / `agent-a`），泄露一把只吊销那一把。
 *
 * ## 为什么不在这里做过期判断
 *
 * 仓储只做行与值的转换。`revoked_at` / `expires_at` 的判定在
 * `IdentityService.resolve`——那里才知道「现在」是哪一刻，也才能把失败翻译成
 * `UNAUTHENTICATED`。仓储返回原始行，调用方决定语义。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

export interface ApiKeyRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/**
 * 一行 key 的公开字段。
 *
 * 没有 `keyHash`：hash 只在 `findByPrefix` 的返回值里出现一次（校验需要它），
 * 列表与单条查询都不带。少一个字段就少一条「不小心序列化进响应」的路径。
 */
export interface ApiKeyRecord {
  readonly id: string;
  readonly userId: string;
  readonly prefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/** `findByPrefix` 的返回值：公开字段 + 校验用的哈希。 */
export interface ApiKeyLookup {
  readonly record: ApiKeyRecord;
  readonly keyHash: string;
}

/** 写入时由服务层生成的完整行（hash 已经算好）。 */
export interface ApiKeyInsert {
  readonly id: string;
  readonly userId: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly name: string;
  readonly expiresAt: string | null;
}

const COLUMN_NAMES = [
  'id',
  'user_id',
  'prefix',
  'name',
  'created_at',
  'expires_at',
  'revoked_at',
] as const;

const COLUMNS = COLUMN_NAMES.join(', ');

/** SQLite 扩展错误码：1555 = PRIMARY KEY，2067 = UNIQUE。 */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function extendedErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return null;
  }
  const code = error.errcode;
  return typeof code === 'number' ? code : null;
}

function isDuplicateKey(error: unknown): boolean {
  const code = extendedErrorCode(error);
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}

function toRecord(row: Record<string, SQLOutputValue>): ApiKeyRecord {
  return {
    id: text(row['id']),
    userId: text(row['user_id']),
    prefix: text(row['prefix']),
    name: text(row['name']),
    createdAt: text(row['created_at']),
    expiresAt: nullableText(row['expires_at']),
    revokedAt: nullableText(row['revoked_at']),
  };
}

export class ApiKeyRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: ApiKeyRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /**
   * 写入一行。`id` 或 `prefix` 撞唯一约束抛 `CONFLICT`——两者都是随机生成的，
   * 撞上说明随机源出了问题，但调用方仍应能重试。
   */
  create(key: ApiKeyInsert, now: Date): ApiKeyRecord {
    const createdAt = now.toISOString();
    try {
      withWriteTransaction(this.#db, () => {
        this.#db
          .prepare(
            `INSERT INTO api_key (id, user_id, key_hash, prefix, name, created_at, expires_at, revoked_at)
             VALUES (${placeholders(8)})`,
          )
          .run(key.id, key.userId, key.keyHash, key.prefix, key.name, createdAt, key.expiresAt, null);
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ComemError('CONFLICT', `API Key 标识冲突：${key.prefix}`, {
          keyId: key.id,
        });
      }
      throw error;
    }
    this.#logger.debug('API Key 已创建', { keyId: key.id, userId: key.userId });
    return {
      id: key.id,
      userId: key.userId,
      prefix: key.prefix,
      name: key.name,
      createdAt,
      expiresAt: key.expiresAt,
      revokedAt: null,
    };
  }

  /** 按 prefix 查一行（校验热路径，走 `UNIQUE` 索引）。不存在返回 `null`。 */
  findByPrefix(prefix: string): ApiKeyLookup | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS}, key_hash FROM api_key WHERE prefix = ?`)
      .get(prefix);
    if (row === undefined) {
      return null;
    }
    return { record: toRecord(row), keyHash: text(row['key_hash']) };
  }

  /**
   * 一个用户的全部 key，按创建时间倒序（最新的在前）。
   *
   * 包含已吊销 / 已过期的行：管理面要能回答「这把 key 为什么不工作」，
   * 过滤掉只会让用户以为 key 从未存在。
   */
  listByUser(userId: string): readonly ApiKeyRecord[] {
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM api_key WHERE user_id = ? ORDER BY created_at DESC, id ASC`,
      )
      .all(userId)
      .map(toRecord);
  }

  /**
   * 吊销一把 key。
   *
   * 幂等：已经吊销的行保留第一次的 `revoked_at`（重复吊销不刷新时间戳——
   * 「什么时候失效的」是审计信息）。不存在或未产生变更返回 `false`。
   */
  revoke(id: string, now: Date): boolean {
    const changed = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare('UPDATE api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(now.toISOString(), id).changes,
      ),
    );
    this.#logger.debug('API Key 已吊销', { keyId: id, changed });
    return changed > 0;
  }

  /** 删除一个用户的全部 key（`IdentityService.deleteUser` 用）。 */
  removeByUser(userId: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db.prepare('DELETE FROM api_key WHERE user_id = ?').run(userId).changes,
      ),
    );
    this.#logger.debug('用户的 API Key 已删除', { userId, deleted });
    return deleted;
  }
}
