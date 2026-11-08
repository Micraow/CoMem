/**
 * 身份用例（架构文档 §12.1、§12.5、§12.6）。
 *
 * 这一层把「用户目录 + 组成员」拼成一次请求的身份：HTTP 层从
 * `x-comem-subject` 拿到 `user:alice`，`resolve` 展开成
 * `['group:eng', 'user:alice']`，`AclService` 只认这个集合。规则全部在
 * `domain/identity.ts`，持久化全部在两个仓储，这里只做三件事：校验入口、把
 * 「不存在」翻译成 `NOT_FOUND`、把「解析失败」翻译成 `null`。
 *
 * ## 删账号与撤权是同一次操作
 *
 * 删一个用户 / 组时，除了成员关系（孤儿行会让 `listMembers` 返回不存在的用户），
 * 还必须把该主体的 ACL 条目从各目录的 `.acl.json` 里移除。`node_permission` 与
 * `acl_entry` 是 `.acl.json` 的物化结果：只删行不改文件，下一次 `materializeNode`
 * 就会把授权算回来——删掉的账号重新创建同 ID 的用户会立刻继承旧授权，这是一条
 * 提权路径。
 *
 * **编排在 HTTP 管理面（`api/http/routes/admin.ts`），不在这里。** 改 `.acl.json`
 * 是异步文件写入，而 `deleteUser` / `deleteGroup` 是同步方法（`node:sqlite` 的写
 * 事务也要求同步回调）；改成 `async` 会波及所有调用方。所以
 * `DELETE /admin/users/{id}` 与 `DELETE /admin/groups/{id}` 先调
 * `AclService.purgePrincipal` 撤权，再调这里的删除。
 *
 * ## 根预置不在这里
 *
 * `createUser` / `createGroup` 只写目录表，不往 `.acl.json` 写根预置（§12.6）。
 * bootstrap 预置配置主体的 user 根；控制台建的组由路由在创建后调
 * `AclService.ensureRootPreset`——「组只能由 bootstrap 预置」这个划分在「控制台
 * 能建组」之后就不成立了，不补的话新建的组没有任何可授权、可读的根。
 *
 * ## `user:*` 不自动加入
 *
 * `resolveSubject` 的 `principals` 只包含 `user:{uid}` 与 `group:{gid}`。通配符由
 * `AclService.resolvePrincipals` 在求权时追加（§12.1：它命中所有 user 主体），
 * 不属于「这个用户加入了什么」。
 *
 * ## 两套凭据（§12.7）
 *
 * `resolve(credential)` 是认证入口：用户名 + 密码（登录换 session token）与
 * API Key。两者都只回答「这个请求是哪个用户」，不携带权限范围——范围靠路径级
 * ACL 表达。**组关系每请求查库**（`listGroupIdsOfUser`）：SQLite 单机微秒级，
 * 缓存只会让「退组立即生效」变成「重启后生效」。
 *
 * API Key 的 secret 用与密码相同的 scrypt 编码（`services/password.ts`）。一把
 * key 就是一个 `(user_id)` 的完整凭证：见迁移 0013 的注释，那里写了为什么不做
 * key 级 scope。
 */

import type { ApiKeyRecord, ApiKeyRepository } from '../adapters/sqlite/api-key-repository.js';
import type { GroupRepository } from '../adapters/sqlite/group-repository.js';
import type { UserRepository } from '../adapters/sqlite/user-repository.js';
import { parsePrincipal, userPrincipal } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Group, GroupMember, Identity, User } from '../domain/identity.js';
import { assertValidGroupId, assertValidUserId, buildIdentity } from '../domain/identity.js';
import type { Logger } from '../domain/log.js';
import { generateApiKey, parseApiKey } from './api-key.js';
import { hashSecret, verifySecret } from './password.js';

