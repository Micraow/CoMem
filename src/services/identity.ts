/**
 * 身份用例（架构文档 §12.1、§12.5、§12.6）。
 *
 * 这一层把「用户目录 + 组成员」拼成一次请求的身份：HTTP 层从
 * `x-comem-subject` 拿到 `user:alice`，`resolve` 展开成
 * `['group:eng', 'user:alice']`，`AclService` 只认这个集合。规则全部在
 * `domain/identity.ts`，持久化全部在两个仓储，这里只做三件事：校验入口、把
 * 「不存在」翻译成 `NOT_FOUND`、把「解析失败」翻译成 `null`。
 *
 * ## 删用户与删组不级联 ACL
 *
 * 成员关系要删：孤儿行会让 `listMembers` 返回不存在的用户，而那份列表没有任何
 * 查询方能解释它。ACL 里的 `user:{uid}` / `group:{gid}` 条目**不删**：删账号是
 * 账号管理，撤权是管理员的显式动作（§12.5）。两者混在一起，一次误删账号会静默
 * 清掉所有授权，重建用户后权限全部消失。
 *
 * ## 根预置不在这里
 *
 * `createUser` 只写 `app_user`，不往 `.acl.json` 写 `user:{uid} = manage`。根预置
 * 是 bootstrap 的职责（§12.6），服务层越界写盘会让「用服务建用户」和「用 bootstrap
 * 建根」两条路径各有一份预置逻辑。
 *
 * ## `user:*` 不自动加入
 *
 * `resolve` 的 `principals` 只包含 `user:{uid}` 与 `group:{gid}`。通配符由
 * `AclService.resolvePrincipals` 在求权时追加（§12.1：它命中所有 user 主体），
 * 不属于「这个用户加入了什么」。
 */

import type { GroupRepository } from '../adapters/sqlite/group-repository.js';
import type { UserRepository } from '../adapters/sqlite/user-repository.js';
import { parsePrincipal } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Group, GroupMember, Identity, User } from '../domain/identity.js';
import { assertValidGroupId, assertValidUserId, buildIdentity } from '../domain/identity.js';
import type { Logger } from '../domain/log.js';

export interface IdentityServiceDeps {
  readonly users: UserRepository;
  readonly groups: GroupRepository;
  readonly logger: Logger;
}

function userNotFound(id: string): ComemError {
  return new ComemError('NOT_FOUND', `用户不存在：${id}`, { userId: id });
}

function groupNotFound(id: string): ComemError {
  return new ComemError('NOT_FOUND', `组不存在：${id}`, { groupId: id });
}

export class IdentityService {
  readonly #users: UserRepository;
  readonly #groups: GroupRepository;
  readonly #logger: Logger;

  constructor(deps: IdentityServiceDeps) {
    this.#users = deps.users;
    this.#groups = deps.groups;
    this.#logger = deps.logger;
  }

  // ── 用户 ──

