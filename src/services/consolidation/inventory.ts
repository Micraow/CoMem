/**
 * 合并候选的枚举（架构文档 §11.8「循环」「隔离」）。
 *
 * 候选来自检索索引的 `glob`，在路径上排除版本文件与非记忆文件，再按 `status` 只留
 * `active`。清单只带摘要、不带正文：正文由探索循环按模型的 `read` 请求读取。
 */

import { memoryContentOf } from '../../domain/memory-type.js';
import { isVersionFile } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';

import type { MemoryRecord } from '../memory.js';

import type {
  ConsolidateOptions,
  ConsolidationPorts,
  InventoryEntry,
  ScopeInventory,
} from './types.js';

/**
 * 清单最多枚举多少条记忆。
 *
 * **200 是经验值，来源是 prompt 预算**：一条清单约 100 字符（URI + 类型 + 200 字符
 * 摘要），200 条约 20k 字符 ≈ 5k token；加上 10 轮读到的正文仍在常见 32k 上下文内。
 * 更多记忆应该先按目录拆 scope，而不是把清单撑到模型看不完。
 */
const INVENTORY_LIMIT = 200;

/**
 * 清单里每条记忆的摘要长度（字符）。
 *
 * **200 是经验值**：够区分「code-style」与「license-review」这类同目录记忆
 * （约 50 token），又不至于让清单本身吃掉正文预算。
 */
const SUMMARY_CHARS = 200;

/**
 * 版本快照不是记忆（W98）。
 *
 * 判据是 `domain/node.ts` 的 `isVersionFile`，不再在这里写一份本地字面量。之前这里
 * 的注释说「故意不复用写入方的常量」，理由是 `.history` 属于记忆服务的私有结构；
 * 判据进领域层之后那个理由消解了——`.history` 是路径语义，合并、TTL、摘要传播与
 * 重建索引必须读同一份定义，各写一份只会让某处漂移。
 */
/** 记忆文件的扩展名。与 `MemoryService` 写入的形状一致。 */
const GLOB_PATTERN = '**/*.md';

/** 把记忆正文压成一行摘要；空正文（`add` 之外理论上都有）给空串。 */
function summarize(record: MemoryRecord): string {
  const text = memoryContentOf(record.fields).replace(/\s+/gu, ' ').trim();
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}…`;
}

export async function collectInventory(
  ports: Pick<ConsolidationPorts, 'search' | 'memory' | 'logger'>,
  memoriesDirectory: Uri,
  options: ConsolidateOptions,
): Promise<ScopeInventory> {
  const { search, memory, logger } = ports;
  const uris = await search.glob(GLOB_PATTERN, {
    scopes: [memoriesDirectory.toString()],
    subject: options.subject,
    principals: options.principals,
    limit: INVENTORY_LIMIT,
  });

  if (uris.length >= INVENTORY_LIMIT) {
    logger.warn('记忆合并的清单达到条数上限，本次只合并前若干条', {
      scope: memoriesDirectory.toString(),
      limit: INVENTORY_LIMIT,
    });
  }

  const candidates: InventoryEntry[] = [];
  const all = new Set<string>();
  for (const value of [...uris].sort()) {
    const uri = Uri.tryParse(value);
    if (uri === null || isVersionFile(uri)) {
      // 版本文件是**已经失效的旧值**（W98）：`status` 仍是 `active`，靠 `valid_until`
      // 才和当前值区分开。合并清单问的是「当前有哪些记忆」，所以它不进候选清单
      // （`candidates`），也就不会被模型当成一条可以 `delete` 的记忆（删掉一份版本
      // 就掐断了 `supersedes` 链）。
      //
      // 但版本文件**占用 `glob` 的返回名额**：`limit: INVENTORY_LIMIT` 是
      // `SearchService.glob` 查询本身的参数，按路径段过滤发生在它返回之后（下面的
      // `continue`），所以 `uris` 里确实混着版本文件。占用有上界——写入时每个
      // identity 只保留最新 `MAX_VERSIONS = 5` 份（`MemoryService` 的截断）。
      //
      // 检索面看不到版本文件是因为 `find` / `search` 带 `asOf`（`node.valid_until`
      // 过滤）；`glob` 是路径工具，契约是磁盘，没有 `asOf`。不给 `SearchService.glob`
      // 加这个参数（那会改检索层的公开签名，影响面比这条缺陷大），在路径段上排除。
      continue;
    }
    const record = await memory.read(uri);
    if (record === null) {
      // 不是记忆文件（`memories/` 下可能有用户手工放的普通 Markdown）。
      continue;
    }
    const canonical = record.uri.toString();
    all.add(canonical);
    if (record.status !== 'active') {
      continue;
    }
    candidates.push({
      uri: canonical,
      memoryType: record.memoryType,
      summary: summarize(record),
      updatedAt: record.updatedAt,
    });
  }
  return { candidates, uris: all };
}
