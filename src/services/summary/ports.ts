/**
 * `SummaryService` 的端口与装配契约。
 *
 * 全部由 `bootstrap/` 注入，服务自己只 `import type` 引用适配层（§4.2、§4.4）。
 * 各职责模块在自己的文件里声明它需要的最小端口（结构化子集），本文件只放公开面
 * 需要的那几个类型与「全量端口」`SummaryContext`——装配壳用它把同一个对象交给
 * 生成、失效、落盘三条路径，模块之间因此不必互相知道对方要什么。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { SqliteFtsIndex } from '../../adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../domain/log.js';
import type { FreshnessThresholds, SummaryGenerator } from '../../domain/summary.js';

import type { AclService } from '../acl.js';

/**
 * `services/` 不能 import `node:sqlite`（§4.2，连类型导入都算依赖）。
 *
 * 这里只声明本服务用到的最小形状：新鲜度三列在 `node` 表上，读一行、写一行。
 * `DatabaseSync` 结构上可赋值。与 `AclService` 的 `AclDatabase` 同一做法。
 */
export interface SummaryDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { readonly changes: number | bigint };
  };
}

export interface SummaryServiceConfig {
  /** L0 正文预算（§9.1 的 256 字符，默认 `ABSTRACT_MAX_CHARS`） */
  readonly abstractMaxChars: number;
  /** L1 正文预算（§9.1 的 4000 字符，默认 `OVERVIEW_MAX_CHARS`） */
  readonly overviewMaxChars: number;
  /** §9.3 的两个阈值；省略时用 `DEFAULT_FRESHNESS_THRESHOLDS`（同一份默认值） */
  readonly freshness?: FreshnessThresholds;
}

export interface SummaryServiceDeps {
  readonly nodes: NodeRepository;
  readonly index: SqliteFtsIndex;
  readonly metadata: MetadataFileStore;
  readonly store: ContentStore;
  /**
   * 新鲜度列在 `node` 表上，本服务直接读写它（见 `SummaryDatabase`）。
   *
   * 为什么不让 `NodeRepository` 代劳：`services/` 只能 `import type` 引用适配层，
   * 而 `NodeRepository` 没有暴露新鲜度方法，也不应该为一个服务加四个转发方法。
   */
  readonly db: SummaryDatabase;
  readonly generator: SummaryGenerator;
  readonly logger: Logger;
  readonly config: SummaryServiceConfig;
  /**
   * 写摘要之后的权限物化（§12.4 的「写时算」）。
   *
   * 归档子树（`history/`、`archive_NNN/`）是 `SessionService` 直接写 `ContentStore`
   * 建出来的，观察者收不到通知；摘要生成是这条链上唯一的写后钩子。只取
   * `materializeNode` 一个方法，与 `ArchiveSummaryStep` 取 `Pick<SummaryService, ...>`
   * 同一取舍：不需要整个 `AclService` 的测试不该造一个。
   */
  readonly acl: Pick<AclService, 'materializeNode'>;
  /** 每个目录一把 EXACT 锁；省略时不加锁（见文件头「并发」）。 */
  readonly locks?: PathLockManager;
}

/**
 * 装配壳交给各职责模块的端口集合。
 *
 * `thresholds` 是 `config.freshness ?? DEFAULT_FRESHNESS_THRESHOLDS` 的解析结果：
 * 构造时解析一次，判定函数只拿解析后的值，不在每次失效里重算默认值。
 */
export interface SummaryContext extends SummaryServiceDeps {
  readonly thresholds: FreshnessThresholds;
  /** 装配入参里可选，交给模块时写成显式的「有或没有」。 */
  readonly locks: PathLockManager | undefined;
}

export interface InvalidationResult {
  /** 真正重算了摘要的目录，自底向上 */
  readonly recomputed: readonly string[];
  /** 只记了脏、等下次的目录 */
  readonly markedStale: readonly string[];
  /** 到达 scope 根停止 */
  readonly stoppedAt: string;
}
