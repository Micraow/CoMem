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
 *
 * ## transcript 的格式由宿主决定
 *
 * 采集的是宿主写出的 transcript 文件，**每个宿主的格式不同**（Claude Code 是带
 * 顶层 `message` 的 JSONL，Codex 是 `type: "response_item"` + `payload` 的
 * rollout）。解析器因此挂在 `hosts/<host>.mjs` 的 `parseTranscript` 上，本文件只
 * 负责「拿路径 → 交给当前宿主的解析器」。反过来做的代价是真实的：内置一种格式时，
 * 另一种宿主的每一行都被跳过，`Stop` 拿到空数组后早退——不发 `POST /sessions`、
 * 不建会话、不建任务，进程还退出 0。
 *
 * 解析出 0 条消息时写一行诊断到 `{tmpdir}/comem-capture.log`（**不能只写 stderr**：
 * `Stop` 的 worker 是 `stdio: 'ignore'` 的分离进程，stderr 被丢弃）。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_HOST_NAME, isBypassed, loadConfig, loadHost, resolveHost } from '../lib/config.mjs';
import { FileEventDeduper } from '../lib/dedup.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { withSessionLock } from '../lib/lock.mjs';
import { advanceCursor, readCursor } from '../lib/cursor.mjs';
import { runMain } from '../lib/lifecycle.mjs';
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

/**
 * 采集诊断日志的文件名（落在 `tmpDir` 下）。
 *
 * **为什么不是 stderr。** `Stop` 的采集跑在 `stdio: 'ignore'` 的分离 worker 里，
 * 它的 stderr 被丢弃——写在那里等于没有。`PreCompact` / `SessionEnd` 走同一条
 * 采集路径，也读同一份文件。
 */
const CAPTURE_LOG_FILE = 'comem-capture.log';

/**
 * 诊断日志的上限。
 *
 * 262144（256 KiB）是经验值：一条诊断约 200 字节，足够放上千条；超过之后整份
 * 重写，只留最新一条——诊断日志不该成为 `/tmp` 的无限增长源，也不值得为它引入
 * 轮转配置。
 */
const CAPTURE_LOG_MAX_BYTES = 262_144;

/**
 * 交给**当前宿主**的解析器读 transcript。
 *
 * 宿主名取自归一化后的 `event.host`：worker 是 `spawn` 出来的分离进程，只继承了
 * 脚本路径（`--host` 不在它的 argv 里），从载荷里读才不会退回默认宿主。
 *
 * @param {{ host?: string, sessionId: string, transcriptPath: string }} event
 * @returns {Promise<{
 *   messages: Record<string, unknown>[],
 *   lines: number,
 *   skipped: number,
 *   sample: string | null,
 *   readError?: string,
 *   note?: string,
 * }>}
 */
async function readTranscript(event) {
  const hostName =
    typeof event.host === 'string' && event.host !== '' ? event.host : DEFAULT_HOST_NAME;
  const parseTranscript = (await loadHost(hostName)).parseTranscript;

  let text;
  try {
    text = await readFile(event.transcriptPath, 'utf8');
  } catch (error) {
    return {
      messages: [],
      lines: 0,
      skipped: 0,
      sample: null,
      readError: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
    };
  }
  return parseTranscript(text, { sessionId: event.sessionId });
}

/**
 * 写一行「没有采集到消息」的诊断。
 *
 * 这条路径以前是静默 `return`：宿主名、transcript 路径、行数一个都看不到，用户
 * 只能观察到「开了新对话，什么都没记住」。**不打印消息正文**——诊断只需要能回答
 * 「这份文件是不是这个宿主的格式」。
 *
 * @param {string} dir
 * @param {{ event: string, host?: string, sessionId: string, transcriptPath: string | null, messages: readonly Record<string, unknown>[] | null }} event
 * @param {Awaited<ReturnType<typeof readTranscript>> | null} transcript
 * @param {readonly Record<string, unknown>[] | null} provided 载荷里自带的累积消息列表（没有则为 `null`）
 */
