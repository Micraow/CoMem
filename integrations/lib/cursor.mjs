/**
 * 消息游标（架构文档 §15.4 第 2 层）。
 *
 * 游标记的是「这个会话已经成功提交到服务端的消息条数」。宿主每次都把整段 transcript
 * 给过来，游标之后的部分才是待提交消息。
 *
 * ## 只在服务端确认后前进
 *
 * `advanceCursor` 只能在上游的 `POST /sessions/{id}/messages` 返回成功之后调用。
 * 反过来（先前进再提交）一旦请求失败，那批消息就永远补不上了——**丢消息比重复消息
 * 严重得多**，重复消息在服务端能按 ID 去重，丢掉的没法恢复。
 *
 * 所以本模块不提供「先前进、失败回滚」的接口：回滚本身也要一次落盘，等于把窗口
 * 摊大。调用方顺序写死为「提交成功 → advanceCursor」。
 *
 * ## 文件形状
 *
 * `{tmpdir}/comem-cursors.json`：
 *
 * ```json
 * { "cc-7f3a91c2": 42, "cx-thr_1": 7 }
 * ```
 *
 * 写入是「临时文件 + rename」，与事件去重文件同一个理由：半个 JSON 读回来等于
 * 全库游标归零。
 *
 * 不同会话的并发写入会有一方丢更新（整个文件重写）。后果是那个会话重投一次，
 * 服务端按消息 ID 去重——方向仍然是「宁可重复不能丢」。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTempDir } from './config.mjs';
import { ComemHookError } from './http.mjs';

/** 游标文件名。任务书指定，不用另外起名。 */
const CURSOR_FILE_NAME = 'comem-cursors.json';

export function cursorFilePath(dir = resolveTempDir()) {
  return join(dir, CURSOR_FILE_NAME);
}

function assertTurn(turn) {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new ComemHookError(`游标必须是非负整数：${String(turn)}`, {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }
}

async function readCursors(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new ComemHookError(`读取游标文件失败：${file}`, {
      code: 'HOOK_INVALID_CONFIG',
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 文件被写坏。返回空表而不是抛错：最坏是重投，不会丢消息。
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const cursors = {};
  for (const [sessionId, turn] of Object.entries(parsed)) {
    if (typeof turn === 'number' && Number.isInteger(turn) && turn >= 0) {
      cursors[sessionId] = turn;
    }
  }
  return cursors;
}

async function writeCursors(file, cursors) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(cursors), 'utf8');
  await rename(temporary, file);
}

/**
 * 读游标；没有记录时是 `0`（一条都没提交过）。
 *
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 * @returns {Promise<number>}
 */
export async function readCursor(sessionId, options = {}) {
  const cursors = await readCursors(cursorFilePath(options.dir));
  return cursors[sessionId] ?? 0;
}

/**
 * 前进到 `turn`。**只在服务端确认接收后调用**（见文件头）。
 *
 * 只前进不后退：两个 hook 进程交错时，后到的旧值不能把游标拉回去。
 *
 * @param {string} sessionId
 * @param {number} turn
 * @param {{ dir?: string }} [options]
 * @returns {Promise<number>}
 */
export async function advanceCursor(sessionId, turn, options = {}) {
  assertTurn(turn);
  const file = cursorFilePath(options.dir);
  const cursors = await readCursors(file);
  const current = cursors[sessionId] ?? 0;
  const next = Math.max(current, turn);
  if (next === current) {
    return current;
  }
  cursors[sessionId] = next;
  await writeCursors(file, cursors);
  return next;
}