/**
 * 用户命名空间的预置端口。
 *
 * 建用户时要建 `comem://user/{uid}/` 与四个上下文目录，并物化它们的权限行——否则
 * 新用户 `find` 一条都搜不到（目录不存在，物化不出行）。这段逻辑要写磁盘、要
 * 调 `AclService`，都不属于身份用例；由装配层注入，`IdentityService` 只负责
 * 「创建用户之后立刻预置」这个顺序。
 */
export interface UserNamespace {
  ensure(userId: string): Promise<void>;
}

export interface IdentityServiceDeps {
  readonly users: UserRepository;
  readonly groups: GroupRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly namespace: UserNamespace;
  readonly logger: Logger;
}

/**
 * 认证凭据。
 *
 * 三种形态对应两个入口：`password` 是登录，`api-key` 是请求头里的
 * `Authorization: Bearer comem_...`，`session` 是已经由 `AuthService` 校验过
 * 签名的 token 载荷（这里只做用户存在性检查）。
 */
export type Credential =
  | { readonly kind: 'password'; readonly username: string; readonly password: string }
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'session'; readonly userId: string };

/**
 * 一次已认证请求的身份（§12.7）。
 *
 * `subject` 恒为 `user:{uid}`：API Key 与 session token 都只认证用户，组不能当
 * 认证主体。`principals` 是展开后的主体集合，末尾带 `user:*`。
 */
export interface RequestContext {
  /** `user:{uid}`，恒为 user 主体，绝不可能是 group。 */
  readonly subject: string;
  /** 展开后的主体集合：`[user:{uid}, ...group:{gid}, user:*]` */
  readonly principals: readonly string[];
  /** 走了哪把 key 的 id；session token 认证时为 null */
  readonly apiKeyId: string | null;
}

