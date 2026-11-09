/**
 * 用户目录仓储（架构文档 §12.1、§12.5、§12.6）。
 *
 * `app_user` 是**主体目录**：授权只认 `user:{uid}` 字符串，这一张表回答「这个 uid
 * 存不存在、是不是被禁用」。成员关系在 `group-repository.ts`，两者分开是因为
 * 「用户」与「组」没有共同的查询面：没有「按状态列组」这种东西，硬塞进一个仓储
 * 只会让每个方法多一个分支。
 *
 * ## 时间与冲突
 *
 * 时间统一 `Date.toISOString()`（与 `node` / `task` 表一致，§8.1：ISO 8601 的
 * 字典序等于时间序）。`create` 撞主键抛 `CONFLICT` 而不是 `INTERNAL`——「这个 ID
 * 已经被占用」是调用方可以处理的业务冲突（§19 的 409），不是程序缺陷。
 *
 * 只捕获主键/唯一约束（SQLite 扩展错误码 1555 / 2067）。`CHECK` 约束失败意味着
 * 调用方传了非法的枚举值，属于程序缺陷，原样抛出去由错误映射收敛成 `INTERNAL`。
 *
 * ## `session_epoch` 不出这个仓储
 *
 * `session_epoch` 是 session token 的身份版本：创建时生成、改密码时
 * 轮换、校验 token 时比对。它**不进 `User`**——`User` 会进管理面响应，身份版本是
 * 内部状态，和 `password_hash` 一样只在认证路径上读（`getSessionEpoch`）。
 */

import { randomUUID } from 'node:crypto';

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { User } from '../../domain/identity.js';
import type { Logger } from '../../domain/log.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

export interface UserRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/** 列顺序与 `User` 字段顺序一致，映射函数只依赖这个常量。 */
const USER_COLUMN_NAMES = [
  'id',
  'display_name',
  'email',
  'status',
  'created_at',
  'updated_at',
] as const;

const USER_COLUMNS = USER_COLUMN_NAMES.join(', ');

/**
 * `list` 的默认条数。
 *
 * 与 `GET /sessions`、`GET /tasks` 的默认值一致（各 100 条）：控制台一页展示
 * 100 个用户已经要滚动，再多不会有人读完。
 */
const DEFAULT_LIST_LIMIT = 100;

/** SQLite 扩展错误码：1555 = PRIMARY KEY，2067 = UNIQUE。两者都表示「主键已存在」。 */
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

/**
 * 数据库行 → `User`。
 *
 * `status` 用 `as` 收窄：写入路径只接受领域类型，表里出现的值一定是枚举成员；
 * 这里再写一遍校验只会给每个字段加一个不可能走到的分支。
 */
function toUserRow(row: Record<string, SQLOutputValue>): User {
  return {
    id: text(row['id']),
    displayName: text(row['display_name']),
    email: nullableText(row['email']),
    status: text(row['status']) as User['status'],
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  };
}

