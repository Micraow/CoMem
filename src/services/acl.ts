/**
 * ACL 服务（架构文档 §8.2、§12）。
 *
 * 这一层是「授权管理与鉴权入口」：`FileSystemService` / `SearchService` 通过
 * `Authorizer` 端口调它，控制台的 ACL 页通过管理面调它。求值规则全部在
 * `domain/acl.ts`，这里只负责三件事：把 URI 链从磁盘读出来、把结果物化进
 * `node_permission`、把查询折成一条 SQL。
 *
 * ## 链式求值，物化表是缓存
 *
 * `effective(N)` 递归到 parent，**不预存继承快照**（§12.3）——存了必然在祖先变更
 * 后过期。`setAcl` 时把整棵子树重算一遍写进 `node_permission`，之后
 * `check` / `filterReadable` 只查表（§8.2 的代价转移：ACL 改动低频，读高频）。
 *
 * ## deny 也要物化
 *
 * `node_permission` 带 `effect` 列。被 deny 清空的主体没有 allow 行，但必须有一条
 * deny 行：否则查询主体集合里的 `user:*` 通配会把该主体放进来，跨用户越权。
 * 只对**具体主体**写 deny 行——`user:*` 自己不是「被拒绝的人」，给它写 deny 会
 * 把所有人都挡掉。
 *
 * 判定规则：主体的有效权限为空、且链上有命中它的 deny 条目时写 deny 行。
 * 「链上有 allow」本身不够——`restricted` 切断继承同样产生空集，那不是拒绝，
 * 给被切断的主体写 deny 会顺带压掉同一请求里其它主体的合法 allow。
 *
 * 物化行由 `./acl/materialize.ts` 的 `materializePermissions` 这个纯函数产出。
 * 这段逻辑更适合放 `domain/acl.ts`（与 `effectiveAcl` 同源），但本 wave 不改
 * domain，先留在服务层。
 *
 * ## 写文件的顺序
 *
 * `setAcl` 先写 `.acl.json`（真相），再在一个事务里重算 `node_permission` 与
 * `acl_entry`（缓存）。两个原因：
 *
 * 1. 架构文档 §7 的通用规则是「先写内容再更新索引；索引失败时标记为待重建」。
 *    索引是派生数据，永远可以从文件重建；反过来不成立。
 * 2. 失败方向。文件写失败时事务根本不会开始，缓存保持旧值，不会出现「缓存宣称
 *    一个磁盘上没有的授权」。
 *
 * **崩溃窗口**：文件 `rename` 成功之后、`COMMIT` 之前进程挂掉，磁盘上是新 ACL，
 * 物化表是旧 ACL。下次启动的重建/对账以 `.acl.json` 为真相重算整棵子树即可修复
 * （§6.5「删库可重建」）。窗口内 `check` 可能按旧权限放行或拦截，这是文件与
 * SQLite 之间没有跨介质事务的必然代价。
 *
 * ## 为什么事务不调用 `withWriteTransaction`
 *
 * 那是 `adapters/sqlite/database.ts` 的**值**导出，而 `services/` 只允许
 * `import type` 引用适配层（§4.2）。这里用最小结构端口 `AclDatabase` 自己开
 * `BEGIN IMMEDIATE`，`PermissionRepository` 的两个写入方法检测到外层已有事务会
 * 直接复用，所以两步仍是一个事务。
 *
 * ## 并发：ACL 写入的锁契约（§10.6）
 *
 * 每个写方法都是「读整个 `.acl.json` → 改 → 写回」。读在锁外时两个并发写者各拿
 * 一份旧条目，后写者整份覆盖，先写者的条目**静默消失**：丢 `allow` 是拒绝服务，
 * 丢 `deny` 是越权。所以互斥必须覆盖读与写两步，不能只包写盘。
 *
 * | 方法 | 锁 | 为什么是这个粒度 |
 * |---|---|---|
 * | `setAcl` / `ensureRootPreset` / `setGroupOwner` | `exact(uri)` | 互斥资源是**单个** `.acl.json` 文件；同目录的其它写入与它无关 |
 * | `purgeSubtree` | `tree(root)` | 清空是「扫子树 → 改每个文件」，只锁单文件会在扫描与写入之间漏掉新建目录（残留授权） |
 * | `purgePrincipal` | 全部目标 `exact`，**按 URI 升序** | 撤权横跨整库，没有单一路径能覆盖；多锁必须定序（见下） |
 *
 * **锁序规则（多锁时）**：按 `Uri.toString()` 字典序升序获取，释放顺序相反。
 * `FileSystemService.move` 用同一条规则（两个方向相反的 `move` 不会互等）。任何
 * 新增的多锁路径都必须沿用这条全局顺序，否则两个持有者各拿一把等另一把。
 *
 * **不能嵌套**：`PathLockManager` 不可重入（`adapters/fs/lock.ts` 按锁路径排队，
 * 持有者再拿同路径的锁会等自己，5 秒后 `CONFLICT`）。所以 `purgeSubtree` 持
 * `tree(root)` 期间**直接写文件**，不调 `setAcl`——后者要 `exact(descendant)`，
 * 与祖先的 `tree` 冲突，会等一个永远不会释放的锁。`writeAcl`（`./acl/write.ts`）
 * 因此要求调用方已经持有 `exact(uri)`。
 *
 * **不加锁的两个方法**：`getAcl` 只读（`.acl.json` 是原子 `rename`，读到的要么是
 * 旧的完整内容要么是新的）；`materializeNode` / `syncEntriesFromFile` 只写派生表，
 * 而且由 `IndexObserver` 在 `FileSystemService` 已持有 `exact` / `tree` 的回调里
 * 调用——这里再加锁就是上面那条「自己等自己」。

 * ## 拆分后的模块（本文件只是门面，导出面与原实现一致）
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `./acl/service.ts` | 编排：`AclService` 的公开方法、端口组装、单节点求权 |
 * | `./acl/snapshot.ts` | 快照读取：根 → 目标的链、按目录缓存 |
 * | `./acl/evaluate.ts` | 纯求值：owner、主体集合、代表级别、deny 判定 |
 * | `./acl/materialize.ts` | 物化：单节点 / 子树重算 |
 * | `./acl/write.ts` | `.acl.json` 写入与校验、撤权回滚、反查表重建 |
 * | `./acl/preset.ts` | 命名空间预置：根预置、组 owner 变更 |
 * | `./acl/purge.ts` | 清空子树授权、撤销共用的目录扫描 |
 * | `./acl/revoke.ts` | 按主体撤权（删账号） |
 * | `./acl/principals.ts` | 主体展开 |
 * | `./acl/transaction.ts` | `BEGIN IMMEDIATE` 端口事务 |
 * | `./acl/levels.ts` | 磁盘级别名 ↔ 领域级别 |
 * | `./acl/types.ts` | 端口与对外类型 |
 */

export { AclService } from './acl/service.js';
export type {
  AclDatabase,
  AclInput,
  AclServiceOptions,
  AclSnapshot,
  AclState,
} from './acl/types.js';
