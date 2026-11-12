/**
 * 身份用例（架构文档 §12.1、§12.5、§12.6）。
 *
 * 这一层把「用户目录 + 组成员」拼成一次请求的身份：HTTP 层从凭据（或回环信任）
 * 拿到 `user:alice`，`resolve` 展开成 `['group:eng', 'user:alice']`，
 * `AclService` 只认这个集合。规则全部在
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
 * **两个主体之外，还要清掉命名空间里的直接授权。** `purgePrincipal` 只按主体清：
 * `comem://user/alice/...` 上 `group:eng = read` 这样的条目不是 alice 作为主体的
 * 授权。账号不存在了，它们挂在一条谁都解释不了的路径上，同 ID 重建后组员仍然能读
 * 旧数据。所以 `DELETE /admin/users/{id}` 在 `purgePrincipal` 之后还要调
 * `AclService.purgeSubtree('comem://user/{uid}')`；删组同理（`comem://group/{gid}`）。
 *
 * **召回账本也要删。** `_meta/recall/{scopeKey}.recall_log.json` 记的是「这个作用域
 * 投过哪些 URI」，同 ID 重建后去重状态会带进新生命周期，第一次召回可能返回空。
 * 账本按作用域分片（`scopeKeyOf` = `user_alice` / `group_eng`），删除同样由管理面
 * 编排。
 *
 * **编排在 HTTP 管理面（`api/http/routes/admin.ts`），不在这里。** 改 `.acl.json`
 * 与删账本都是异步文件操作，而 `deleteUser` / `deleteGroup` 是同步方法
 * （`node:sqlite` 的写事务也要求同步回调）；改成 `async` 会波及所有调用方。所以
 * `DELETE /admin/users/{id}` 与 `DELETE /admin/groups/{id}` 先删账本、再调
 * `AclService.purgePrincipal` / `purgeSubtree`，最后调这里的删除。
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
 * key 就是一个 `(user_id)` 的完整凭证：`api_key` 表没有 scope 列，权限范围始终由
 * 路径级 ACL 表达（§12.5）。
 *
 * ## session token 还要比身份版本
 *
 * `session` 凭据除了用户 ID 还带 `epoch`（`app_user.session_epoch`）。
 * 只确认「用户存在且 active」不够：删账号再重建同 ID 时两件事都成立，旧 token 在
 * 整个 `exp` 窗口内继续有效——撤销访问的动作本身失效。身份版本在重建账号与改密码
 * 时轮换，比对它让这两条路径上的旧 token 立刻 401。比对放在服务层而不是
 * `AuthService`：绕过 `resolveBearer` 直接调 `resolve` 的代码也要被挡住。
 */

import type { ApiKeyRecord, ApiKeyRepository } from '../adapters/sqlite/api-key-repository.js';
import type { GroupRepository } from '../adapters/sqlite/group-repository.js';
import type { UserRepository } from '../adapters/sqlite/user-repository.js';
import { USER_WILDCARD, parsePrincipal, userPrincipal } from '../domain/acl.js';
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
 * `Authorization: Bearer comem_...`，`session` 是 `AuthService` 校验过签名的
 * token 载荷（用户 ID + 身份版本，这里做存在性与版本比对）。
 */
export type Credential =
  | { readonly kind: 'password'; readonly username: string; readonly password: string }
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'session'; readonly userId: string; readonly epoch: string };

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

/**
 * 成员角色是派生值：唯一真相是 `app_group.owner_user_id`。
 *
 * 不读 `group_member.role`：那一列可能写着 `owner`，但授权从来不认它，写进去只会
 * 让人以为那个用户能管理组。
 */
