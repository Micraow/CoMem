/**
 * 生成一个目录的 L0 + L1（§9.2）。
 *
 * 自底向上：叶子目录 → 父目录 → … → `rootUri`。一个目录的 L1 输入是「直接子文件的
 * 摘要」+「直接子目录的 L0 正文」。**L0 从 L1 提取**（`extractAbstract`），不让模型
 * 分别生成两层——两层各写一遍必然互相矛盾。
 *
 * 本文件只生成、不落盘：慢操作（`generator.generate`，一次 7–9 秒的模型调用）必须
 * 待在目录锁外（§10.6）。落盘在 `persist.ts`，两段锁的编排在 `invalidate.ts`。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import { stableDigest, type NodeKind } from '../../domain/node.js';
import {
  extractAbstract,
  truncateToChars,
  type DirectorySummary,
  type SummaryChild,
  type SummaryGenerator,
} from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import type { SummaryServiceConfig } from './ports.js';

/** 生成一个目录概览所需的端口。 */
export interface SummaryGenerationPorts {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly nodes: Pick<NodeRepository, 'get'>;
  readonly generator: SummaryGenerator;
  readonly config: SummaryServiceConfig;
}

/** 列一个目录的直接子项所需的端口。 */
type SummaryChildPorts = Pick<SummaryGenerationPorts, 'store' | 'metadata' | 'nodes'>;

export interface GeneratedDirectorySummary {
  readonly summary: DirectorySummary;
  /** 生成这份摘要时模型看到目录输入的稳定 digest。 */
  readonly inputDigest: string;
}

/**
 * 生成一个目录的 L0 + L1（**只生成，不落盘**，§9.2）。
 *
 * 拆成「生成」与「落盘」两步是为了让慢操作（`generator.generate`）待在锁外：
 * `invalidate.ts` 的 `invalidateDirectory` 在锁外调本函数，拿到结果后再进锁调
 * `persistSummary`。显式全量重建读目录列表本身在锁外，本函数后直接落盘即可。
 *
 * 预算在服务这一层执行：换任何生成器实现都不会超。
 */
export async function summarize(
  ports: SummaryGenerationPorts,
  directoryUri: Uri,
): Promise<DirectorySummary> {
  return (await summarizeWithInput(ports, directoryUri)).summary;
}

/**
 * 生成摘要并返回输入 digest。
 *
 * 同一目录的生成在模型调用之外进行。期间到达的重复通知可以比较当前输入与
 * 已完成生成的输入：digest 相同说明那次生成已经覆盖了它们，不必再打一次模型。
 */
export async function summarizeWithInput(
  ports: SummaryGenerationPorts,
  directoryUri: Uri,
): Promise<GeneratedDirectorySummary> {
  const { children, inputDigest } = await readSummaryInput(ports, directoryUri);
  const generated = await ports.generator.generate({ uri: directoryUri, children });

  const overview = truncateToChars(generated.overview, ports.config.overviewMaxChars);
  // L0 从 L1 提取（§9.1）：两层各生成一遍必然互相矛盾。
  const abstract = truncateToChars(
    extractAbstract(overview),
    ports.config.abstractMaxChars,
  );
  return {
    summary: { abstract, overview, degraded: generated.degraded },
    inputDigest,
  };
}

/** 当前目录摘要输入的 digest；不调用生成器。 */
export async function summaryInputDigest(
  ports: SummaryGenerationPorts,
  directoryUri: Uri,
): Promise<string> {
  return (await readSummaryInput(ports, directoryUri)).inputDigest;
}

/**
 * L1 的输入：直接子文件的摘要 + 直接子目录的 L0 正文（§9.2）。
 *
 * 子项从磁盘列，不从索引列：磁盘是真相，索引可能落后（§7）。文件摘要取索引里的
 * `abstract`（§9.1 明确它作为父目录 L1 的输入），目录摘要取 `.abstract.md` 正文。
 */
async function readSummaryInput(
  ports: SummaryChildPorts,
  directoryUri: Uri,
): Promise<{ readonly children: readonly SummaryChild[]; readonly inputDigest: string }> {
  const entries = await ports.store.list(directoryUri);
  const children: SummaryChild[] = [];
  for (const entry of entries) {
    const kind: NodeKind = entry.kind === 'directory' ? 'directory' : 'document';
    const abstract =
      kind === 'directory'
        ? (await ports.metadata.readSummary(entry.uri)).abstract
        : (ports.nodes.get(entry.uri.toString())?.abstract ?? '');
    children.push({ uri: entry.uri, name: entry.uri.name, kind, abstract });
  }
  // ContentStore 已按名称排序；这里仍显式规范化，避免未来端口实现或并发列目录
  // 让同一组子项因顺序不同算出不同 digest、再触发无意义的追加摘要。
  children.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri < rightUri) return -1;
    if (leftUri > rightUri) return 1;
    return 0;
  });
  return {
    children,
    inputDigest: stableDigest(JSON.stringify({
      uri: directoryUri.toString(),
      children: children.map((child) => ({
        uri: child.uri.toString(),
        name: child.name,
        kind: child.kind,
        abstract: child.abstract,
      })),
    })),
  };
}
