/**
 * 读取与预取（架构文档 §11.3）：`read` 的投影、待复核列表、抽取前的 top-N 预取。
 *
 * 三者都只做文件级过滤：读原样文档、按 `status` 与目录名筛，不重新解释字段。
 * 锁不在这里——这些入口只读。
 */

import type { Logger } from '../../domain/log.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';
import { isVersionFile } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';
import { renderMemoryUri, type MemoryStatus } from './document.js';
import {
  listDirectoryOrEmpty,
  readMemoryDocument,
  type MemoryFileStore,
  type MemorySearchPort,
} from './ports.js';

/** scope 下放记忆的目录（§6.5）。 */
const MEMORIES_DIRECTORY = 'memories';

/**
 * 预取的最小条数。
 *
 * 来源：架构文档 §11.3 的 `limit = max(5, prefetchTopN)`。5 是「够模型判断
 * 『这是新增还是更新』」的经验下界，没有实测数据。
 */
const PREFETCH_MIN_LIMIT = 5;

export interface MemoryRecord {
  readonly uri: Uri;
  readonly memoryType: string;
  /** 字段 → 值。identity 字段必填 */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly status: MemoryStatus;
  readonly updatedAt: string;
  /**
   * 这条记忆由哪几次归档产生（frontmatter 的保留键 `sources`），最旧在前。
   *
   * 由服务端在写入点确定（`provenance` 入参），**不由模型输出**：抽取模型没有可
   * 引用的材料 URI，让它给只能得到幻觉。旧文件缺这个键时读作空数组。
   */
  readonly sources: readonly string[];
  /**
   * 这条记忆的有效区间（frontmatter 的保留键 `valid_from` / `valid_until`），
   * ISO 8601 UTC 形态。`null` = 无界：不知道从何时开始有效 / 仍然有效。
   *
   * 旧文件缺这两个键时读作 `null`，所以「没有有效期」与「一直有效」是同一个状态。
   * 检索默认只返回当前有效的节点；历史版本只能按 URI 直接 `read`。
   */
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  /**
   * 这条记忆顶替掉的版本文件 URI（frontmatter 的保留键 `supersedes`）；没有顶替
   * 过任何版本时是 `null`。
   *
   * 只用于回答「拒绝一次覆盖写会回到哪一版」；它指向的文件在 `.history` 下，版本
   * 内容不在这里。
   */
  readonly supersedes: string | null;
}

/** 读一条记忆；不存在返回 `null`。 */
export async function readMemoryRecord(
  filesystem: MemoryFileStore,
  logger: Logger,
  uri: Uri,
): Promise<MemoryRecord | null> {
  const document = await readMemoryDocument(filesystem, logger, uri);
  if (document === null) {
    return null;
  }
  return {
    uri,
    memoryType: document.memoryType,
    fields: document.fields,
    status: document.status,
    updatedAt: document.updatedAt,
    sources: document.sources,
    validFrom: document.validFrom,
    validUntil: document.validUntil,
    supersedes: document.supersedes,
  };
}

/**
 * 待复核列表：scope 下 `memories/` 里 `status = 'pending'` 的记录。
 *
 * **跳过 `.history`**：那里是已经失效的旧值（W98），不是「当前记录」。待复核队列
 * 回答的是「有哪些**当前**记忆需要人看一眼」，版本文件既不是当前值、也不该因为
 * 一次覆盖就把旧版本重新塞进人的工作队列；顺带省掉每个 identity 最多 5 次多余的
 * 读盘。
 */
export async function listPendingMemories(
  filesystem: MemoryFileStore,
  logger: Logger,
  scopeUri: Uri,
  options: { readonly limit?: number } = {},
): Promise<readonly MemoryRecord[]> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) {
    return [];
  }

  const records: MemoryRecord[] = [];
  const visit = async (directory: Uri): Promise<void> => {
    const entries = await listDirectoryOrEmpty(filesystem, directory);
    for (const entry of entries) {
      if (records.length >= limit) {
        return;
      }
      if (entry.kind === 'directory') {
        if (isVersionFile(entry.uri)) {
          continue;
        }
        await visit(entry.uri);
        continue;
      }
      const record = await readMemoryRecord(filesystem, logger, entry.uri);
      if (record !== null && record.status === 'pending') {
        records.push(record);
      }
    }
  };

  await visit(scopeUri.child(...MEMORIES_DIRECTORY.split('/')));
  return records;
}

/**
 * §11.3 的抽取预取：按 schema 目录做一次检索，返回 top-N。
 *
 * 单文件类型（`profile` / `identity` / `soul`，`filename` 里没有占位符）直接读该
 * 文件：它们的目录里可能有别的记忆，检索会把同目录的其它文件也算成「已读」。
 *
 * 只返回 `active`：`pending` 记录还在复核（§11.6），把它当「已有记忆」喂给抽取
 * 会让模型以为结论已经生效。
 */
export async function prefetchMemories(
  filesystem: MemoryFileStore,
  logger: Logger,
  search: MemorySearchPort,
  scopeUri: Uri,
  schema: MemoryTypeSchema,
  query: string,
  topN: number,
): Promise<readonly MemoryRecord[]> {
  const limit = Math.max(PREFETCH_MIN_LIMIT, topN);

  if (!schema.filename.includes('{')) {
    const record = await readMemoryRecord(
      filesystem,
      logger,
      renderMemoryUri(scopeUri, schema, {}),
    );
    return record !== null && record.status === 'active' ? [record] : [];
  }

  const directory = scopeUri.child(...schema.directory.split('/')).toString();
  const hits = await search.find(query, { scopes: [directory], limit });

  const records: MemoryRecord[] = [];
  for (const hit of hits) {
    if (records.length >= limit) {
      break;
    }
    const uri = Uri.tryParse(hit.uri);
    if (uri === null) {
      logger.warn('预取命中的 URI 不合法，已跳过', { uri: hit.uri, memoryType: schema.type });
      continue;
    }
    const record = await readMemoryRecord(filesystem, logger, uri);
    if (record !== null && record.status === 'active') {
      records.push(record);
    }
  }
  return records;
}
