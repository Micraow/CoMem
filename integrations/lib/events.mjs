/**
 * Hook 事件名的唯一来源（架构文档 §15.2、§17.2）。
 *
 * 名字有两套，方向不同，含义也不同：
 *
 * | 方向 | 例子 | 谁在用 |
 * |---|---|---|
 * | 内部事件名（snake_case） | `session_start` | `POST /api/v1/telemetry/hook` 的 `event` 字段、`comem_hook_*` 的 `event` 标签、控制台的行键 |
 * | 宿主事件名（PascalCase） | `SessionStart` | 宿主载荷里的 `hook_event_name` / `event`、hook 返回信封里的 `hookEventName` |
 *
 * 两套名字**只在这一个地方**对应。以前三个宿主适配器各写一份 `EVENT_NAMES`，
 * 五个上报点又各写一个 PascalCase 字面量，而服务端白名单只认 snake_case
 * （`src/services/observability.ts` 的 `HOOK_EVENTS`），于是所有 hook 样本都塌进
 * `event="other"`，控制台七个生命周期行永远没有数据。
 *
 * 上报方适配接收方的既有契约：服务端已经存了 snake_case 的历史数据，所以内部
 * 事件名是 snake_case，宿主事件名保持宿主给的原样（宿主不认识别的拼法）。
 *
 * 表放在 `events.json` 而不是内联在这里，是因为服务端测试（TypeScript）也要引用
 * 同一份数据：`tsc` 在没有 `allowJs` 时不能 import `.mjs`，JSON 两边都能读。
 * 服务端白名单与这张表的一致性由
 * `tests/integration/services/observability.test.ts` 断言——加事件时先改
 * `events.json`，再跑 `pnpm test`。
 *
 * ## `reportsOverhead`
 *
 * 不是每个生命周期点都上报阻塞开销。`PreToolUse` 只做本地字符串判断、**不发
 * HTTP**（`servers/pre-tool-use.mjs` 的文件头），给它加一次上报等于给每次工具调用
 * 加一次网络往返。所以它的 `reportsOverhead` 是 `false`：适配器照样接受这个载荷，
 * 但它不出现在 `/metrics` 的 `event` 白名单里，控制台也不为它留行——一个永远
 * 不会有样本的事件名会被读成「没发生」，不是「没采集」。
 */

import { readFileSync } from 'node:fs';

const TABLE_URL = new URL('./events.json', import.meta.url);

/**
 * `events.json` 的原始表：内部事件名 → `{ hostEventName, reportsOverhead }`。
 *
 * 用 `readFileSync` 而不是 import attributes（`with { type: 'json' }`）：后者在
 * `engines.node >= 22.5` 的边界上支持情况不一致，读失败会让**每一个** hook 在
 * 模块加载阶段就挂掉。200 字节的同步读相对一次 hook 的 30–50ms 进程启动可以忽略。
 *
 * @type {Readonly<Record<string, { hostEventName: string, reportsOverhead: boolean }>>}
 */
const TABLE = Object.freeze(
  /** @type {Record<string, { hostEventName: string, reportsOverhead: boolean }>} */ (
    JSON.parse(readFileSync(TABLE_URL, 'utf8'))
  ),
);

/**
 * 内部事件名 → 宿主事件名。
 *
 * 两个 hook 宿主（Claude Code / Codex）目前用同一组 PascalCase 名字，所以一张表
 * 够用；某个宿主哪天改名，改这里的一行，而不是复制两份适配器代码。DSH 的原生插件
 * 不经过这张表的宿主名一侧（它直接调 handler，用内部事件名上报）。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EVENT_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(TABLE).map(([internal, entry]) => [internal, entry.hostEventName]),
  ),
);

/**
 * 有上报点（`POST /api/v1/telemetry/hook`）的内部事件名。
 *
 * 服务端的 `event` 白名单必须正好是这一组：多一个就会多一条永远没有样本的时间
 * 序列，少一个就让真实样本塌进 `other`。
 *
 * @type {readonly string[]}
 */
export const REPORTED_EVENT_NAMES = Object.freeze(
  Object.entries(TABLE)
    .filter(([, entry]) => entry.reportsOverhead)
    .map(([internal]) => internal),
);

/** 宿主事件名 → 内部事件名。反向索引只由上面那张表算出，不另立一份。 */
const INTERNAL_BY_HOST = new Map(
  Object.entries(EVENT_NAMES).map(([internal, host]) => [host, internal]),
);

/**
 * 宿主事件名 → 内部事件名。不认识的返回 `null`，由适配器决定怎么报错。
 *
 * 为什么不是 `EVENT_NAMES[event]` 那种「先 normalize 再查表」：旧代码对
 * `SessionEnd` 做了「归一成 `PreCompact`」的字符串特判，等于在适配器里又埋了
 * 第二套命名。现在 `session_end` 是表里的一等事件名，特判消失，Adapter 只做一次
 * 查表。
 *
 * @param {string} hostEventName
 * @returns {string | null}
 */
export function internalEventNameOf(hostEventName) {
  return INTERNAL_BY_HOST.get(hostEventName) ?? null;
}