export class UserRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: UserRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /**
   * 写入用户。主键已存在抛 `CONFLICT`。
   *
   * 身份版本（`session_epoch`）在这里生成：创建账号就是开启一个新的 token 生命周期，
   * 同 ID 重建必须换一个新的版本，否则旧 token 会在重建后继续有效。
   * 随机源用 `crypto.randomUUID()`，不需要调用方参与——它没有业务含义。
   */
  create(user: Omit<User, 'createdAt' | 'updatedAt'>, now: Date): User {
    const timestamp = now.toISOString();
    try {
      withWriteTransaction(this.#db, () => {
        this.#db
          .prepare(
            `INSERT INTO app_user (${USER_COLUMNS}, session_epoch)
             VALUES (${placeholders(USER_COLUMN_NAMES.length + 1)})`,
          )
          .run(
            user.id,
            user.displayName,
            user.email,
            user.status,
            timestamp,
            timestamp,
            randomUUID(),
          );
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ComemError('CONFLICT', `用户已存在：${user.id}`, { userId: user.id });
      }
      throw error;
    }
    this.#logger.debug('用户已创建', { userId: user.id });
    return { ...user, createdAt: timestamp, updatedAt: timestamp };
  }

  get(id: string): User | null {
    const row = this.#db.prepare(`SELECT ${USER_COLUMNS} FROM app_user WHERE id = ?`).get(id);
    return row === undefined ? null : toUserRow(row);
  }

  /**
   * 读密码哈希。**不放进 `User`**：`User` 会进管理面响应，带着哈希的 DTO 只要
   * 有一次 `JSON.stringify` 就会泄露。哈希只在登录校验这一处被读到。
   *
   * 没设置密码（迁移前的行、只建了账号没设密码）返回 `null`。
   */
  getPasswordHash(id: string): string | null {
    const row = this.#db.prepare('SELECT password_hash FROM app_user WHERE id = ?').get(id);
    if (row === undefined || row['password_hash'] === null || row['password_hash'] === undefined) {
      return null;
    }
    return String(row['password_hash']);
  }

  /**
   * 读身份版本（`session_epoch`）。认证路径用：session token 的载荷必须等于它。
   *
   * 与 `getPasswordHash` 一样不放进 `User`：管理面响应不该带内部状态。用户不存在
   * 返回 `null`；空串是「版本未知」的哨兵值（`session_epoch` 的列默认值），调用方
   * 必须当成不匹配。
   */
  getSessionEpoch(id: string): string | null {
    const row = this.#db.prepare('SELECT session_epoch FROM app_user WHERE id = ?').get(id);
    if (row === undefined || row['session_epoch'] === null || row['session_epoch'] === undefined) {
      return null;
    }
    return String(row['session_epoch']);
  }

  /**
   * 写密码哈希，**同时轮换身份版本**。用户不存在返回 `false`（不抛，与 `update` 一致）。
   *
   * 轮换是改密码语义的一部分：改密码的用途之一就是「让泄露的凭据立刻失效」。只换
   * 哈希不换版本，已签发的 session token 会在整个 `exp` 窗口内继续有效——W47a 之前
   * 的「改密码不踢线」限制就是这条。
   */
  setPasswordHash(id: string, passwordHash: string, now: Date): boolean {
    const changed = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare(
            'UPDATE app_user SET password_hash = ?, session_epoch = ?, updated_at = ? WHERE id = ?',
          )
          .run(passwordHash, randomUUID(), now.toISOString(), id).changes,
      ),
    );
    this.#logger.debug('用户密码已更新', { userId: id, changed });
    return changed > 0;
  }

  /**
   * 按 ID 批量取，按 `id` 升序。
   *
   * 一次 `IN (...)` 查询；空数组直接返回空——`IN ()` 是语法错误。结果按 `id`
   * 排序而不是按入参顺序：调用方（管理面列表、ACL 页）要的是稳定输出。
   */
  getMany(ids: readonly string[]): readonly User[] {
    if (ids.length === 0) {
      return [];
    }
    return this.#db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM app_user WHERE id IN (${placeholders(ids.length)}) ORDER BY id ASC`,
      )
      .all(...ids)
      .map(toUserRow);
  }

  /**
   * 分页列表，按 `id` 升序。
   *
   * `limit` / `offset` 省略时取默认值。`limit` 传 0 返回空、传负数由 SQLite 当作
   * 「不限」——入参来自已校验的查询参数，这里不再写第二遍校验（与
   * `NodeRepository.listByScope` 同一判据）。
   */
  list(
    options: {
      readonly limit?: number;
      readonly offset?: number;
      readonly status?: User['status'];
    } = {},
  ): readonly User[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.status !== undefined) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    params.push(options.limit ?? DEFAULT_LIST_LIMIT, options.offset ?? 0);

    return this.#db
      .prepare(`SELECT ${USER_COLUMNS} FROM app_user${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...params)
      .map(toUserRow);
  }

  /**
   * 局部更新。只改传了的字段；不存在的用户返回 `null`（不抛）。
   *
   * 空补丁（三个字段都没传）不写库、不改 `updated_at`，直接返回当前行：一次
   * 「什么都不改」的请求不应该让时间戳漂移。
   */
  update(
    id: string,
    patch: Partial<Pick<User, 'displayName' | 'email' | 'status'>>,
    now: Date,
  ): User | null {
    const assignments: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.displayName !== undefined) {
      assignments.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (patch.email !== undefined) {
      assignments.push('email = ?');
      params.push(patch.email);
    }
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      params.push(patch.status);
    }
    if (assignments.length === 0) {
      return this.get(id);
    }

    assignments.push('updated_at = ?');
    params.push(now.toISOString(), id);
    const changed = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare(`UPDATE app_user SET ${assignments.join(', ')} WHERE id = ?`)
          .run(...params).changes,
      ),
    );
    if (changed === 0) {
      return null;
    }
    this.#logger.debug('用户已更新', { userId: id });
    return this.get(id);
  }

  /**
   * 硬删，返回被删的行数（0 = 不存在）。
   *
   * `group_member` / `api_key` 由外键 `ON DELETE CASCADE` 级联清掉（`0001_init.sql`）；
   * `IdentityService.deleteUser` 仍然先显式调用三个批量删除——删除日志要计数，
   * 而级联删除是看不见的。外键保证「绕过用例直接删行」时不留孤儿行。
   */
  delete(id: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db.prepare('DELETE FROM app_user WHERE id = ?').run(id).changes,
      ),
    );
    this.#logger.debug('用户已删除', { userId: id, deleted });
    return deleted;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM app_user').get();
    return Number(row?.['total'] ?? 0);
  }
}