function unauthenticated(message: string): ComemError {
  return new ComemError('UNAUTHENTICATED', message);
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
  readonly #apiKeys: ApiKeyRepository;
  readonly #namespace: UserNamespace;
  readonly #logger: Logger;

  constructor(deps: IdentityServiceDeps) {
    this.#users = deps.users;
    this.#groups = deps.groups;
    this.#apiKeys = deps.apiKeys;
    this.#namespace = deps.namespace;
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
   * 删除用户，同时清掉它的组成员关系与它持有的组 owner。不存在抛 `NOT_FOUND`。
   *
   * 先删成员关系再删用户：反过来的话，删用户成功后成员关系写入失败就留下孤儿行，
   * 而那条行连「属于谁」都查不到。
   *
   * **组 owner 必须一起清。** `app_group.owner_user_id` 是元数据不是授权（§12.2），
   * 但 `POST /admin/groups/{id}/owner` 把它当成「当前 owner 可以改」的依据。残留的
   * ID 在同 ID 重建账号后会让路由跳过组根求权——重建的账号拿到组的管理权，尽管它
   * 从未被授予任何东西。置 `NULL` 的组没有 manage 持有者，恢复走 `pnpm group:owner`
   * （§12.6），日志里的 `ownedGroups` 指出哪些组需要人工接管。
   *
   * 这里**不**撤 ACL。撤权是 `AclService.purgePrincipal`（异步写 `.acl.json`），
   * 由 `DELETE /admin/users/{id}` 在调用本方法之前完成——只删物化行不改文件的话，
   * 下次物化会把授权算回来。见文件头。
   */
  deleteUser(id: string, now: Date = new Date()): void {
    if (this.#users.get(id) === null) {
      throw userNotFound(id);
    }
    const memberships = this.#groups.removeMembershipsOfUser(id);
    const ownedGroups = this.#groups.clearOwnerOfUser(id, now);
    const apiKeys = this.#apiKeys.removeByUser(id);
    this.#users.delete(id);
    this.#logger.info('用户已删除', { userId: id, memberships, ownedGroups, apiKeys });
  }

  // ── 组 ──

  /**
   * 创建组。ID 非法抛 `INVALID_ARGUMENT`，已存在抛 `CONFLICT`。
   *
   * 不写 `comem://group/{gid}/` 的根预置：那是 `AclService.ensureRootPreset` 的
   * 异步写盘，由 `POST /admin/groups` 在创建后调用。不补的话组没有任何可授权的根，
   * 成员也拿不到可读范围——这个组是死的。见文件头。
   */
  createGroup(
    input: {
      readonly id: string;
      readonly displayName: string;
      readonly description?: string | null;
      /** 创建者；根预置会用它的 `manage` 权限（§12.6）。缺省 `null`（还没人管）。 */
      readonly ownerUserId?: string | null;
    },
    now: Date = new Date(),
  ): Group {
    const id = assertValidGroupId(input.id);
    const group = this.#groups.create(
      {
        id,
        displayName: input.displayName,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
      },
      now,
    );
    this.#logger.info('组已创建', { groupId: group.id, ownerUserId: group.ownerUserId });
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

  /**
   * 改组 owner。组或用户不存在抛 `NOT_FOUND`，owner 不是合法用户 ID 抛
   * `INVALID_ARGUMENT`。
   *
   * 只写 `app_group.owner_user_id`：组根的 `.acl.json` 由
   * `AclService.setGroupOwner` 同步（那是权限的真相）。两个写入不在一个事务里
   * ——文件系统与 SQLite 没有跨介质事务，顺序与 `setAcl` 相同：先写文件，再写
   * 目录行。
   *
   * `assertValidUserId` 是防御纵深（§12.2）：HTTP 路由已经校验过，但服务方法是
   * 公开入口，直接传 `*` 会让 `owner_user_id` 与 `user:*` 主体同形——而通配主体
   * 在组根上等于 manage。
   */
  setGroupOwner(id: string, userId: string, now: Date = new Date()): Group {
    if (this.#groups.get(id) === null) {
      throw groupNotFound(id);
    }
    const ownerUserId = assertValidUserId(userId);
    if (this.#users.get(ownerUserId) === null) {
      throw userNotFound(ownerUserId);
    }
    const updated = this.#groups.setOwner(id, ownerUserId, now);
    if (updated === null) {
      // 类型上不可达：上面已经确认组存在。走到这里说明数据库被改坏了。
      throw groupNotFound(id);
    }
    this.#logger.info('组 owner 已更新', { groupId: id, ownerUserId });
    return updated;
  }

  /**
   * 删除组，同时清掉它的成员关系。不存在抛 `NOT_FOUND`。
   *
   * 同 `deleteUser`：ACL 由路由先调 `AclService.purgePrincipal` 撤掉，这里只删
   * 目录行与成员关系。
   */
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

  // ── 认证 ──

  /**
   * 认证一次请求，返回请求身份（§12.7）。
   *
   * 三种凭据走同一条出口：先确认用户存在且 `active`，再按当前组成员关系展开
   * principals。失败一律抛 `UNAUTHENTICATED`（401），**不区分**「用户不存在」
   * 「密码错」「key 过期」——区分开就是账号枚举。
   *
   * 组关系每请求查库，不缓存：`listGroupIdsOfUser` 是单条 SQLite 索引查询，
   * 微秒级；缓存只会让「退组立即生效」变成「重启后生效」。
   */
  async resolve(credential: Credential): Promise<RequestContext> {
    switch (credential.kind) {
      case 'password': {
        const user = this.#users.get(credential.username);
        if (user === null) {
          throw unauthenticated('用户名或密码错误。');
        }
        const hash = this.#users.getPasswordHash(user.id);
        // 没设密码的账号不能走密码登录——否则 `verifySecret('', null)` 这类
        // 边界就成了登录绕过。哈希比对放在 `verifySecret` 里。
        if (hash === null || !(await verifySecret(credential.password, hash))) {
          throw unauthenticated('用户名或密码错误。');
        }
        return this.#contextFor(user.id, null);
      }
      case 'api-key': {
        const parsed = parseApiKey(credential.apiKey);
        if (parsed === null) {
          throw unauthenticated('API Key 格式不正确。');
        }
        const lookup = this.#apiKeys.findByPrefix(parsed.prefix);
        if (lookup === null) {
          throw unauthenticated('API Key 无效。');
        }
        if (!(await verifySecret(parsed.secret, lookup.keyHash))) {
          throw unauthenticated('API Key 无效。');
        }
        if (lookup.record.revokedAt !== null) {
          throw unauthenticated('API Key 已被撤销。');
        }
        if (lookup.record.expiresAt !== null && Date.parse(lookup.record.expiresAt) <= Date.now()) {
          throw unauthenticated('API Key 已过期。');
        }
        return this.#contextFor(lookup.record.userId, lookup.record.id);
      }
      case 'session': {
        // 签名已由 `AuthService` 校验；这里只补用户存在性（token 签发后账号可能
        // 被删或禁用，签名仍然有效）。
        return this.#contextFor(credential.userId, null);
      }
    }
  }

  /**
   * 把「主体字符串」解析成一次请求的身份（v1 路径，`auth.enabled: false`）。
   *
   * 输入形如 `user:alice`。解析失败（格式不对 / 用户不存在 / 已禁用）返回 `null`，
   * **不抛**——HTTP 层要把它映射成 401 而不是 500。
   *
   * `user:*` 返回 `null`：它是通配主体，不是真实用户。通配符由 ACL 求值侧按
   * 「主体是否以 `user:` 开头」处理（`domain/acl.ts` 的 `entryMatches`）。
   */
  resolveSubject(subject: string): Identity | null {
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

  /** 给用户设密码（管理端点）。用户不存在抛 `NOT_FOUND`。 */
  async setPassword(userId: string, password: string, now: Date = new Date()): Promise<void> {
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    const hash = await hashSecret(password);
    this.#users.setPasswordHash(userId, hash, now);
    this.#logger.info('用户密码已设置', { userId });
  }

  /**
   * 签发一把 API Key。明文只在这里返回一次，库里只有哈希与前缀。
   *
   * `name` 用来区分用途（控制台「CI 用的 key」），不是权限范围——见迁移 0013。
   */
  async createApiKey(
    userId: string,
    input: { readonly name: string; readonly expiresAt?: string | null },
    now: Date = new Date(),
  ): Promise<{ readonly raw: string; readonly record: ApiKeyRecord }> {
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    const generated = generateApiKey();
    const record = this.#apiKeys.create(
      {
        id: `key_${generated.prefix}`,
        userId,
        keyHash: await hashSecret(generated.secret),
        prefix: generated.prefix,
        name: input.name,
        expiresAt: input.expiresAt ?? null,
      },
      now,
    );
    this.#logger.info('API Key 已签发', { userId, keyId: record.id, name: record.name });
    return { raw: generated.raw, record };
  }

  listApiKeys(userId: string): readonly ApiKeyRecord[] {
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    return this.#apiKeys.listByUser(userId);
  }

  /** 撤销一把 key。重复撤销是幂等的（保留第一次的 `revoked_at`）。 */
  revokeApiKey(keyId: string, now: Date = new Date()): boolean {
    const revoked = this.#apiKeys.revoke(keyId, now);
    if (revoked) {
      this.#logger.info('API Key 已撤销', { keyId });
    }
    return revoked;
  }

  /** 建用户之后预置命名空间（根 + 四个上下文目录 + 权限行）。 */
  async ensureUserNamespace(userId: string): Promise<void> {
    await this.#namespace.ensure(userId);
  }

  #contextFor(userId: string, apiKeyId: string | null): RequestContext {
    const user = this.#users.get(userId);
    if (user === null || user.status !== 'active') {
      throw unauthenticated('账号不存在或已被禁用。');
    }
    const identity = buildIdentity(userId, this.#groups.listGroupIdsOfUser(userId));
    return {
      subject: userPrincipal(userId),
      principals: [...identity.principals, 'user:*'],
      apiKeyId,
    };
  }
}
