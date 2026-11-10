/**
 * 对账日志的条目与重放分类（架构文档 §10.6「索引双写补偿」）。
 *
 * `_meta/reconcile.log` 一行一个 JSON 对象。这里只放不碰 IO 的形状与判定：适配层
 * 负责读写文件，服务层负责按 `op` 重做。把「哪些操作可以只凭 URI 重放」放在
 * domain，是因为它是一条纯规则，坏记录与未知 `op` 的边界可以在单元测试里穷举。
 *
 * ## 只有 index / permission 可重放
 *
 * `write` 与 `attachment` 也会进日志，但它们的记录里只有**相对路径**，没有可以
 * 重新落盘的正文或原始字节——重放需要调用方重新提交素材。把它们归为「不可重放」
 * 而不是猜一个空内容写回去：后者会把一次失败变成一条空文件。
 */

import { isRecord } from './guards.js';

/** `_meta/reconcile.log` 的一行。 */
export interface ReconcileEntry {
  readonly op: string;
  readonly uri: string;
  readonly error: string;
  /** ISO 8601 */
  readonly at: string;
}

/** 只凭 URI 就能重做的操作。 */
export type ReplayableReconcileOp = 'index' | 'permission';

/** 损坏的行：解析失败的原始行号（从 1 开始）与原因。 */
export interface CorruptReconcileLine {
  readonly line: number;
  readonly reason: string;
}

/** 一次读取的结果。损坏行不参与重放，由调用方记 warn。 */
export interface ReconcileLogSnapshot {
  readonly entries: readonly ReconcileEntry[];
  readonly corrupt: readonly CorruptReconcileLine[];
}

/**
 * 解析一个已经 `JSON.parse` 过的值。
 *
 * 字段缺失或类型不对返回 `null`。不校验 `at` 是否是合法时间：重放只看 `op` 与
 * `uri`，一个时间串写坏不影响「这条失败还能不能修」，把它判成坏记录反而会让
 * 唯一可用的恢复线索消失。
 */
export function parseReconcileEntry(value: unknown): ReconcileEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const op = value['op'];
  const uri = value['uri'];
  const error = value['error'];
  const at = value['at'];
  if (
    typeof op !== 'string' ||
    op === '' ||
    typeof uri !== 'string' ||
    uri === '' ||
    typeof error !== 'string' ||
    typeof at !== 'string'
  ) {
    return null;
  }
  return { op, uri, error, at };
}

/** 可重放的 `op`；其它值（含 `write` / `attachment`）返回 `null`。 */
export function replayableOpOf(entry: ReconcileEntry): ReplayableReconcileOp | null {
  return entry.op === 'index' || entry.op === 'permission' ? entry.op : null;
}

/**
 * 已解决条目的身份。重写日志时用它把成功重放的行从**最新一次读取**里摘掉，
 * 这样重放期间追加进来的新行不会被覆盖。
 *
 * `at` 是 ISO 8601 毫秒精度，同一条 URI 的同一操作在同一毫秒内重复失败才会撞键。
 * 撞键的两行是同一件事，一起去掉不影响语义。
 */
export function reconcileEntryKey(entry: ReconcileEntry): string {
  return `${entry.op}\u0000${entry.uri}\u0000${entry.at}`;
}
