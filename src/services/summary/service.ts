/**
 * 摘要服务的装配壳：把注入的端口交给各职责模块。
 *
 * 方法体全部是「取端口 → 调一个模块函数」。逻辑分别在 `generators.ts`（L0 / L1 的
 * 模型调用与降级）、`generation.ts`（L1 输入拼装）、`invalidate.ts`（失效判定与
 * 向上传播）、`persist.ts`（写盘与索引两行）、`freshness.ts`（新鲜度三列）里；
 * 本类只守住公开面与端口（`../summary.ts` 的导出面与原实现一致）。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { SqliteFtsIndex } from '../../adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../domain/log.js';
import {
  DEFAULT_FRESHNESS_THRESHOLDS,
  type DirectorySummary,
  type FreshnessThresholds,
  type SummaryGenerator,
} from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import type { AclService } from '../acl.js';

import { readFreshness } from './freshness.js';
import { summarize } from './generation.js';
import { invalidateNode, propagateFrom } from './invalidate.js';
import { persistSummary, withDirectoryLock } from './persist.js';
import type {
  InvalidationResult,
  SummaryContext,
  SummaryServiceConfig,
  SummaryServiceDeps,
} from './ports.js';

export class SummaryService {
  readonly #nodes: NodeRepository;
  readonly #index: SqliteFtsIndex;
  readonly #metadata: MetadataFileStore;
  readonly #store: ContentStore;
  readonly #db: SummaryContext['db'];
  readonly #generator: SummaryGenerator;
  readonly #logger: Logger;
  readonly #config: SummaryServiceConfig;
  readonly #thresholds: FreshnessThresholds;
  readonly #acl: Pick<AclService, 'materializeNode'>;
  readonly #locks: PathLockManager | undefined;

  constructor(deps: SummaryServiceDeps) {
    this.#nodes = deps.nodes;
    this.#index = deps.index;
    this.#metadata = deps.metadata;
    this.#store = deps.store;
    this.#db = deps.db;
    this.#generator = deps.generator;
    this.#logger = deps.logger;
    this.#config = deps.config;
    this.#thresholds = deps.config.freshness ?? DEFAULT_FRESHNESS_THRESHOLDS;
    this.#acl = deps.acl;
    this.#locks = deps.locks;
  }

  /**
   * 自底向上重建一棵子树的摘要（§9.2）。
   *
   * 返回**真正重算的目录**，按重算顺序（最深的在前，`rootUri` 最后）。不看新鲜度：
   * 调用方要的是「重建」，跳过「看起来还新」的目录只会让显式重建变成空操作。
   */
  async regenerate(rootUri: Uri): Promise<readonly string[]> {
    const ports = this.#context();
    const recomputed: string[] = [];

    const visit = async (directoryUri: Uri): Promise<void> => {
      const entries = await this.#store.list(directoryUri);
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          await visit(entry.uri);
        }
      }
      // 慢操作（模型调用）在锁外生成，只在写回时持锁（§10.6「锁内不得跨越慢操作」）。
      // 快照在生成**之前**读：写回时 `pending = max(pending - 快照, 0)`，生成期间到达
      // 的改动留在计数里（`consumeChanges`）。
      const snapshot = readFreshness(ports.db, directoryUri.toString()).pendingChanges;
      const summary = await summarize(ports, directoryUri);
      await withDirectoryLock(ports.locks, directoryUri, () =>
        persistSummary(ports, directoryUri, summary, snapshot, null),
      );
      recomputed.push(directoryUri.toString());
    };

    await visit(rootUri);

    this.#logger.info('子树摘要已重建', {
      root: rootUri.toString(),
      recomputed: recomputed.length,
    });
    return recomputed;
  }

  /**
   * 写节点之后的失效传播（§9.3）。
   *
   * `nodeUri` 是被写入 / 删除 / 移动的节点。五步见文件头；两条提前返回的路径都要
   * 有测试：正文没变（第 2 步）与「只记脏」（第 4 步的 else 分支）。
   */
  async invalidate(nodeUri: Uri): Promise<InvalidationResult> {
    return invalidateNode(this.#context(), nodeUri);
  }

  /**
   * 只标脏，跳过「正文 digest 是否变化」的比较。
   *
   * **批量写入必须用它，不能调 `invalidate`。** `add_resource` 的顺序是「写文件 →
   * 批量 `index.upsert` → 标脏」：等标脏被调用时索引里已经是新 digest 了，比较必然
   * 相等，整条传播链会被静默跳过。结果是文件写了、目录摘要永远不重算，而测试只数
   * 调用次数，看不出来。
   *
   * 调用方在**知道内容确实变了**时用它——批量导入就是这种情况：它刚写完这批文件。
   *
   * `directoryUri` 是要标脏的目录本身（不是被写的文件），因为它没有文件可供比较。
   */
  async markStale(directoryUri: Uri): Promise<InvalidationResult> {
    return propagateFrom(this.#context(), directoryUri, directoryUri);
  }

  /**
   * 读目录摘要（不管新鲜度），给 `getAcl` 之类的只读面用。
   *
   * 两个文件缺任一就没有完整摘要，返回 `null` —— 「摘要都不全」比「只有半份摘要」
   * 更接近调用方想要的语义（重建索引、显示「暂无摘要」）。
   *
   * `degraded` 从 `SummaryFileContent.generation` 回填——断网时走规则摘要，模型看到的
   * 概览质量会明显下降，这个标记是它判断「要不要重试」的依据（§9.2）。
   */
  async read(directoryUri: Uri): Promise<DirectorySummary | null> {
    const content = await this.#metadata.readSummary(directoryUri);
    if (!content.complete) {
      return null;
    }
    return {
      abstract: content.abstract,
      overview: content.overview,
      // 没有生成信息（手工写的摘要文件、从未生成过）按「未降级」处理：`degraded`
      // 的语义是「这次生成走了规则摘要」，来源未知不等于降级。
      degraded: content.generation?.degraded ?? false,
    };
  }

  /** 状态留在类里，模块只拿显式端口（见 `ports.ts` 的 `SummaryContext`）。 */
  #context(): SummaryContext {
    return {
      nodes: this.#nodes,
      index: this.#index,
      metadata: this.#metadata,
      store: this.#store,
      db: this.#db,
      generator: this.#generator,
      logger: this.#logger,
      config: this.#config,
      thresholds: this.#thresholds,
      acl: this.#acl,
      locks: this.#locks,
    };
  }
}