function roleOf(ownerUserId: string | null, userId: string): GroupMember['role'] {
  return ownerUserId === userId ? 'owner' : 'member';
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
   * 这里**不**撤 ACL、也不删召回账本。撤权是 `AclService.purgePrincipal` +
   * `purgeSubtree`（异步写 `.acl.json`），账本是 `RecallLedger.remove`（异步删
   * 文件），都由 `DELETE /admin/users/{id}` 在调用本方法之前完成——只删物化行不改
   * 文件的话，下次物化会把授权算回来。见文件头。
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
   * 同 `deleteUser`：ACL 由路由先调 `AclService.purgePrincipal`（组主体）与
   * `purgeSubtree`（子树里的直接授权）撤掉，召回账本由 `RecallLedger.remove` 删掉，
   * 这里只删目录行与成员关系。
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
   * 加成员。组或用户不存在抛 `NOT_FOUND`。
   *
   * **不接收角色**：组的 owner 是 `app_group.owner_user_id`，不是成员行上的属性。
   * `group_member.role` 列已废弃，这里仍按旧签名写一个 `'member'`（适配层尚未
   * 迁移），但返回的 `role` 按 owner 派生，读取方只认 `listMembers`。
   *
   * 存在性检查放在服务层：`group_member` 的外键是防御纵深（绕过用例直接写行时由
   * 数据库兜底），但它的报错是 `FOREIGN KEY constraint failed`，映射不成
   * `NOT_FOUND`。这里先检查，才能给出「组或用户不存在」的稳定错误码。已禁用的
   * 用户可以加入组——成员关系是数据，禁用是登录状态，重新启用后关系自动生效。
   */
  addMember(groupId: string, userId: string, now: Date = new Date()): GroupMember {
    const group = this.#groups.get(groupId);
    if (group === null) {
      throw groupNotFound(groupId);
    }
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    const member = this.#groups.addMember(groupId, userId, 'member', now);
    this.#logger.info('组成员已加入', { groupId, userId });
    return { ...member, role: roleOf(group.ownerUserId, userId) };
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

  /**
   * 组成员列表；组不存在抛 `NOT_FOUND`。
   *
   * `role` 在读取时派生：`userId === group.ownerUserId` 才是 `owner`。`group_member`
   * 上那一列是旧数据，可能写着 `owner`，但那个用户从来没有过 owner 的能力——
   * 用它就是一个对用户撒谎的字段。
   */
  listMembers(groupId: string): readonly GroupMember[] {
    const group = this.#groups.get(groupId);
    if (group === null) {
      throw groupNotFound(groupId);
    }
    return this.#groups
      .listMembers(groupId)
      .map((member) => ({ ...member, role: roleOf(group.ownerUserId, member.userId) }));
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
        // 签名已由 `AuthService` 校验；这里补两件签名管不到的事：账号是不是还是
        // 签发 token 时的那个生命周期（`session_epoch`），以及账号是否还能登录
        // （存在且 active）。空串是迁移遗留的「版本未知」，一律不匹配——不能因为
        // 两边都是空串就放行。
        const current = this.#users.getSessionEpoch(credential.userId);
        if (current === null || current === '' || current !== credential.epoch) {
          throw unauthenticated('Session token 无效或已过期。');
        }
        return this.#contextFor(credential.userId, null);
      }
      default: {
        // `Credential` 加一种凭据时这一行编译失败。缺分支会让 `resolve` 返回
        // `undefined`——调用方拿到一个假身份，而不是 401。
        const exhaustive: never = credential;
        throw new ComemError('INTERNAL', '未知的认证凭据形态。', {
          credential: JSON.stringify(exhaustive) ?? typeof exhaustive,
        });
      }
    }
  }

  /**
   * 用户当前的 session 身份版本（签发 token 用）。用户不存在返回 `null`。
   *
   * 登录成功后由 `AuthService` 把返回值写进 token 载荷；之后每次请求都要与当前值
   * 相等（`resolve` 的 `session` 分支）。空串是「版本未知」的哨兵值（列默认值），
   * 调用方必须当成失败。
   */
  sessionEpochOf(userId: string): string | null {
    return this.#users.getSessionEpoch(userId);
  }

  /**
   * 把「主体字符串」解析成一次请求的身份（回环信任路径，`auth.trustLoopback`）。
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

  /**
   * 给用户设密码（管理端点）。用户不存在抛 `NOT_FOUND`。
   *
   * 同时轮换身份版本（`UserRepository.setPasswordHash`）：改密码的用途之一是让泄露
   * 的凭据立刻失效，已签发的 session token 必须在下一次请求就 401。
   */
  async setPassword(userId: string, password: string, now: Date = new Date()): Promise<void> {
    if (this.#users.get(userId) === null) {
      throw userNotFound(userId);
    }
    const hash = await hashSecret(password);
    this.#users.setPasswordHash(userId, hash, now);
    this.#logger.info('用户密码已设置', { userId });
  }

  /** `app_user.password_hash` 非空。管理面只回布尔，哈希不出服务层。 */
  hasPassword(userId: string): boolean {
    return (this.#users.getPasswordHash(userId) ?? '') !== '';
  }

  /** 签发一把 API Key。明文只返回一次，库里只有哈希与前缀；`name` 区分用途，不是权限范围。 */
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
      principals: [...identity.principals, USER_WILDCARD],
      apiKeyId,
    };
  }
}
