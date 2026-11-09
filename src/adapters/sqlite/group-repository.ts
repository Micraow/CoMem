/**
 * 组目录与组成员仓储（架构文档 §12.1、§12.5、§12.6）。
 *
 * 两张表是同一份身份数据的两半：`app_group` 是组本身，`group_member` 是「谁在哪个
 * 组里」。放在同一个仓储是因为成员的写入永远要有组存在，拆开只会让 `addMember`
 * 的调用方多记一个依赖。
 *
 * ## 成员关系为什么在应用层维护
 *
 * 最初的设计里 `group_member` 不建外键：删用户时不能级联删 ACL 里的 `user:{uid}`
 * 条目（删账号与撤权是两件事），「哪些行跟着删」必须由调用方显式决定。现在的
 * schema 给 `group_member` 加了 `ON DELETE CASCADE`（`0001_init.sql`），那是
 * **防御纵深**——仓储是公开入口，
 * 绕过用例直接删用户行时不能留下孤儿行（孤儿行会让同 ID 重建的用户立刻拿到
 * `group:{gid}` 主体）。这里仍然提供两个批量删除方法
 * （`removeMembershipsOfUser` / `removeMembershipsOfGroup`），
 * `services/identity.ts` 的 `deleteUser` / `deleteGroup` 在同一个用例里调用：
 * 删除日志要计数，级联删除没有这个插入点。
 *
 * ## `listGroupIdsOfUser` 是热路径
 *
 * 每个请求的 `IdentityService.resolve` 都要展开一次组。走
 * `idx_group_member_user`（`0001_init.sql`），一次索引等值查询，不扫表。
 *
 * ## 幂等
 *
 * `addMember` 用 `ON CONFLICT(group_id, user_id) DO UPDATE`：同一个人加两次只有
 * 一行，第二次更新 `role`，`added_at` 保持第一次加入的时间——它记的是「什么时候
 * 进的组」，改角色不是重新加入。
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { Group, GroupMember } from '../../domain/identity.js';
import type { Logger } from '../../domain/log.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

export interface GroupRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/** 列顺序与 `Group` 字段顺序一致，映射函数只依赖这个常量。 */
const GROUP_COLUMN_NAMES = [
  'id',
  'display_name',
  'description',
  'owner_user_id',
  'created_at',
  'updated_at',
] as const;

const GROUP_COLUMNS = GROUP_COLUMN_NAMES.join(', ');

/** 列顺序与 `GroupMember` 字段顺序一致。 */
const MEMBER_COLUMN_NAMES = ['group_id', 'user_id', 'role', 'added_at'] as const;

const MEMBER_COLUMNS = MEMBER_COLUMN_NAMES.join(', ');

