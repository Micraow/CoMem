/**
 * 记忆的 TTL 与过期清扫（架构文档 §11.7、§8.1 的 `node.expires_at`、§12 的数据布局）。
 *
 * ## 为什么要在服务层建一层
 *
 * 过期时间是 `node` 表的一列（`0010_ttl.sql`），读写它的是 `NodeRepository`。这一层
 * 不加判断、不复制 SQL，只做两件仓储不做的事：**把「天」换成绝对时刻**、**给每次
 * 清扫一个上界并打日志**。没有它，`memory.ttl.*` 会变成「配置项存在但没人读」的
 * 又一个例子——`AGENTS.md` §1 明确说这比没有更糟。
 *
 * ## 软过期
 *
 * 清扫只把 `status` 标成 `archived`，**不删文件**。理由不是「以后再做」：TTL 配错
 * （把 7 天写成 7 秒）时，归档状态还能改回来，物理删除没有回滚。物理删除是运维的
 * 显式动作（`forget` / `rm`），不是定时任务的默认行为。
 *
 * 归档只影响检索（`status = 'active'` 过滤），`read` / `download` 按路径仍然拿得到
 * 内容，`node_permission` 也不动——「这条记忆归档了」是内容状态，不是「这个人失去了
 * 访问权」。
 *
 * ## 幂等
 *
 * `sweep` 可以每 30 秒跑一次：`sweepExpired` 的 `WHERE status <> 'archived'` 让同一条
 * 过期记忆只被计数一次。重复调用返回 0，不会把「已经归档」重复写一遍。
 */

import type { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { Logger } from '../domain/log.js';

export interface TtlServiceDeps {
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  /** 注入时钟（测试用）；默认 `() => new Date()`。清扫的「现在」由它决定。 */
  readonly now?: () => Date;
}

/**
 * 每轮最多清扫多少条。来源：`memory.ttl.sweepBatchSize` 的默认值（架构文档 §18）。
 *
 * 100 是经验值：一条帖子级部署的记忆量在千条量级，100 条一次 UPDATE 是毫秒级；
 * 而「一次清完整表」会在写锁上停几秒，把并发请求卡到 `busy_timeout`（§18 的 5 秒）
 * 之外。来源不明的部分：没有实测「多少条会撞上 busy_timeout」，取 100 是保守下界。
 */
const DEFAULT_SWEEP_BATCH_SIZE = 100;

export class TtlService {
  readonly #nodes: NodeRepository;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(deps: TtlServiceDeps) {
    this.#nodes = deps.nodes;
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 给一批 URI 设过期时间。`null` 表示永不过期。
   *
   * 返回实际改到的行数：不存在的 URI（索引与磁盘不同步、刚被删掉）静默跳过，不抛错
   * ——为一条正常的竞态让整批设置失败，调用方还得自己拆开重试。
   */
  async setExpiry(uris: readonly string[], expiresAt: Date | null): Promise<number> {
    if (uris.length === 0) {
      return 0;
    }
    const updated = this.#nodes.setExpiry(uris, expiresAt);
    this.#logger.info('记忆过期时间已设置。', {
      requested: uris.length,
      updated,
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    });
    return updated;
  }

  /**
   * 清扫已过期的节点（`expires_at < now`）。
   *
   * 走 `idx_node_expires`（`0010_ttl.sql` 的部分索引）：默认配置（`defaultDays = 0`）
   * 下索引是空的，查询不扫描全表。
   */
  async sweep(options: { readonly limit?: number } = {}): Promise<{ readonly expired: number }> {
    const limit = options.limit ?? DEFAULT_SWEEP_BATCH_SIZE;
    const expired = this.#nodes.sweepExpired(this.#now(), limit);
    return { expired: expired.length };
  }
}
