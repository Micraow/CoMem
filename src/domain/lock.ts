/**
 * 路径锁的纯规则（架构文档 §10.6）。
 *
 * 这一层只回答「两个锁是否互斥」「过期的锁能不能抢」「现在该不该续租」，
 * 不碰文件系统。锁文件怎么读、怎么建、怎么删在 `adapters/fs/lock.ts`。
 *
 * 为什么需要两种模式（§10.6）：`rm -r resources/foo` 要保证「删索引 → 删文件」
 * 期间没有人往 `foo/` 里写。只锁 `foo` 自身挡不住写 `foo/bar.md` 的人，所以
 * `TREE` 锁把整棵子树都算进来。
 *
 * 路径比较必须按**段边界**：`comem://user/alice/foo` 不是
 * `comem://user/alice/foobar` 的祖先。字符串前缀会把两者判成祖先关系，
 * 于是两个无关文件互相阻塞——正确性没坏，但并发度白丢。用 `Uri.isAncestorOf`。
 */

import { MILLISECONDS_PER_SECOND } from './time.js';
import { Uri } from './uri.js';

export type LockMode = 'exact' | 'tree';

/**
 * 锁文件的 JSON 内容（§10.6）。
 *
 * `uri` 存字符串而不是 `Uri`：它是落盘的 JSON，读回来要重新校验形态，
 * 直接存值对象会让「磁盘上被改坏」变成类型系统看不见的运行时问题。
 */
export interface LockRecord {
  /** 持有者标识，释放时校验——不是自己拿的锁不能释放 */
  readonly owner: string;
  readonly mode: LockMode;
  /** 被锁的 URI 字符串 */
  readonly uri: string;
  /** 租约到期时间，ISO 8601 */
  readonly expiresAt: string;
  /** 上次续租时间，ISO 8601 */
  readonly renewedAt: string;
}

export interface LockOptions {
  /** 默认 30 秒（架构文档 §10.6「默认 30 秒租约」） */
  readonly leaseSeconds: number;
  /** 默认 10 秒（架构文档 §10.6「10 秒续租」） */
  readonly renewSeconds: number;
}

/** 架构文档 §10.6 的两个默认值。 */
export const DEFAULT_LOCK_OPTIONS: LockOptions = Object.freeze({
  leaseSeconds: 30,
  renewSeconds: 10,
});

function expiresAtMillis(record: LockRecord): number {
  return Date.parse(record.expiresAt);
}

/**
 * 租约是否已过期。
 *
 * 边界取「到期时刻即过期」：`expiresAt === now` 说明租约刚好走完，
 * 让等待方继续等下去只会制造一个没有持有者的锁。
 */
export function isExpired(record: LockRecord, now: Date): boolean {
  return expiresAtMillis(record) <= now.getTime();
}

/** 两个 URI 是否相同或互为祖先（段边界比较，不是字符串前缀）。 */
function sharesPath(left: Uri, right: Uri): boolean {
  return left.equals(right) || left.isAncestorOf(right) || right.isAncestorOf(left);
}

/**
 * 两个锁是否互斥（§10.6 的表格）。
 *
 * 规则：同一路径必然冲突；只要有一方是 `TREE`，同路径或祖先/后代路径都冲突；
 * 两个都是 `EXACT` 时只有同一路径冲突——`write a/x.md` 和 `write a/y.md` 该并行。
 *
 * 无法解析的 `uri` 按冲突处理：锁文件被写坏时，宁可让后来的获取方等到超时
 * 报错，也不能放两个写者同时进去。
 */
export function conflicts(left: LockRecord, right: LockRecord): boolean {
  const leftUri = Uri.tryParse(left.uri);
  const rightUri = Uri.tryParse(right.uri);
  if (leftUri === null || rightUri === null) {
    return true;
  }
  if (leftUri.equals(rightUri)) {
    return true;
  }
  if (left.mode === 'exact' && right.mode === 'exact') {
    return false;
  }
  return sharesPath(leftUri, rightUri);
}

/**
 * 拿锁决策。
 *
 * - 没有现有锁：`acquire`
 * - 现有锁已过期：`steal`（删掉过期锁再重试）
 * - 现有锁还在租期内：`wait`（轮询）
 */
export function acquireDecision(
  existing: LockRecord | undefined,
  now: Date,
): 'acquire' | 'steal' | 'wait' {
  if (existing === undefined) {
    return 'acquire';
  }
  return isExpired(existing, now) ? 'steal' : 'wait';
}

/** 按 `now` 与租约时长造一条锁记录。 */
export function createLockRecord(
  owner: string,
  mode: LockMode,
  uri: Uri,
  now: Date,
  options: LockOptions,
): LockRecord {
  return {
    owner,
    mode,
    uri: uri.toString(),
    expiresAt: new Date(
      now.getTime() + options.leaseSeconds * MILLISECONDS_PER_SECOND,
    ).toISOString(),
    renewedAt: now.toISOString(),
  };
}

/**
 * 是否该续租：租约剩余时间不足 `renewSeconds` 时续。
 *
 * 边界取「剩余恰好等于 `renewSeconds` 就续」——留满一个续租窗口的余量，
 * 而不是等真的快过期了再动。已过期（剩余为负）同样返回真，调用方续租即可。
 */
export function shouldRenew(record: LockRecord, now: Date, options: LockOptions): boolean {
  const remaining = expiresAtMillis(record) - now.getTime();
  return remaining <= options.renewSeconds * MILLISECONDS_PER_SECOND;
}
