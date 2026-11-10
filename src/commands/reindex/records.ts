/**
 * 从磁盘内容构造索引记录：frontmatter 的字段映射与 `IndexRecord` 的拼装。
 *
 * 失败抛 `ComemError`（坏 frontmatter、读盘失败等），由调用方按节点记 `failed`。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { ParsedDocument } from '../../adapters/fs/frontmatter.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { NodeRow } from '../../adapters/sqlite/node-repository.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { contextTypeOf, stableDigest } from '../../domain/node.js';
import type { NodeStatus } from '../../domain/node.js';
import type { IndexRecord } from '../../domain/retrieval.js';
import { frontmatterFieldsOf, parseFrontmatterFields } from '../../services/memory/frontmatter.js';

import type { DiskNode } from './walk.js';

/** 文件是 L2 原文；目录自身是 L0 摘要（§8.5）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';
/** 目录概览行的层级（§8.5）：概览正文作为一条独立的检索行重建。 */
const OVERVIEW_LEVEL = 'L1';

const ACTIVE_STATUS: NodeStatus = 'active';

/**
 * 从磁盘重建一个节点的 `IndexRecord`（目录可能两条）。失败抛 `ComemError`
 * （坏 frontmatter 等）。
 *
 * 目录有摘要文件时返回两行：L0（`abstract` = L0 摘要）与 L1（`content` = 概览正文）。
 * 与写路径一致——概览正文是目录最丰富的那段可检索文本，重建索引时它同样从
 * `.overview.md` 里读出来，不能让 `reindex` 之后只有写路径生成过的目录才搜得到概览。
 *
 * 没有摘要文件时只返回 L0 行。此时磁盘上就没有概览可索引，残留的 L1 行会在下一次
 * 摘要生成时被覆盖（`SummaryService.#persistSummary` 两行一起写）。
 */
export async function buildRecords(
  store: ContentStore,
  metadata: MetadataFileStore,
  logger: Logger,
  node: DiskNode,
  existing: NodeRow | null,
  /**
   * 文件节点已经解析好的磁盘内容；目录节点传 `null`。
   *
   * 由调用方读一次再传进来，因为同一份字节这次还要喂给向量与 `sources` 两条重建
   * 路径——三处各读一次会把「重扫一遍磁盘」变成随机读放大。
   */
  document: ParsedDocument | null,
  /**
   * 文件的原始字节（UTF-8）；目录节点传 `null`。
   *
   * 记忆文件的字段判定必须与 `read` / 索引观察者走同一个子集解析器：通用 YAML
   * 解析器比记忆格式宽松（单引号、内联注释），同一份手改文件会在 `read` 里是
   * 「不可解析」、在重建里是另一个 `status`。非记忆文件没有这条口径，继续用
   * `document.data`（通用 YAML 的记录）。
   */
  text: string | null,
): Promise<readonly IndexRecord[]> {
  const stat = await store.stat(node.uri);
  if (stat === null) {
    throw new ComemError('NOT_FOUND', `磁盘上的节点已不可寻址：${node.uri.toString()}`, {
      uri: node.uri.toString(),
    });
  }

  const contextType = contextTypeOf(node.uri);
  const parentUri = node.uri.parent()?.toString() ?? '';

  if (node.kind === 'directory') {
    const summary = await metadata.readSummary(node.uri);
    const base: IndexRecord = {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextType,
      memoryType: existing?.memoryType ?? null,
      level: DIRECTORY_LEVEL,
      abstract: summary.abstract === '' ? null : summary.abstract,
      content: '',
      bodyDigest: stableDigest(''),
      size: stat.size,
      updatedAt: stat.updatedAt,
      status: existing?.status ?? ACTIVE_STATUS,
    };
    if (summary.overview === '') {
      return [base];
    }
    return [
      base,
      {
        ...base,
        level: OVERVIEW_LEVEL,
        content: summary.overview,
        bodyDigest: stableDigest(summary.overview),
      },
    ];
  }

  if (document === null) {
    // 调用方约束：文件节点必须先把磁盘内容读出来。
    throw new ComemError('INTERNAL', '文件节点缺少磁盘解析结果。', { uri: node.uri.toString() });
  }
  const fields =
    contextType === 'memory' && text !== null
      ? parseFrontmatterFields(text)
      : frontmatterFieldsOf(document.data);
  const summary = document.data['summary'];
  // 与 `IndexObserver` 同一处置：记忆文件的 `status` 键存在但值非法时整份文档按
  // 不可解析的记忆处理，`memory_type = NULL`、`status = active`。保留旧值会让重建
  // 把「文件已经不可读」重写成「它仍是上次那条记忆」——索引与磁盘永久分叉。
  const invalidStatus = contextType === 'memory' && fields.status.kind === 'invalid';
  if (invalidStatus) {
    logger.warn('记忆文件的 status 不是合法状态，按不可解析的记忆文件处理', {
      uri: node.uri.toString(),
    });
  }

  return [
    {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'document',
      contextType,
      // frontmatter 是记忆类型的唯一真相；读不出来时保留索引里的旧值。
      // `status` 非法时例外：那是整份文档不可解析，旧类型跟着一起作废。
      memoryType: invalidStatus ? null : (fields.memoryType ?? existing?.memoryType ?? null),
      level: DOCUMENT_LEVEL,
      abstract: typeof summary === 'string' && summary !== '' ? summary : null,
      content: document.body,
      bodyDigest: stableDigest(document.body),
      size: stat.size,
      updatedAt: stat.updatedAt,
      // 记忆文件：缺键 = active（历史文件），合法值照用，非法值已在上面按不可解析
      // 处理成 active。非记忆文件没有复核闸门语义，维持「保留索引旧值」。
      status:
        contextType === 'memory'
          ? fields.status.kind === 'value'
            ? fields.status.value
            : ACTIVE_STATUS
          : (fields.status.kind === 'value'
              ? fields.status.value
              : (existing?.status ?? ACTIVE_STATUS)),
      // 有效期**不保留索引旧值**：磁盘是真相，缺键就是无界（与写路径同一个口径）。
      validFrom: fields.validFrom,
      validUntil: fields.validUntil,
    },
  ];
}
