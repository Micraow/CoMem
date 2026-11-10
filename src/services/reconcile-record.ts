/**
 * 「文件已经落盘、派生数据没写成」时留一条对账记录（架构文档 §10.6「索引双写补偿」）。
 *
 * 全仓有五处会走到这个形态：
 *
 * 1. `ResourceService` 的批量 `index.upsert` 与逐文件落盘；
 * 2. `SkillService` 的批量 `index.upsert`；
 * 3. `IndexObserver` 的单节点 `index.upsert`——记忆文件的字节写、会话消息落盘、
 *    以及 `FileSystemService` 的 `write` / `mkdir` 都从这里进；
 * 4. `IndexObserver` 移动后的批量 `index.upsert`（记的是**目标** URI）；
 * 5. 三条写路径的权限物化失败（`op: 'permission'`）。
 *
 * 记录形状只有一种：`{op, uri, error, at}`，一行一个 URI。重放器按 `op` + URI 重做，
 * 形状漂移就是重放做错事，所以留记录只走这一份实现。
 *
 * ## 为什么写日志失败只记 error
 *
 * 对账记录是**补偿线索**，不是真相（文件才是，§7）。写线索失败时如果往上抛，一次
 * 索引故障会被放大成「写操作本身失败」——调用方以为内容没写进去，实际已经落盘。
 *
 * ## 为什么一条 URI 一行，而不是一条批量记录
 *
 * 重放器逐条重建索引记录（`ReconcileService.replay`），批里有一条已经不在磁盘上时
 * 也只该把它自己移出日志。一条记录带多个 URI 会让「部分解决」无法表达。
 *
 * ## 为什么 `op` 是字符串而不是联合类型
 *
 * 日志里会出现 `write` / `attachment` 这类不可重放的记录（由调用方写，重放器保留
 * 待人工处理）。类型收窄在这里没有收益：写侧不判断能否重放，读侧用
 * `replayableOpOf` 判。
 *
 * ## 为什么不放在 `services/reconcile.ts`
 *
 * 那个模块 `import { skillIndexRecord } from './skill.js'`（重放技能行要用写路径的
 * 同一份构造），而 `SkillService` 需要这里的函数。放进 `reconcile.ts` 会形成
 * `reconcile ⇄ skill` 的循环依赖；拆成独立模块后依赖方向仍然只有「→ domain」。
 */

import { errorMessage } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { ReconcileEntry } from '../domain/reconcile.js';

/**
 * 写侧需要的唯一能力。具体实现是 `adapters/fs/reconcile-log.ts` 的 `ReconcileLog`，
 * 由 bootstrap 注入；services 不能直接 import `node:fs`（§4.2）。
 */
export interface ReconcileLogAppender {
  append(entry: ReconcileEntry): Promise<void>;
}

/**
 * 追加一条对账记录。**不抛错**（见文件头）。
 *
 * `at` 由调用方在失败那一刻取一次；同一批共用同一个时间戳，不会把一件事拆成多条。
 */
export async function recordReconcileFailure(
  log: ReconcileLogAppender,
  logger: Logger,
  op: string,
  uri: string,
  error: string,
  at: string,
): Promise<void> {
  try {
    await log.append({ op, uri, error, at });
  } catch (appendError) {
    logger.error('对账日志写入失败，已忽略。', {
      op,
      uri,
      error: errorMessage(appendError),
    });
  }
}

/**
 * 索引写失败：一条 URI 一行。
 *
 * 每条各自 try/catch（在 `recordReconcileFailure` 里）：一条追加失败不能让同批其余
 * URI 的线索一起消失。
 */
export async function recordIndexFailures(
  log: ReconcileLogAppender,
  logger: Logger,
  uris: readonly string[],
  error: string,
  at: string,
): Promise<void> {
  for (const uri of uris) {
    await recordReconcileFailure(log, logger, 'index', uri, error, at);
  }
}

/**
 * 权限物化失败：记成 `op: 'permission'`，重放器用 `AclService.materializeNode(uri)`
 * 重算。`uri` 必须是**磁盘上仍然存在**的节点（删掉的目标会被重放器按「已不存在」
 * 移出日志），所以删除路径记录的是父目录。
 */
export async function recordPermissionFailure(
  log: ReconcileLogAppender,
  logger: Logger,
  uri: string,
  error: string,
  at: string,
): Promise<void> {
  await recordReconcileFailure(log, logger, 'permission', uri, error, at);
}
