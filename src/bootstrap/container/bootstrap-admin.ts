/**
 * 引导管理员与一次性初始化令牌（架构文档 §12.7 的引导循环）。
 *
 * ## 为什么是 `app_user` 上的一列，不是独立的 `system_setting` 表
 *
 * 标记只回答「这一行是不是引导管理员」，是**用户行**的属性：它随账号一起创建、
 * 一起删除（`ON DELETE CASCADE` 不需要），并且管理面求权时已经拿到了 `app_user.id`。
 * 独立表要引入 `(key, value)` 的读写与「什么时候清理」，却只存一个布尔值；更糟的是
 * 两张表可以在事务外不同步，出现「账号没了、管理员标记还在」的状态。一列
 * `bootstrap_admin INTEGER NOT NULL DEFAULT 0` 没有这个问题，也不会破坏已有数据根
 * （`ADD COLUMN` 给旧行补 0）。
 *
 * ## 为什么 SQL 在装配层
 *
 * `api/` 不能 import `adapters/`（架构文档 §4.2）。仓储方法在
 * `adapters/sqlite/`，这里只做「把几个仓储调用收成一个端口」以及需要跨调用
 * 原子性的那几条 SQL。**写入只有一个入口**：`installFirstAdminOf` 在一个同步写事务
 * 里复查 `needsSetup`、写密码哈希、写标记——三条同时成功或同时回滚，不存在
 * 「密码设了、标记没写」或反过来的崩溃窗口。
 *
 * ## 一次性初始化令牌
 *
 * 回环限制在 Docker 部署里不成立：请求经 nginx 转发后来源是容器网段地址，浏览器
 * 的 `/setup` 页面永远拿不到 200。令牌是第二条授权路径——非回环请求必须同时提供
 * 启动日志里打印的那一串。
 *
 * 令牌**只在内存里**：进程启动时随机生成，`needsSetup` 为 true 时打印一次。重启
 * 换新是正确语义（初始化本来就要求重启才能让 `auth.enabled` 生效），落盘反而会
 * 留下一个比它保护的东西活得更久的凭据。比较用 `timingSafeEqual`，长度不等直接
 * false。
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { withWriteTransaction } from '../../adapters/sqlite/database.js';
import type { BootstrapAccess } from '../../api/http/routes/bootstrap.js';
import type { Logger } from '../../domain/log.js';
import { hashSecret } from '../../services/password.js';

/** 24 字节 → base64url 32 个字符。长度足够对抗在线猜测，又短到能从日志里抄下来。 */
const SETUP_TOKEN_BYTES = 24;

/** 有任意一行设过密码？`needsSetup` 的数据库侧判据。 */
function hasPasswordHashOf(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS found FROM app_user WHERE password_hash IS NOT NULL AND password_hash <> '' LIMIT 1",
    )
    .get();
  return row !== undefined;
}

/** 引导管理员的用户 ID；还没写过标记时返回 `null`。 */
function bootstrapAdminIdOf(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT id FROM app_user WHERE bootstrap_admin = 1 LIMIT 1').get();
  return row === undefined ? null : String(row['id']);
}

export function isBootstrapAdminOf(db: DatabaseSync, userId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM app_user WHERE id = ? AND bootstrap_admin = 1')
    .get(userId);
  return row !== undefined;
}

/**
 * 原子地安装第一个管理员：还没有任何密码哈希时写密码哈希 + 标记。
 *
 * 返回 `false` 表示已有别的行设过密码（或目标用户不存在），调用方映射成
 * `BOOTSTRAP_CLOSED`。**不在这里校验密码强度**：那是路由的职责，且哈希前就要
 * 拒绝弱口令。
 */
function installFirstAdminOf(
  db: DatabaseSync,
  userId: string,
  passwordHash: string,
  now: Date,
): boolean {
  return withWriteTransaction(db, () => {
    if (hasPasswordHashOf(db)) {
      return false;
    }
    // 与 `UserRepository.setPasswordHash` 同一组列：改密码要轮换 `session_epoch`，
    // 让已签发的 token 立刻失效（§12.7）。
    const changed = db
      .prepare(
        'UPDATE app_user SET password_hash = ?, session_epoch = ?, bootstrap_admin = 1, updated_at = ? WHERE id = ?',
      )
      .run(passwordHash, randomUUID(), now.toISOString(), userId).changes;
    return Number(changed) === 1;
  });
}

/** 恒定时间比较；缺失 / 空串 / 长度不等一律 false。 */
function tokenMatches(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) {
    return false;
  }
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(candidate, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * 引导端口。
 *
 * `setupToken` 参数只给单测用：生产路径不传，随机生成。集成测试从启动日志里
 * 解析令牌（那也正是部署者要做的事）。
 */
export function createBootstrapAccess(
  db: DatabaseSync,
  logger: Logger,
  authEnabled: boolean,
  setupToken: string = randomBytes(SETUP_TOKEN_BYTES).toString('base64url'),
): BootstrapAccess {
  // 单用户模式不需要初始化，不打印令牌；多用户模式且还没有密码时才打印。
  if (authEnabled && !hasPasswordHashOf(db)) {
    logger.info(`初始化令牌：${setupToken}（用于首次创建管理员账号；创建完成后失效）`);
  }
  return {
    hasPassword: () => hasPasswordHashOf(db),
    bootstrapAdminId: () => bootstrapAdminIdOf(db),
    installFirstAdmin: async (userId, password) =>
      installFirstAdminOf(db, userId, await hashSecret(password), new Date()),
    verifySetupToken: (candidate) => tokenMatches(setupToken, candidate),
  };
}
