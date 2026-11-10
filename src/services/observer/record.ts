/**
 * 从磁盘构造节点自身那一行 `IndexRecord`（§7：文件是真相，索引是派生）。
 *
 * ## 为什么从磁盘读回，不用调用方的参数
 *
 * `write` / `mkdir` 的入参只是「请求」，写成功之后磁盘才是真相：`write` 会在正文
 * 前面拼回 frontmatter，`mkdir` 会把父目录一并建出来。用入参构造 `IndexRecord` 等于
 * 索引里存一份调用方以为的内容，`bodyDigest` 与 `SummaryService.#bodyDigest` 的
 * 比较会永远不等，每次写都触发一次假失效。
 *
 * ## 这里只写「节点自身那一行」
 *
 * 一个目录在索引里最多两行（§8.5、`0004_node_level_rows.sql`）：L0 行是节点自身
 * 的行（`abstract` = L0 摘要），L1 行是概览正文的附加检索行。观察者只写 L0 行——
 * 它拿不到概览正文（概览由 `SummaryService` 生成、落盘、再写索引），写 L1 行等于
 * 每次 `mkdir` 都把概览抹掉。
 *
 * 两条写入路径的 `level` 必须一致：`SummaryService.#indexRecord` 也写 L0 并保留
 * 已有行的 level，否则第一次生成摘要之后 level 会从 L2 悄悄变成 L0，L1 行也会与
 * 它错位。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { ContextType } from '../../domain/node.js';
import { contextTypeOf, stableDigest } from '../../domain/node.js';
import type { IndexRecord } from '../../domain/retrieval.js';
import { Uri } from '../../domain/uri.js';

import {
  EMPTY_FRONTMATTER_FIELDS,
  parseFrontmatterFields,
  type FrontmatterFields,
} from './frontmatter.js';
import { errorMessage } from '../../domain/errors.js';

import type { IndexObserverDeps } from './ports.js';

/** 文件是可检索的原文（§8.5 的 L2）；目录是它的 L0 摘要（见文件头）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';

export type RecordPorts = Pick<IndexObserverDeps, 'store' | 'nodes' | 'logger'>;

/**
 * 目标路径整棵子树的索引记录。
 *
 * 从磁盘读（§7：文件是真相），与写路径用同一套 `documentRecord` /
 * `directoryRecord`，保证移动后的行与「在新路径上写一次」完全一致。
 * `ContentStore.list` 已经跳过临时文件、锁文件与元数据产物，不需要再过滤一遍。
 *
 * 读盘失败时返回 `null` 而不是空数组：空数组会把整棵子树的索引**删掉**再什么
 * 都不写，比保留旧行（至少 `reindex` 能修）更糟。
 */
export async function subtreeRecords(
  ports: RecordPorts,
  root: Uri,
  details: Readonly<Record<string, string>>,
): Promise<readonly IndexRecord[] | null> {
  const records: IndexRecord[] = [];
  try {
    await collectRecords(ports, root, records);
  } catch (error) {
    ports.logger.error('节点移动后读取目标子树失败，索引未重建。', {
      ...details,
      error: errorMessage(error),
    });
    return null;
  }
  return records;
}

async function collectRecords(
  ports: RecordPorts,
  uri: Uri,
  records: IndexRecord[],
): Promise<void> {
  const stat = await ports.store.stat(uri);
  if (stat === null) {
    return;
  }
  const contextType = contextTypeOf(uri);
  records.push(
    stat.kind === 'file'
      ? await documentRecord(ports, uri, contextType, stat.size, stat.updatedAt)
      : directoryRecord(ports, uri, contextType, stat.size, stat.updatedAt),
  );
  if (stat.kind !== 'directory') {
    return;
  }
  for (const child of await ports.store.list(uri)) {
    await collectRecords(ports, child.uri, records);
  }
}

