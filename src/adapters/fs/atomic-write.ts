/**
 * 原子写：同目录临时文件 → 写入 → `fsync` → `rename`。
 *
 * 任何时刻被读到的文件要么是旧的完整内容，要么是新的完整内容，不会读到写了一半的
 * 内容。`open` 用 `wx`：临时文件名撞上已存在的文件时直接失败，不复用别人的半成品。
 * 失败路径上清掉临时文件，不让它变成 `list` 里的垃圾。没有 `fsync` 的话，`rename`
 * 之后断电可能留下空文件——「写了一半」的另一种形态。
 *
 * 错误映射由调用方传入：各适配器有自己的 URI 归属与 errno 覆盖（§19），「同一个
 * errno 在不同适配器里含义不同」是有意保留的差异，这里不做统一。
 */

import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TEMP_FILE_PREFIX } from './path.js';

/**
 * 临时文件后缀的随机位数（base36）。8 位 36 进制约 41 bit 随机性；同一目录并发写
 * 撞名概率可以忽略，同时保留进程号区分多进程。
 */
const TEMP_SUFFIX_LENGTH = 8;

function randomTempSuffix(): string {
  return `${process.pid.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 2 + TEMP_SUFFIX_LENGTH)}`;
}

interface StagedWrite {
  readonly tempPath: string;
  readonly stats: Stats;
}

async function stage(
  absolutePath: string,
  data: string | Uint8Array,
  mapError: (error: unknown) => Error,
): Promise<StagedWrite> {
  const tempPath = join(dirname(absolutePath), `${TEMP_FILE_PREFIX}${randomTempSuffix()}`);
  let handle: FileHandle;
  try {
    handle = await open(tempPath, 'wx');
  } catch (error) {
    throw mapError(error);
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
    const stats = await handle.stat();
    await handle.close();
    return { tempPath, stats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw mapError(error);
  }
}

/**
 * 写同目录临时文件并 `fsync`，返回它的路径；改名由调用方决定。
 *
 * 摘要的 L0 / L1 要各写一份临时文件、再依次改名：第一个写失败时第二个还没生效，
 * 两次改名之间的窗口见 `metadata-file.ts` 的 `writeSummary`。
 */
export async function writeFileStaged(
  absolutePath: string,
  data: string | Uint8Array,
  mapError: (error: unknown) => Error,
): Promise<string> {
  return (await stage(absolutePath, data, mapError)).tempPath;
}

/**
 * 原子写一个文件，成功返回它的 `Stats`；调用方不需要时忽略。
 *
 * 返回值取自 `rename` 前的 `handle.stat()`：文件此时已 `fsync`，大小与时间戳就是
 * 落盘后的值。
 */
export async function writeFileAtomic(
  absolutePath: string,
  data: string | Uint8Array,
  mapError: (error: unknown) => Error,
): Promise<Stats> {
  const { tempPath, stats } = await stage(absolutePath, data, mapError);
  try {
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw mapError(error);
  }
  return stats;
}
