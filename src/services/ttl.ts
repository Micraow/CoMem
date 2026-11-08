/**
 * 记忆的 TTL 与过期清扫（架构文档 §11.7、§8.1 的 `node.expires_at`、§12 的数据布局）。
 *
 * ## 两段式
 *
 * TTL 分两段，中间隔一个「保留期」：
 *
 * 1. **归档**：`node.expires_at < now` → `status = 'archived'`（`sweepExpired` 的
 *    `UPDATE`）。只标不删——TTL 配错（把 7 天写成 7 秒）时归档还能改回来。
 * 2. **物理删除**：归档后超过 `memory.ttl.retentionDays` 天 → 删文件 + 索引行。
 *    这一段重建在 `forget` 的删除路径上（`FileSystemService.remove`：先求 MANAGE、
 *    拿 TREE 锁、删文件、通知观察者删索引），**不另写一套删除逻辑**。
 *
 * 之前只有第一段：`memory.ttl.*` 让使用者以为能省磁盘，实际只剩软归档，archived
 * 行越积越多、磁盘一分没省（`AGENTS.md` §1「配置项必须真的生效」）。第二段才让
 * 「保留期」这个承诺兑现。
 *
 * ## 保留期默认 0 = 永不物理删
 *
 * `retentionDays = 0`（默认）**关闭第二段**：归档就是终点，与旧行为一致。这是保守
 * 选择——物理删除不可逆，默认不能删任何东西。要省磁盘，使用者显式配一个正数保留
 * 期（例如 30），先观察一轮归档量再决定。
 *
 * ## 幂等
 *
 * 两段都可每 30 秒跑一次：第一段 `status <> 'archived'` 让同一条过期记忆只被计数
 * 一次；第二段删掉行以后自然不再命中。
 */

import type { NodeRepository } from '../adapters/sqlite/node-repository.js';
import { Uri } from '../domain/uri.js';
import type { Logger } from '../domain/log.js';
import type { FileSystemService } from './filesystem.js';

export interface TtlServiceDeps {
  readonly nodes: NodeRepository;
  /**
   * 物理删除用。`forget` 走的就是 `FileSystemService.remove`（求 MANAGE、TREE 锁、
   * 删文件、通知观察者更新索引），复用它能保证「定时删」和「手动删」删的是同样的
   * 几样东西（文件 + `node` + `node_fts` + `node_permission` 由观察者一并处理）。
   */
  readonly filesystem: FileSystemService;
  readonly logger: Logger;
  /**
   * 物理删除前求权用的主体集合（物化权限的行按它算 MANAGE）。与 API 请求里的
   * `principals` 同源（`user:{bound}` + 所属组 + `user:*`）。删除是系统动作，但它
   * 仍然走 `FileSystemService` 的 MANAGE 断言——没有主体就删不掉任何东西。
   */
  readonly principals: readonly string[];
  /**
   * `memory.ttl.retentionDays`。归档后间隔多少天物理删除；`0` = 永不物理删除。
   */
  readonly retentionDays: number;
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

/** 一天。保留期按「天」配置，换算成毫秒只此一处。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export class TtlService {
  readonly #nodes: NodeRepository;
  readonly #filesystem: FileSystemService;
  readonly #logger: Logger;
  readonly #principals: readonly string[];
  readonly #retentionDays: number;
  readonly #now: () => Date;

  constructor(deps: TtlServiceDeps) {
    this.#nodes = deps.nodes;
    this.#filesystem = deps.filesystem;
    this.#logger = deps.logger;
    this.#principals = deps.principals;
    this.#retentionDays = deps.retentionDays;
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
   * 清扫：先归档过期节点，再物理删除归档超保留期的节点。
   *
   * 返回两段的计数：`expired`（本轮归档数，保持旧字段名供调度器摘要沿用）、
   * `purged`（本轮物理删除数）。
   *
   * 第二段只在 `retentionDays > 0` 时执行。`retentionDays` 很小时（配小了）记
   * warn——危险操作不该静默删——但不拒跑：配置是使用者的显式意图，日志负责让它
   * 可查（`AGENTS.md` §1「错误必须能定位」）。
   */
  async sweep(
    options: { readonly limit?: number } = {},
  ): Promise<{ readonly expired: number; readonly purged: number }> {
    const limit = options.limit ?? DEFAULT_SWEEP_BATCH_SIZE;
    const now = this.#now();
    const expired = this.#nodes.sweepExpired(now, limit);
    const purged = await this.#purge(now, limit);
    return { expired: expired.length, purged };
  }

  /**
   * 第二段：删掉归档超期的节点。返回实际删掉的条数。
   *
   * 每一条删除都独立 catch：一个文件删失败（磁盘被外部动过、权限问题）不能打断整轮，
   * 记 warn 继续下一条。删成功的记 info。
   */
  async #purge(now: Date, limit: number): Promise<number> {
    if (this.#retentionDays <= 0) {
      return 0;
    }
    const cutoff = new Date(now.getTime() - this.#retentionDays * MILLISECONDS_PER_DAY);
    const candidates = this.#nodes.selectPurgeable(cutoff, limit);
    if (candidates.length === 0) {
      return 0;
    }
    if (this.#retentionDays < 7) {
      // 保留期短到「配错」的边缘：正常使用者不会把归档后 7 天内就删。这条 warning
      // 让「误配成 1 天、一轮删光」在日志里一眼可见，而不是事后翻 deleted 计数才
      // 反应过来。
      this.#logger.warn('TTL 保留期很短，归档记忆将在数天内被物理删除。', {
        retentionDays: this.#retentionDays,
        candidates: candidates.length,
      });
    }

    let purged = 0;
    for (const uri of candidates) {
      try {
        const parsed = Uri.tryParse(uri);
        if (parsed === null) {
          this.#logger.warn('TTL 待删节点的 URI 不合法，已跳过。', { uri });
          continue;
        }
        // 复用 `forget` 的删除路径：MANAGE 求权 → TREE 锁 → 删文件 → 观察者删索引
        // （node / node_fts / node_permission）。文件不存在时 `remove` 返回 0，不抛错。
        await this.#filesystem.remove(parsed, this.#principals);
        purged += 1;
        this.#logger.info('TTL 归档超期，已物理删除。', { uri });
      } catch (error) {
        this.#logger.warn('TTL 物理删除失败，已跳过，下一轮重试。', {
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return purged;
  }
}
