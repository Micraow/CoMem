/**
 * 跨轮召回账本：同一会话里已经注入过的记忆不再注入（架构文档 §15.10）。
 *
 * `UserPromptSubmit` 每轮都拿 prompt 去 `find` 并注入 top-k。用户连续问三个相关的
 * 问题，同一段记忆会被完整注入三次：上下文浪费 2/3，模型还可能因为反复看到同一段
 * 内容而照抄。账本记「这个会话已经投喂过哪些 URI」，下一轮检索时排除它们。
 *
 * ## 为什么是 hook 侧的文件，而不是服务端的账本
 *
 * 服务端有召回账本（§8.7），但它的去重入口只在 `POST /search/search` 的
 * `mode=context` 上；`POST /search/find`——也就是 hook 走的这条——**不接受排除列表**。
 * 让 hook 改走 `mode=context` 是换一条出口（组装、预算、渲染全变），不是加一个参数。
 * 所以 v1 在 hook 侧记一份，检索完之后按 URI 过滤；服务端加参数是 API 变更，另行决定。
 *
 * 客户端过滤的代价是**欠额**：服务端按 `limit` 返回 top-k，被排除的条目不会补位。
 * 所以检索时多要 `min(已投喂条数, recallLimit)` 条——最多多要一倍。多要的条数
 * 不能跟着账本上限（200）走：服务端按 `limit × candidateMultiplier` 取候选，
 * 210 条会把它放大到 840 条，把每轮按回车的延迟绑在检索上。
 *
 * ## 为什么跟着 `tmpDir` 走，不是会话目录
 *
 * 与游标（`lib/cursor.mjs`）、事件去重（`lib/dedup.mjs`）同一个目录：
 * `{tmpDir}/comem-recall-ledger.json`，`COMEM_HOOK_TMPDIR` 可以整体换掉。理由有三条：
 *
 * 1. **hook 拿不到服务端的 `dataDir`。** 插件可能装在另一台机器上（经 nginx 访问
 *    远程服务端），服务端的数据根对它不可见。
 * 2. **账本是一次性状态，不是真相。** 丢了只影响去重强度（下一轮多注入一次），
 *    不影响正确性；放 `/tmp` 正好——重启即清空，不需要维护生命周期。
 * 3. **已经有三个文件用这个目录。** 再引入一套「会话目录」等于让部署者多记一个
 *    路径，而 `doctor` 与文档里只需要说「都在 `COMEM_HOOK_TMPDIR` 下」。
 *
 * ## 文件形状
 *
 * ```json
 * { "sessionId": "cc-7f3a91c2", "uris": ["comem://user/alice/memories/a.md"] }
 * ```
 *
 * **只存一个会话。** 换会话（`sessionId` 变了）时整份替换——这正是「会话切换就
 * 重置」的语义，也把文件大小钉死在 200 条 URI 上（否则每开一个会话就多一条记录，
 * 文件只增不减）。回溯到旧会话时没有历史，代价是一轮重复注入。
 *
 * 写入是「临时文件 + rename」，与游标文件同一个理由：半个 JSON 读回来等于账本
 * 归零（下一轮多注入一次，不会丢东西，但会破坏去重）。
 *
 * ## 一条规则：没投喂就不写
 *
 * 只记**本轮真的进了上下文**的 URI。本轮一条都没注入（检索为空、全部低于阈值、
 * 全部被排除）时**不写账本**——「没给过」不等于「给过了」。反过来做的后果是：
 * 某一轮阈值把结果全裁掉，账本却被写进一堆 URI，下一轮真的相关时这些记忆被静默
 * 压制，去重窗口内再也召不回来。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTempDir } from './config.mjs';
import { ComemHookError } from './http.mjs';

/** 账本文件名。 */
const LEDGER_FILE_NAME = 'comem-recall-ledger.json';

/**
 * 账本上限（条）。
 *
 * 200 是**经验值**，没有架构来源：默认 `recallLimit = 10` 时它是 20 轮的量，
 * 足够覆盖「连续追问同一个话题」的去重窗口；再大的话文件会跟着会话长度线性涨，
 * 而排在前面的 URI 早就不会出现在 top-k 里了。超出按 FIFO 淘汰最早的。
 */
export const RECALL_LEDGER_MAX_ENTRIES = 200;

/**
 * @param {string} [dir]
 * @returns {string}
 */
export function recallLedgerPath(dir = resolveTempDir()) {
  return join(dir, LEDGER_FILE_NAME);
}

/**
 * 读账本。文件不存在、被写坏、形状不对都返回 `null`（等于「没有历史」）。
 *
 * 读失败（`EACCES` 等）**抛** `ComemHookError`：调用方要能区分「没有历史」与
 * 「账本读不了」——后者是配置或部署问题，静默降级成「不去重」会让它永远查不到。
 *
 * @param {string} file
 * @returns {Promise<{ sessionId: string, uris: string[] } | null>}
 */
async function readLedger(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new ComemHookError(`读取召回账本失败：${file}`, {
      code: 'HOOK_INVALID_CONFIG',
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 并发写、磁盘满导致的半截 JSON。当作「没有历史」：最坏是多注入一轮。
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.uris)) {
    return null;
  }
  return {
    sessionId: parsed.sessionId,
    uris: parsed.uris.filter((uri) => typeof uri === 'string' && uri !== ''),
  };
}

/**
 * 这个会话已经投喂过的 URI。
 *
 * 会话不匹配时返回空数组（这就是「会话切换 → 账本重置」）：调用方不需要自己判断
 * 会话有没有换，只需要问「这些能再给吗」。
 *
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function readDeliveredUris(sessionId, options = {}) {
  const ledger = await readLedger(recallLedgerPath(options.dir));
  return ledger !== null && ledger.sessionId === sessionId ? ledger.uris : [];
}

/**
 * 把本轮真的注入过的 URI 记进账本，返回记账后的完整列表。
 *
 * 已存在的 URI 先删再追加（移到队尾）：FIFO 淘汰的是「最早投喂」的，不是「上次
 * 提到」的。重复 URI 由调用方先按 `Set` 去重过也不会出错。
 *
 * `uris` 为空时**不写文件**（见文件头最后一条规则），直接返回空数组。
 *
 * @param {string} sessionId
 * @param {readonly string[]} uris
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function recordDeliveredUris(sessionId, uris, options = {}) {
  if (uris.length === 0) {
    return [];
  }

  const dir = options.dir ?? resolveTempDir();
  const file = recallLedgerPath(dir);
  // 自定义 `COMEM_HOOK_TMPDIR` 可能还不存在。不建的话第一次写会失败，表现成
  // 「去重偶尔不生效」——与 `servers/stop.mjs` 里 mkdir 的理由相同。
  await mkdir(dir, { recursive: true });

  const existing = await readLedger(file);
  const merged = existing !== null && existing.sessionId === sessionId ? [...existing.uris] : [];
  for (const uri of uris) {
    const index = merged.indexOf(uri);
    if (index >= 0) {
      merged.splice(index, 1);
    }
    merged.push(uri);
  }

  const capped = merged.slice(-RECALL_LEDGER_MAX_ENTRIES);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ sessionId, uris: capped }), 'utf8');
  await rename(temporary, file);
  return capped;
}
