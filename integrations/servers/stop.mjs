#!/usr/bin/env node
/**
 * `Stop`：采集本轮 user / assistant 消息并提交会话（架构文档 §15.3、§15.4）。
 *
 * ## 为什么立刻返回
 *
 * `Stop` 卡住等于把用户的输入延迟绑在 LLM 抽取上。抽取一次几秒到几十秒，用户
 * 会以为宿主卡死了。所以主进程只做四件事：去重、bypass、写 worker 载荷、spawn。
 * **采集与提交跑在分离的 worker 进程里**（`detached: true` + `unref()`），主进程
 * 不等它。
 *
 * 只有 `PreCompact` / `SessionEnd` 会等提交完成（见 `servers/pre-compact.mjs`）。
 *
 * ## 三层去重
 *
 * 1. **事件去重**（§15.4 第 1 层）：`eventId` 存在时 500ms 窗口内只处理一次。
 *    Claude Code 的 `Stop` 没有事件 ID，这一层对它是空操作——两轮合法的 `Stop`
 *    载荷可以完全一样，拿载荷哈希去重会吞掉第二轮。
 * 2. **消息去重**（第 2 层）：游标之后的才提交，游标只在服务端确认后前进。
 * 3. **跨进程锁**（第 3 层）：同一 session 的 worker 串行化。
 *
 * ## 为什么 worker 载荷走文件
 *
 * `detached` + `stdio: 'ignore'` 的进程拿不到父进程的 stdin。载荷走环境变量会
 * 撞 Linux 的单个变量上限（DSH 适配器可能把整段对话放进载荷），所以写临时文件、
 * 把路径传过去；worker 读完立刻删。过期文件在每次写入前顺带清掉。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { FileEventDeduper } from '../lib/dedup.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { withSessionLock } from '../lib/lock.mjs';
import { advanceCursor, readCursor } from '../lib/cursor.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

const SESSIONS_PATH = '/api/v1/sessions';

/** `POST /sessions` 的 409 表示会话已存在（§19 的 CONFLICT）。 */
const CONFLICT_STATUS = 409;

/** worker 载荷文件前缀。 */
const WORKER_PAYLOAD_PREFIX = 'comem-stop-';

/**
 * 过期载荷文件的清理阈值。
 *
 * 3600000（1 小时）是经验值：一个 worker 正常在几秒内读完并删除自己的载荷，
 * 留下来的都是崩溃残留。1 小时远大于任何 hook 的寿命，不会误删正在用的文件。
 */
const WORKER_PAYLOAD_MAX_AGE_MS = 3_600_000;

/** 环境变量：worker 模式标记与载荷路径。 */
const WORKER_FLAG = 'COMEM_WORKER';
const WORKER_PAYLOAD = 'COMEM_WORKER_PAYLOAD';

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * 从 transcript 的 `content` 里抽纯文本 part。
 *
 * 只认 `text` 块：`tool_use` / `tool_result` 由 `PostToolUse` 采集（两边不重叠），
 * 图片在 v1 的 Hook 里不采集（§10.1：图片只存 URL，解析交给 agent）。
 */
function extractTextParts(content) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ kind: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'] !== '') {
      parts.push({ kind: 'text', text: record['text'] });
    }
  }
  return parts;
}

/**
 * 读 transcript（Claude Code 的 JSONL），只保留 user / assistant 的文本消息。
 *
 * 畸形行跳过而不是整体失败：transcript 是宿主边写边追加的，最后一行经常是半个
 * JSON。为一行半截数据丢掉整轮会话，方向反了。
 *
 * `isSidechain` 的行（子 agent 的对话）也跳过：它属于另一个会话，混进来会被
 * 抽取成「用户说过」的记忆。
 *
 * @param {string} transcriptPath
 * @param {string} sessionId
 * @returns {Promise<readonly Record<string, unknown>[]>}
 */
export async function readTranscriptMessages(transcriptPath, sessionId) {
  let text;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const messages = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    let entry;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry['isSidechain'] === true) {
      continue;
    }
    const message = asRecord(entry['message']);
    const role = message['role'];
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    const parts = extractTextParts(message['content']);
    if (parts.length === 0) {
      continue;
    }
    messages.push({
      // 用宿主给的 uuid：重投同一批消息时 ID 稳定，服务端能按 ID 去重。
      id: typeof entry['uuid'] === 'string' ? entry['uuid'] : `${sessionId}:${index}`,
      role,
      parts,
      createdAt:
        typeof entry['timestamp'] === 'string' ? entry['timestamp'] : new Date().toISOString(),
    });
  }
  return messages;
}

async function ensureSession(event, deps) {
  try {
    await deps.http.post(SESSIONS_PATH, {
      sessionId: event.sessionId,
      userId: deps.config.userId,
    });
  } catch (error) {
    if (error.status !== CONFLICT_STATUS) {
      throw error;
    }
  }
}

/**
 * 采样本轮消息并提交。**游标只在服务端确认后前进**（§15.4 第 2 层）。
 *
 * 失败时游标不动：下一次 `Stop` / `PreCompact` 把同一批消息重投一遍。宁可重复
 * （服务端按消息 ID 去重）不能丢。
 *
 * @param {{ sessionId: string, cwd: string, eventId: string | null, transcriptPath: string | null, messages: readonly Record<string, unknown>[] | null }} event
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv }} deps
 * @returns {Promise<{ captured: number, committed: boolean, bypassed: boolean }>}
 */
