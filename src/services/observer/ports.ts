/**
 * 观察者的对外依赖契约。
 *
 * `IndexObserverDeps` 放在这里而不是 `observer.ts`，是为了让各实现模块用
 * `Pick<IndexObserverDeps, ...>` 声明自己的端口，而不必 import 类模块——类模块反过来
 * import 这些实现，放在一起会形成类型依赖的环。
 *
 * 观察者自身没有共用实现：失败路径分布在写行、权限物化、摘要排期与嵌入批次里，
 * 但错误文本统一取 `domain/errors.ts` 的 `errorMessage`。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { EmbeddingRepository } from '../../adapters/sqlite/embedding-repository.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import type { Logger } from '../../domain/log.js';
import type { RetrievalIndex } from '../../domain/retrieval.js';

import type { AclService } from '../acl.js';
import type { EmbeddingService } from '../embedding.js';
import type { ReconcileLogAppender } from '../reconcile-record.js';
import type { SummaryService } from '../summary.js';

export interface IndexObserverDeps {
  readonly store: ContentStore;
  readonly index: RetrievalIndex;
  readonly acl: AclService;
  readonly summary: SummaryService;
  readonly nodes: NodeRepository;
  /**
   * 删除时清掉子树的物化权限行。
   *
   * 任务草图里没有这一项，但 `AclService.materializeNode(parent)` 只重写父节点自己的
   * 行（`PermissionRepository.replaceNode`），被删节点的 `node_permission` 行会留下来
   * ——那张表没有指向 `node` 的外键级联。删一行权限要靠 `deleteSubtree`。
   */
  readonly permissions: Pick<PermissionRepository, 'deleteSubtree'>;
  readonly logger: Logger;
  /**
   * 写失败时追加对账记录（`op: 'index'` / `op: 'permission'`，§10.6）。
   *
   * 必填：内容写路径（`FileSystemService` 的 `write` / `mkdir`、`MemoryService`
   * 的字节写、会话消息落盘）全部经过这里。不注入时失败就只剩一行日志，
   * 「文件在、检索不到」永远不会自愈——那正是这个依赖要修掉的形态。生产装配注入
   * `adapters/fs/reconcile-log.ts` 的实例，与重放器是同一个对象。
   */
  readonly reconcile: ReconcileLogAppender;
  /**
   * 嵌入服务（§8.1 的 `node_embedding`、§17.2 的异步阶段）。
   *
   * 可选是给「只关心检索索引」的调用方（存量测试、只读脚本）留的：不注入就
   * 完全不产生嵌入调用，而不是每次写入都打一次必定降级的网络。生产装配
   * （`bootstrap/container.ts`）总是注入。
   *
   * `maxBatchSize` 与 `available` 是批量排期要用的：前者决定队列怎么切片，后者让
   * 「供应商整体不可用」时不再二分重试（切分只会放大请求数）。
   */
  readonly embedding?: Pick<EmbeddingService, 'embed' | 'model' | 'maxBatchSize' | 'available'>;
  /**
   * 向量仓储。与 `embedding` 成对出现；只注入一个时嵌入阶段整体跳过。
   *
   * 生产装配只在 `providers.embedding.type !== 'disabled'` 时注入：默认配置下
   * `node_embedding` 表根本没有建（`ensureSchema` 也不会跑），注入一个删不掉的
   * 仓储只会让每次删除都记一条 `no such table`。
   */
  readonly embeddings?: EmbeddingRepository;
}