async function reportEmptyCapture(dir, event, transcript, provided) {
  const record = {
    level: 'warn',
    component: 'capture',
    event: event.event,
    host: typeof event.host === 'string' && event.host !== '' ? event.host : DEFAULT_HOST_NAME,
    sessionId: event.sessionId,
    transcript: event.transcriptPath,
    reason: 'no-transcript-path',
    lines: 0,
    skipped: 0,
    sample: null,
  };
  if (transcript !== null) {
    record.reason = transcript.readError === undefined ? 'no-messages' : 'transcript-read-failed';
    record.lines = transcript.lines;
    record.skipped = transcript.skipped;
    record.sample = transcript.sample;
    if (transcript.readError !== undefined) {
      record['error'] = transcript.readError;
    }
    if (transcript.note !== undefined) {
      record['note'] = transcript.note;
    }
  } else if (Array.isArray(provided)) {
    record.reason = 'empty-messages';
  }

  const file = join(dir, CAPTURE_LOG_FILE);
  const line = `${JSON.stringify(record)}\n`;
  try {
    const info = await stat(file).catch(() => null);
    if (info !== null && info.size >= CAPTURE_LOG_MAX_BYTES) {
      await writeFile(file, line, 'utf8');
      return;
    }
    await appendFile(file, line, 'utf8');
  } catch {
    // 诊断日志写不了就算了：它不能反过来让采集失败。
  }
}

/**
 * 确保会话存在：**409 是正常路径**，表示会话已存在，复用即可。
 *
 * 服务端的 `POST /sessions` 只创建、不重置。收到 200 说明这一轮刚建出一个空
 * 会话；收到 409 说明它已经在了，消息原样保留。两者都可以继续写消息，但**只有
 * 409 能证明上一轮的消息没被清空**——所以这里不能把 409 当错误，也不能把
 * 409 之外的状态当成「已存在」。
 *
 * @param {{ sessionId: string }} event
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient> }} deps
 */
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
 * @param {{ event: string, host?: string, sessionId: string, cwd: string, eventId: string | null, transcriptPath: string | null, messages: readonly Record<string, unknown>[] | null }} event `event` 是内部事件名（`lib/events.json` 的键），上报时原样用；`host` 决定用哪个 transcript 解析器
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
      // 宿主直接给了累积列表（DSH 的 `data.messages`）就用它；否则交给当前宿主的
      // transcript 解析器（`hosts/<host>.mjs` 的 `parseTranscript`）。
      const provided = Array.isArray(event.messages) ? event.messages : null;
      const transcript =
        provided === null && typeof event.transcriptPath === 'string'
          ? await readTranscript(event)
          : null;
      const messages = provided ?? transcript?.messages ?? [];
      const pending = messages.slice(cursor);
      if (pending.length === 0) {
        // 「0 条」不是正常返回：整条阶段二（建会话 → 写消息 → 提交 → 建任务）
        // 都没有启动。留一行能定位的诊断，不打印消息正文。
        if (messages.length === 0) {
          await reportEmptyCapture(dir, event, transcript, provided);
        }
        return { captured: 0, committed: false, bypassed: false };
      }

      await ensureSession(event, deps);
      await deps.http.post(`${SESSIONS_PATH}/${event.sessionId}/messages`, { messages: pending });
      // 到这一步服务端已经接收，游标可以前进。
      await advanceCursor(event.sessionId, messages.length, { dir });

      // 提交是**无条件**的：`POST /sessions/{id}/commit` 直接调 `commitPhase1`
      // （`src/api/http/routes/sessions.ts` 的 `/:id/commit`），不看
      // `session.autoCommit`——那个配置只决定后台调度器什么时候自动提交、归档时
      // 保留最近几条（`keepRecentCount`），不影响这次显式调用。hook 负责「每轮
      // 结束后提一次」。
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
  // 清理放在 worker 侧：`Stop` 不等待采集完成就退出（§15.3），一次目录扫描不该
  // 出现在这条路径上。worker 是分离进程，它扫多久都不影响用户。
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
        event: payload.event.event,
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

  await host.runHook(
    async (event) => {
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
    },
    { hardExit: true },
  );
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
    await runMain('hook stop', main);
  }
}