/**
 * `list` 的默认条数。
 *
 * 与 `GET /sessions`、`GET /tasks`、`UserRepository.list` 的默认值一致（各 100 条）：
 * 控制台一页 100 个组已经要滚动。
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

function toGroupRow(row: Record<string, SQLOutputValue>): Group {
  return {
    id: text(row['id']),
    displayName: text(row['display_name']),
    description: nullableText(row['description']),
    ownerUserId: nullableText(row['owner_user_id']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  };
}

function toGroupMemberRow(row: Record<string, SQLOutputValue>): GroupMember {
  return {
    groupId: text(row['group_id']),
    userId: text(row['user_id']),
    role: text(row['role']) as GroupMember['role'],
    addedAt: text(row['added_at']),
  };
}

export class GroupRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: GroupRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /** 写入组。主键已存在抛 `CONFLICT`。 */
  create(group: Omit<Group, 'createdAt' | 'updatedAt'>, now: Date): Group {
    const timestamp = now.toISOString();
    try {
      withWriteTransaction(this.#db, () => {
        this.#db
          .prepare(
            `INSERT INTO app_group (${GROUP_COLUMNS}) VALUES (${placeholders(GROUP_COLUMN_NAMES.length)})`,
          )
          .run(
            group.id,
            group.displayName,
            group.description,
            group.ownerUserId,
            timestamp,
            timestamp,
          );
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ComemError('CONFLICT', `组已存在：${group.id}`, { groupId: group.id });
      }
      throw error;
    }
    this.#logger.debug('组已创建', { groupId: group.id });
    return { ...group, createdAt: timestamp, updatedAt: timestamp };
  }

  get(id: string): Group | null {
    const row = this.#db.prepare(`SELECT ${GROUP_COLUMNS} FROM app_group WHERE id = ?`).get(id);
    return row === undefined ? null : toGroupRow(row);
  }

  /** 分页列表，按 `id` 升序。`limit` / `offset` 语义同 `UserRepository.list`。 */
  list(options: { readonly limit?: number; readonly offset?: number } = {}): readonly Group[] {
    return this.#db
      .prepare(`SELECT ${GROUP_COLUMNS} FROM app_group ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(
        options.limit ?? DEFAULT_LIST_LIMIT,
        options.offset ?? 0,
      )
      .map(toGroupRow);
  }

  /**
   * 局部更新。只改传了的字段；不存在的组返回 `null`（不抛）。
   *
   * 空补丁不改 `updated_at`，直接返回当前行（与 `UserRepository.update` 一致）。
   */
  update(
    id: string,
    patch: Partial<Pick<Group, 'displayName' | 'description'>>,
    now: Date,
  ): Group | null {
    const assignments: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.displayName !== undefined) {
      assignments.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (patch.description !== undefined) {
      assignments.push('description = ?');
      params.push(patch.description);
    }
    if (assignments.length === 0) {
      return this.get(id);
    }

    assignments.push('updated_at = ?');
    params.push(now.toISOString(), id);
    const changed = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare(`UPDATE app_group SET ${assignments.join(', ')} WHERE id = ?`)
          .run(...params).changes,
      ),
    );
    if (changed === 0) {
      return null;
    }
    this.#logger.debug('组已更新', { groupId: id });
    return this.get(id);
  }

  /**
   * 改组的 owner，不存在的组返回 `null`。
   *
   * 单独一个方法而不是塞进 `update` 的补丁：owner 变更还要同步改写组根的
   * `.acl.json`（`AclService.setGroupOwner`），混在「改显示名」里会让调用方
   * 以为它只是一次目录行更新。
   */
  setOwner(id: string, userId: string, now: Date): Group | null {
    const changed = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare('UPDATE app_group SET owner_user_id = ?, updated_at = ? WHERE id = ?')
          .run(userId, now.toISOString(), id).changes,
      ),
    );
    if (changed === 0) {
      return null;
    }
    this.#logger.debug('组 owner 已更新', { groupId: id, ownerUserId: userId });
    return this.get(id);
  }

  /**
   * 清掉某个用户名下的组 owner，返回受影响的组数（`IdentityService.deleteUser` 用）。
   *
   * `owner_user_id` 是元数据，不是授权（§12.2）：它只决定「谁能改 owner」。不清掉的
   * 话，同 ID 重建的账号会被 `POST /admin/groups/{id}/owner` 当成当前 owner，跳过
   * 组根求权，等于拿到组的管理权。
   *
   * `app_group.owner_user_id` 有 `ON DELETE SET NULL` 外键（`0001_init.sql`）：绕过
   * `IdentityService.deleteUser` 直接删用户行时，这条清理也会生效。应用层保留它是
   * 因为删除日志要计数（外键是防御纵深，不是替代）。
   *
   * 置 `NULL` 的组只有 `group:{gid} = write`，没有主体能求 manage，**只能通过
   * `pnpm group:owner` 恢复**（§12.6）——所以要返回受影响的组数，让删除用户的那条
   * 日志能指出哪些组需要人工接管。
   */
  clearOwnerOfUser(userId: string, now: Date): number {
    const cleared = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare('UPDATE app_group SET owner_user_id = NULL, updated_at = ? WHERE owner_user_id = ?')
          .run(now.toISOString(), userId).changes,
      ),
    );
    this.#logger.debug('组 owner 已清空', { userId, groups: cleared });
    return cleared;
  }

  /**
   * 硬删组，返回被删的行数（0 = 不存在）。
   *
   * `group_member` 由外键 `ON DELETE CASCADE` 级联清掉（`0001_init.sql`）；
   * `IdentityService.deleteGroup` 仍然先显式调用批量删除——删除日志要计数。
   */
  delete(id: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db.prepare('DELETE FROM app_group WHERE id = ?').run(id).changes,
      ),
    );
    this.#logger.debug('组已删除', { groupId: id, deleted });
    return deleted;
  }

  /**
   * 加成员，**幂等**：已存在时更新 `role`，返回当前行。
   *
   * 不在这里检查组/用户是否存在：仓储只做行与值的转换，存在性检查在
   * `IdentityService.addMember`。
   */
  addMember(
    groupId: string,
    userId: string,
    role: GroupMember['role'],
    now: Date,
  ): GroupMember {
    const addedAt = now.toISOString();
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO group_member (${MEMBER_COLUMNS})
           VALUES (${placeholders(MEMBER_COLUMN_NAMES.length)})
           ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(groupId, userId, role, addedAt);
    });
    this.#logger.debug('组成员已写入', { groupId, userId, role });

    const member = this.#getMember(groupId, userId);
    if (member === null) {
      // 类型上不可达：上面那条 INSERT 保证行存在。走到这里说明数据库被改坏了。
      throw new ComemError('INTERNAL', `组成员写入后读不到：${groupId}/${userId}`, {
        groupId,
        userId,
      });
    }
    return member;
  }

  /** 删除一个成员关系，返回被删的行数（0 = 不是成员）。 */
  removeMember(groupId: string, userId: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare('DELETE FROM group_member WHERE group_id = ? AND user_id = ?')
          .run(groupId, userId).changes,
      ),
    );
    this.#logger.debug('组成员已删除', { groupId, userId, deleted });
    return deleted;
  }

  /**
   * 删除用户的全部成员关系（`IdentityService.deleteUser` 用），返回删除的行数。
   *
   * 批量删除而不是按组逐个删：删用户是「一个人从所有组里消失」，逐组删是 N 次
   * 事务，中间失败会留下部分成员关系。
   */
  removeMembershipsOfUser(userId: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db.prepare('DELETE FROM group_member WHERE user_id = ?').run(userId).changes,
      ),
    );
    this.#logger.debug('用户的组成员关系已删除', { userId, deleted });
    return deleted;
  }

  /** 删除组的全部成员关系（`IdentityService.deleteGroup` 用），返回删除的行数。 */
  removeMembershipsOfGroup(groupId: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db.prepare('DELETE FROM group_member WHERE group_id = ?').run(groupId).changes,
      ),
    );
    this.#logger.debug('组的成员关系已删除', { groupId, deleted });
    return deleted;
  }

  /**
   * 组成员，按 `user_id` 升序。
   *
   * 按 `user_id` 而不是 `added_at`：时间戳会撞，撞了就依赖 SQLite 的物理顺序，
   * 同一份数据两次查询可能给出不同顺序。
   */
  listMembers(groupId: string): readonly GroupMember[] {
    return this.#db
      .prepare(
        `SELECT ${MEMBER_COLUMNS} FROM group_member WHERE group_id = ? ORDER BY user_id ASC`,
      )
      .all(groupId)
      .map(toGroupMemberRow);
  }

  /**
   * 用户加入的组 ID，按升序。身份展开的热路径（每请求一次），走
   * `idx_group_member_user`。
   */
  listGroupIdsOfUser(userId: string): readonly string[] {
    return this.#db
      .prepare('SELECT group_id FROM group_member WHERE user_id = ? ORDER BY group_id ASC')
      .all(userId)
      .map((row) => text(row['group_id']));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM app_group').get();
    return Number(row?.['total'] ?? 0);
  }

  #getMember(groupId: string, userId: string): GroupMember | null {
    const row = this.#db
      .prepare(
        `SELECT ${MEMBER_COLUMNS} FROM group_member WHERE group_id = ? AND user_id = ?`,
      )
      .get(groupId, userId);
    return row === undefined ? null : toGroupMemberRow(row);
  }
}
