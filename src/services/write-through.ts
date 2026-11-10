/**
 * 写完之后顺手要做的两件事（架构文档 §10.6、§12.4）。
 *
 * `ResourceService` 与 `SkillService` 都绕开 `FileSystemService` 直接写
 * `ContentStore`，所以两条链路各自补三步：批量写 → 一次 `index.upsert` → 摘要失效
 * + 权限物化。前两步的输入不同（一个要处理附件与文本规范化，一个只写字节），后两步
 * 的规则完全相同，共用这一份实现。
 *
 * ## 摘要失效为什么只能 `markStale`
 *
 * 批量路径的顺序是「写文件 → 批量 `index.upsert` → 标脏」。等标脏被调用时索引里
 * 已经是新 digest，`invalidate` 的正文比较必然相等，整条传播链被静默跳过——文件
 * 写了、目录摘要永远停在旧内容，不报错也不失败。`invalidate` 还从节点的**父目录**
 * 开始传播，把它当成参数时目标目录连一次判定都拿不到，症状因此更彻底：目录摘要
 * 根本不生成。规则固定在本文件里，调用方没有换成 `invalidate` 的入口。
 *
 * ## 物化权限为什么不能只算写出来的 URI
 *
 * 写 `docs/api/spec.md`（或 `scripts/check.sh`）会顺手建出中间目录。这些目录没有
 * `node_permission` 行时，`list` / `tree` / `listSkills` 的纯 SQL 过滤会让它们整个
 * 消失——写成功了，树里却什么都没有。`assert` 走 `InheritingAuthorizer` 的写路径，
 * 先在物化表缺行时 `materializeNode` 再求权；逐级物化是幂等的，去重之后只多出
 * 「目录数」条 UPSERT。
 */

import { WRITE_LEVEL } from '../domain/acl.js';
import { errorMessage } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import type { SummaryService } from './summary.js';

export interface ParentSummaryDeps {
  readonly summary: Pick<SummaryService, 'markStale'>;
  readonly logger: Logger;
}

/**
 * 写完之后标记**直接父目录**的摘要失效。
 *
 * 去重口径是直接父目录：批量导入 100 个文件落在 10 个目录时只标 10 次。再往上的
 * 祖先链由 `SummaryService.markStale` 自己按 §9.3 传播，这里不展开——在批量路径里
 * 预先算全部祖先会造出第二套传播规则。
 *
 * 必须在目录的 `TREE` 锁释放之后调：`SummaryService` 会拿目标目录的 `EXACT` 锁，
 * 与祖先 `TREE` 锁互斥，锁内调用会等到 `CONFLICT`（§10.6「提交后统一投递」）。
 */
export async function invalidateParentSummaries(
  deps: ParentSummaryDeps,
  written: readonly Uri[],
): Promise<void> {
  const directories = new Map<string, Uri>();
  for (const uri of written) {
    const parent = uri.parent();
    if (parent === null) {
      continue;
    }
    const key = parent.toString();
    if (!directories.has(key)) {
      directories.set(key, parent);
    }
  }

  for (const [directory, directoryUri] of directories) {
    try {
      await deps.summary.markStale(directoryUri);
    } catch (error) {
      deps.logger.error('摘要失效投递失败，已忽略。', {
        directory,
        error: errorMessage(error),
      });
    }
  }
}

export interface AncestorPermissionDeps {
  readonly authorizer: Authorizer;
  readonly logger: Logger;
  /** 错误日志的主语：「资源节点」/「技能节点」。 */
  readonly nodeLabel: string;
  /**
   * 物化失败之后的额外处理。`ResourceService` 与 `SkillService` 都用它往
   * `_meta/reconcile.log` 追加一条 `permission` 记录（§10.6「索引双写补偿」）；
   * 省略时只记日志。
   */
  readonly onFailure?: (uri: string, reason: string) => Promise<void>;
}

/**
 * 为写出来的节点及其全部祖先物化权限（§12.4「写时算」）。
 *
 * 从 URI 自己开始逐级向上收集到根，同一祖先只收一次。失败只记日志 + （可选的）
 * 对账记录，并继续处理剩余 URI：文件已经落盘，回滚反而丢数据（§7 的同一原则）。
 */
export async function materializeAncestorPermissions(
  deps: AncestorPermissionDeps,
  uris: readonly Uri[],
  principals: readonly string[],
): Promise<void> {
  const nodes = new Map<string, Uri>();
  for (const uri of uris) {
    let current: Uri | null = uri;
    while (current !== null) {
      const key = current.toString();
      if (nodes.has(key)) {
        // 祖先链已经收过，再往上都是重复。
        break;
      }
      nodes.set(key, current);
      current = current.parent();
    }
  }

  for (const [key, uri] of nodes) {
    try {
      await deps.authorizer.assert(uri, WRITE_LEVEL, principals);
    } catch (error) {
      const reason = errorMessage(error);
      deps.logger.error(`${deps.nodeLabel}权限物化失败，已忽略。`, { uri: key, reason });
      if (deps.onFailure !== undefined) {
        await deps.onFailure(key, reason);
      }
    }
  }
}
