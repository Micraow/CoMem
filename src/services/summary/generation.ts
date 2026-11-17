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
import type { ConversationTextMessage } from '../../domain/conversation.js';
import type { NodeKind } from '../../domain/node.js';
import { digestSummaryInput } from '../../domain/summary-input.js';
import {
  extractAbstract,
  truncateToChars,
  type DirectorySummary,
  type SummaryChild,
  type SummaryGenerator,
  type SummaryInput,
} from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';
import type { AclService } from '../acl.js';

import { isArchiveRoot, readArchiveConversation } from './dialogue.js';
import type { SummaryServiceConfig } from './ports.js';

/** 生成一个目录概览所需的端口。 */
export interface SummaryGenerationPorts {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly nodes: Pick<NodeRepository, 'get'>;
  readonly acl: Pick<AclService, 'hasIndependentAcl'>;
  readonly generator: SummaryGenerator;
  readonly config: SummaryServiceConfig;
}

/** 列一个目录的直接子项所需的端口。 */
type SummaryChildPorts = Pick<
  SummaryGenerationPorts,
  'store' | 'metadata' | 'nodes' | 'config' | 'acl'
>;

export interface GeneratedDirectorySummary {
  readonly summary: DirectorySummary;
  /** 生成这份摘要时模型看到目录输入的稳定 digest。 */
  readonly inputDigest: string;
}

/** 已读取的目录输入；同一份对象随后交给生成器，避免比较与生成读到两份输入。 */
export interface PreparedSummaryInput {
  readonly input: SummaryInput;
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
async function summarizeWithInput(
  ports: SummaryGenerationPorts,
  directoryUri: Uri,
): Promise<GeneratedDirectorySummary> {
  return generatePreparedSummary(
    ports,
    await prepareSummaryInput(ports, directoryUri),
  );
}

/** 读取并规范化目录输入，不调用生成器。 */
export async function prepareSummaryInput(
  ports: SummaryChildPorts,
  directoryUri: Uri,
): Promise<PreparedSummaryInput> {
  const { children, inputDigest, sourceText, dialogue } = await readSummaryInput(ports, directoryUri);
  return {
    input: { uri: directoryUri, children, sourceText, dialogue },
    inputDigest,
  };
}

/** 用已经读取的输入生成摘要，确保 digest 与生成器收到的内容一致。 */
export async function generatePreparedSummary(
  ports: Pick<SummaryGenerationPorts, 'generator' | 'config'>,
  prepared: PreparedSummaryInput,
): Promise<GeneratedDirectorySummary> {
  const generated = await ports.generator.generate({
    ...prepared.input,
  });

  const overview = truncateToChars(generated.overview, ports.config.overviewMaxChars);
  // L0 从 L1 提取（§9.1）：两层各生成一遍必然互相矛盾。
  const abstract = truncateToChars(
    extractAbstract(overview),
    ports.config.abstractMaxChars,
  );
  return {
    summary: { abstract, overview, degraded: generated.degraded },
    inputDigest: prepared.inputDigest,
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
): Promise<{
  readonly children: readonly SummaryChild[];
  readonly sourceText: string | undefined;
  readonly dialogue: readonly ConversationTextMessage[] | undefined;
  readonly inputDigest: string;
}> {
  const entries = await ports.store.list(directoryUri);
  const children: SummaryChild[] = [];
  for (const entry of entries) {
    const indexed = ports.nodes.get(entry.uri.toString());
    // 子目录有自己的 ACL 文件时，摘要不能把它的 L0 带进父目录。这样受限归档即使
    // 使用真实对话生成概览，也不会通过 history / session 的祖先摘要扩大可见范围。
    if (
      entry.kind === 'directory' &&
      await ports.acl.hasIndependentAcl(entry.uri)
    ) {
      continue;
    }
    // 待复核 / 已归档节点不进入目录摘要生成请求，也不进入 digest。正文仍可按 URI
    // 读取；这里遵循检索面只认 active 的同一状态边界。版本文件由 store 提前隐藏。
    if (
      indexed !== null &&
      indexed.contextType === 'memory' &&
      indexed.status !== 'active'
    ) {
      continue;
    }
    const kind: NodeKind = entry.kind === 'directory' ? 'directory' : 'document';
    let abstract: string;
    if (kind === 'directory') {
      abstract = isArchiveRoot(entry.uri)
        ? ''
        : (await ports.metadata.readSummary(entry.uri)).abstract;
    } else {
      abstract = indexed?.abstract ?? '';
    }
    children.push({ uri: entry.uri, name: entry.uri.name, kind, abstract });
  }
  const archiveConversation = await readArchiveConversation(
    ports.store,
    directoryUri,
    ports.config.overviewMaxChars,
  );
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
  const result = {
    uri: directoryUri,
    children,
    sourceText: archiveConversation?.sourceText,
    dialogue: archiveConversation?.dialogue,
  };
  return {
    children,
    sourceText: result.sourceText,
    dialogue: result.dialogue,
    inputDigest: digestSummaryInput(result),
  };
}