export async function captureSession(event, deps) {
  const env = deps.env ?? process.env;
  if (isBypassed({ cwd: event.cwd }, env)) {
    return { captured: 0, committed: false, bypassed: true };
  }

  return withSessionLock(
    event.sessionId,
    async () => {
      const dir = deps.config.tmpDir;
      // 自定义 `COMEM_HOOK_TMPDIR` 可能还不存在。锁与游标都落在它下面，缺目录时
      // 失败会表现成「采集偶尔不生效」——那种问题最难查。
      await mkdir(dir, { recursive: true });
      const cursor = await readCursor(event.sessionId, { dir });
      const messages =
        event.messages ??
        (event.transcriptPath === null
          ? []
          : await readTranscriptMessages(event.transcriptPath, event.sessionId));
      const pending = messages.slice(cursor);
      if (pending.length === 0) {
        return { captured: 0, committed: false, bypassed: false };
      }

      await ensureSession(event, deps);
      await deps.http.post(`${SESSIONS_PATH}/${event.sessionId}/messages`, { messages: pending });
      // 到这一步服务端已经接收，游标可以前进。
      await advanceCursor(event.sessionId, messages.length, { dir });

      // 提交是否真的归档由服务端的 `session.autoCommit` 策略决定（§10.2.1），
      // hook 只负责「每轮结束后提一次」。
      await deps.http.post(`${SESSIONS_PATH}/${event.sessionId}/commit`, {});
      return { captured: pending.length, committed: true, bypassed: false };
    },
    { dir: deps.config.tmpDir },
  );
}

/** 清理崩溃残留的 worker 载荷。 */
async function sweepWorkerPayloads(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(WORKER_PAYLOAD_PREFIX)) {
      continue;
    }
    const file = join(dir, entry);
    try {
      const info = await stat(file);
      if (now - info.mtimeMs > WORKER_PAYLOAD_MAX_AGE_MS) {
        await unlink(file).catch(() => {});
      }
    } catch {
      // 文件刚被别的进程删掉：正常。
    }
  }
}

/**
 * 写 worker 载荷文件，返回路径。
 *
 * @param {string} dir
 * @param {{ event: object, processStartMs: number }} payload
 * @returns {Promise<string>}
 */
export async function writeWorkerPayload(dir, payload) {
  // 清理放在 worker 侧：`Stop` 的阻塞预算只有 50ms（§15.9），一次目录扫描不值得
  // 放在这条路径上。worker 是分离进程，它扫多久都不影响用户。
  const file = join(dir, `${WORKER_PAYLOAD_PREFIX}${process.pid}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(payload), 'utf8');
  return file;
}

/**
 * 起分离的采集 worker。**主进程不等它**——`detached` 让它脱离进程组，
 * `unref()` 让事件循环不再被它持有（§15.3）。
 *
 * @param {string} payloadFile
 * @param {{ env?: NodeJS.ProcessEnv, scriptPath?: string, spawnImpl?: typeof spawn }} [options]
 */
export function spawnCaptureWorker(payloadFile, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    [options.scriptPath ?? fileURLToPath(import.meta.url)],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...(options.env ?? process.env), [WORKER_FLAG]: '1', [WORKER_PAYLOAD]: payloadFile },
    },
  );
  child.unref();
  return child;
}

/**
 * worker 侧：读载荷 → 采集 → 上报 → 清理。
 *
 * @param {string} payloadFile
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv }} deps
 */
export async function runCaptureWorker(payloadFile, deps) {
  const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
  await sweepWorkerPayloads(deps.config.tmpDir);
  try {
    const captureStartedAt = process.hrtime.bigint();
    const result = await captureSession(payload.event, deps);
    const captureMs = elapsedMs(captureStartedAt);
    await reportOverhead(
      {
        event: 'Stop',
        sessionId: payload.event.sessionId,
        phases: { processStartMs: payload.processStartMs, recallMs: 0, serializeMs: 0, captureMs },
      },
      { config: deps.config, http: deps.http },
    );
    return result;
  } finally {
    await unlink(payloadFile).catch(() => {});
  }
}

async function main() {
  const config = await loadConfig();
  const host = await resolveHost();
  const deduper = new FileEventDeduper(join(config.tmpDir, 'comem-events.json'));

  await host.runHook(async (event) => {
    if (!(await deduper.accept(event.eventId))) {
      return undefined;
    }
    if (isBypassed({ cwd: event.cwd })) {
      return undefined;
    }
    const payloadFile = await writeWorkerPayload(config.tmpDir, {
      event,
      processStartMs: processStartMs(),
    });
    spawnCaptureWorker(payloadFile);
    return undefined;
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.env[WORKER_FLAG] === '1') {
    const payloadFile = process.env[WORKER_PAYLOAD];
    if (payloadFile !== undefined && payloadFile !== '') {
      const config = await loadConfig();
      await runCaptureWorker(payloadFile, { config, http: createHttpClient(config) });
    }
  } else {
    await main();
  }
}
