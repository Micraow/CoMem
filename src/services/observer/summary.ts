/**
 * 写盘后的摘要失效投递。
 *
 * ## 为什么用 `markStale` 而不是 `invalidate`
 *
 * 这一步的顺序是「写索引 → 物化权限 → 摘要失效」。等摘要失效被调用时，索引里已经是
 * 新的 `body_digest` 了，`invalidate` 的「正文没变不传播」比较必然相等，整条传播链
 * 会被**静默跳过**——文件写了、目录摘要永远不重算，而且不报错。`markStale` 跳过这个
 * 比较，直接按「内容确实变了」传播。W6 的批量路径踩过同一个坑，见
 * `local/notes/decisions.md`「批量写入的摘要失效必须用 markStale」。
 *
 * ## 为什么延后到锁释放之后
 *
 * `onNodeWritten` / `onNodeRemoved` 是在 `FileSystemService` 的**路径锁里面**被调用的
 * （`write` 持文件的 `EXACT`、`mkdir` / `remove` 持 `TREE`）。摘要生成自己也要拿目录的
 * `EXACT` 锁，而 `TREE` 与同路径 / 祖先路径的 `EXACT` 互斥（§10.6）——同步调用会自己
 * 等自己 5 秒然后 `CONFLICT`。W6 的批量路径也踩过：`ResourceService` / `SkillService`
 * 都是「锁释放后再投递摘要失效」。
 *
 * 所以这里用 `setImmediate` 推到当前宏任务的微任务队列之后（那时 `withLock` 的
 * `finally` 已经释放锁）。任务本身由 `observer.ts` 记进 `#pending`，`drain()` 因此
 * 有一个确定的汇合点。归档 / 抽取 / 合并 / 摘要本来就算**异步阶段**（§17.2），不占
 * 阻塞开销。
 *
 * 失败只记日志：摘要失效是派生数据的后台维护，不能反过来让写操作失败。
 */

import type { Uri } from '../../domain/uri.js';

import { errorMessage } from '../../domain/errors.js';

import type { IndexObserverDeps } from './ports.js';

export type SummaryPorts = Pick<IndexObserverDeps, 'summary' | 'logger'>;

/** 排期一次摘要失效；返回的 Promise 在 `markStale` 完成（或失败被吞掉）后结算。 */
export function markSummaryStale(ports: SummaryPorts, directory: Uri): Promise<void> {
  return new Promise<void>((resolve) => {
    // `setImmediate` 而不是 `queueMicrotask`：`withLock` 的 `finally` 在微任务里
    // 释放锁，微任务会排在它前面。
    setImmediate(resolve);
  })
    .then(() => ports.summary.markStale(directory))
    .then(
      () => undefined,
      (error: unknown) => {
        ports.logger.error('摘要失效投递失败，已忽略。', {
          directory: directory.toString(),
          error: errorMessage(error),
        });
      },
    );
}