  /** 创建用户。ID 非法抛 `INVALID_ARGUMENT`，已存在抛 `CONFLICT`。 */
  createUser(
    input: { readonly id: string; readonly displayName: string; readonly email?: string | null },
    now: Date = new Date(),
  ): User {
    const id = assertValidUserId(input.id);
    const user = this.#users.create(
      { id, displayName: input.displayName, email: input.email ?? null, status: 'active' },
      now,
    );
    this.#logger.info('用户已创建', { userId: user.id });
    return user;
  }

  /** 取用户；不存在或已禁用返回 `null`（调用方决定 401 还是 404）。 */
  getUser(id: string): User | null {
    const user = this.#users.get(id);
    return user !== null && user.status === 'active' ? user : null;
  }

  listUsers(options?: { readonly limit?: number; readonly offset?: number }): readonly User[] {
    return this.#users.list(options);
  }

  /** 更新用户，不存在抛 `NOT_FOUND`。已禁用的用户同样可以更新（重新启用）。 */
  updateUser(
    id: string,
    patch: { displayName?: string; email?: string | null; status?: User['status'] },
    now: Date = new Date(),
  ): User {
    const updated = this.#users.update(id, patch, now);
    if (updated === null) {
      throw userNotFound(id);
    }
    this.#logger.info('用户已更新', { userId: id, fields: Object.keys(patch) });
    return updated;
  }

  /**
   * 删除用户，同时清掉它的组成员关系。不存在抛 `NOT_FOUND`。
   *
   * 先删成员关系再删用户：反过来的话，删用户成功后成员关系写入失败就留下孤儿行，
   * 而那条行连「属于谁」都查不到。
   */
  deleteUser(id: string): void {
    if (this.#users.get(id) === null) {
      throw userNotFound(id);
    }
    const memberships = this.#groups.removeMembershipsOfUser(id);
    this.#users.delete(id);
    this.#logger.info('用户已删除', { userId: id, memberships });
  }

  // ── 组 ──

  /** 创建组。ID 非法抛 `INVALID_ARGUMENT`，已存在抛 `CONFLICT`。 */
  createGroup(
    input: {
      readonly id: string;
      readonly displayName: string;
      readonly description?: string | null;
    },
    now: Date = new Date(),
  ): Group {
    const id = assertValidGroupId(input.id);
    const group = this.#groups.create(
      { id, displayName: input.displayName, description: input.description ?? null },
      now,
    );
    this.#logger.info('组已创建', { groupId: group.id });
    return group;
  }

  getGroup(id: string): Group | null {
    return this.#groups.get(id);
  }

  listGroups(options?: { readonly limit?: number; readonly offset?: number }): readonly Group[] {
    return this.#groups.list(options);
  }

  /** 更新组，不存在抛 `NOT_FOUND`。 */
  updateGroup(
    id: string,
    patch: { displayName?: string; description?: string | null },
    now: Date = new Date(),
  ): Group {
    const updated = this.#groups.update(id, patch, now);
    if (updated === null) {
      throw groupNotFound(id);
    }
    this.#logger.info('组已更新', { groupId: id, fields: Object.keys(patch) });
    return updated;
  }

  /** 删除组，同时清掉它的成员关系。不存在抛 `NOT_FOUND`。 */
  deleteGroup(id: string): void {
    if (this.#groups.get(id) === null) {
      throw groupNotFound(id);
    }
    const memberships = this.#groups.removeMembershipsOfGroup(id);
    this.#groups.delete(id);
    this.#logger.info('组已删除', { groupId: id, memberships });
  }

  // ── 成员 ──

  /**
   * 加成员，默认角色 `member`。组或用户不存在抛 `NOT_FOUND`。
   *
   * 存在性检查放在服务层：迁移 0008 不建外键（见迁移注释），没有数据库兜底，
   * 这里漏掉就会写出 `listMembers` 无法解释的孤儿行。已禁用的用户可以加入组——
   * 成员关系是数据，禁用是登录状态，重新启用后关系自动生效。
   */
  addMember(
    groupId: string,
    userId: string,
    role: GroupMember['role'] = 'member',
    now: Date = new Date(),
  ): GroupMember {
    if (this.#groups.get(groupId) === null) {
      throw groupNotFound(groupId);
    }
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    const member = this.#groups.addMember(groupId, userId, role, now);
    this.#logger.info('组成员已加入', { groupId, userId, role });
    return member;
  }

  /** 移除成员。不是成员抛 `NOT_FOUND`。 */
  removeMember(groupId: string, userId: string): void {
    if (this.#groups.removeMember(groupId, userId) === 0) {
      throw new ComemError('NOT_FOUND', `用户 ${userId} 不是组 ${groupId} 的成员。`, {
        groupId,
        userId,
      });
    }
    this.#logger.info('组成员已移除', { groupId, userId });
  }

  /** 组成员列表；组不存在抛 `NOT_FOUND`。 */
  listMembers(groupId: string): readonly GroupMember[] {
    if (this.#groups.get(groupId) === null) {
      throw groupNotFound(groupId);
    }
    return this.#groups.listMembers(groupId);
  }

  /**
   * 把「主体字符串」解析成一次请求的身份。
   *
   * 输入形如 `user:alice`。解析失败（格式不对 / 用户不存在 / 已禁用）返回 `null`，
   * **不抛**——HTTP 层要把它映射成 401 而不是 500。
   *
   * `user:*` 返回 `null`：它是通配主体，不是真实用户。通配符由 ACL 求值侧按
   * 「主体是否以 `user:` 开头」处理（`domain/acl.ts` 的 `entryMatches`）。
   *
   * 这是热路径：每个请求一次，一次 SQL（`listGroupIdsOfUser`）。
   */
  resolve(subject: string): Identity | null {
    let userId: string;
    try {
      const parsed = parsePrincipal(subject);
      if (parsed.kind !== 'user') {
        return null;
      }
      userId = parsed.id;
    } catch {
      return null;
    }

    const user = this.#users.get(userId);
    if (user === null || user.status !== 'active') {
      return null;
    }
    return buildIdentity(userId, this.#groups.listGroupIdsOfUser(userId));
  }
}