export async function documentRecord(
  ports: RecordPorts,
  uri: Uri,
  contextType: ContextType,
  size: number,
  updatedAt: string,
): Promise<IndexRecord> {
  const document = await ports.store.readText(uri);
  const fields = await readFrontmatterFields(ports.store, uri, contextType);
  const existing = ports.nodes.get(uri.toString());
  // 记忆文件的 `status` 键存在但值非法：整份文档按不可解析的记忆处理。
  // **不能保留索引旧值**：那会让索引与文件永久分叉（文件读作不存在、`find`
  // 仍按旧的 pending/active 返回）。落法与「`memories/` 下手放的普通 Markdown」
  // 相同：`memory_type = NULL`、`status = active`，由路径口径决定它仍是 memory。
  const invalidStatus = contextType === 'memory' && fields.status.kind === 'invalid';
  if (invalidStatus) {
    ports.logger.warn('记忆文件的 status 不是合法状态，按不可解析的记忆文件处理', {
      uri: uri.toString(),
    });
  }

  return {
    uri: uri.toString(),
    parentUri: uri.parent()?.toString() ?? '',
    scope: uri.scope,
    kind: 'document',
    contextType,
    // frontmatter 是记忆类型的唯一真相；读不出来时保留索引里的旧值（重写一个
    // 没有 frontmatter 的文件不应该把 memory_type 抹掉）。`status` 非法时例外：
    // 那是整份文档不可解析，旧类型跟着一起作废。
    memoryType: invalidStatus ? null : (fields.memoryType ?? existing?.memoryType ?? null),
    level: DOCUMENT_LEVEL,
    abstract: document.frontmatter?.summary ?? null,
    content: document.text,
    bodyDigest: stableDigest(document.text),
    size,
    updatedAt,
    // 复核闸门（§11.6）在 frontmatter 的 status 上。缺键 = active（历史文件）；
    // 非记忆文件没有这个语义，保留索引旧值（它们不参与复核闸门）。
    status:
      contextType === 'memory'
        ? fields.status.kind === 'value'
          ? fields.status.value
          : 'active'
        : (existing?.status ?? 'active'),
    // 有效期从 frontmatter 读，**不做「保留索引旧值」的兜底**：缺键 / 不可解析
    // 就是无界。保留旧值会让一条删掉 `valid_until` 的记忆永远停在旧终点上，
    // 而「缺键 = 一直有效」是这一步的约定。
    validFrom: fields.validFrom,
    validUntil: fields.validUntil,
  };
}

export function directoryRecord(
  ports: RecordPorts,
  uri: Uri,
  contextType: ContextType,
  size: number,
  updatedAt: string,
): IndexRecord {
  const existing = ports.nodes.get(uri.toString());
  return {
    uri: uri.toString(),
    parentUri: uri.parent()?.toString() ?? '',
    scope: uri.scope,
    kind: 'directory',
    contextType: existing?.contextType ?? contextType,
    memoryType: existing?.memoryType ?? null,
    level: DIRECTORY_LEVEL,
    // 目录自身这一行的可检索文本是它的 L0 摘要，由 `SummaryService` 写；目录本身
    // 没有正文。概览正文走另一行（L1，见文件头），这里写空不会碰到它：
    // `upsert` 的冲突键是 `(uri, level)`。
    abstract: null,
    content: '',
    bodyDigest: stableDigest(''),
    size,
    updatedAt,
    status: existing?.status ?? 'active',
  };
}

/**
 * 记忆文件的 `memory_type` / `status` / `valid_from` / `valid_until`。
 *
 * 只有 `contextType === 'memory'` 的文件才有这几个键，其它文件连原始字节都不用
 * 再读一遍——`readText` 已经把正文与摘要拿回来了。
 */
async function readFrontmatterFields(
  store: ContentStore,
  uri: Uri,
  contextType: ContextType,
): Promise<FrontmatterFields> {
  if (contextType !== 'memory') {
    return EMPTY_FRONTMATTER_FIELDS;
  }
  const bytes = await store.readBytes(uri);
  return parseFrontmatterFields(Buffer.from(bytes).toString('utf8'));
}
