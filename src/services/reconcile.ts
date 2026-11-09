/**
 * 对账日志重放（架构文档 §10.6「索引双写补偿」）。
 *
 * `_meta/reconcile.log` 里的记录来自「文件已经落盘、派生数据没写成」：索引批量
 * 写入失败，或权限物化失败。文件是真相，所以恢复方向是**把派生数据追上来**，
 * 不是回滚文件。
 *
 * ## 重放什么
 *
 * | `op` | 动作 | 幂等依据 |
 * |---|---|---|
 * | `index` | 从磁盘重建一条 `IndexRecord`，再 `index.upsert` | `ON CONFLICT(uri, level)` 覆盖 + 同事务删旧 FTS 行 |
 * | `permission` | `AclService.materializeNode(uri)` | `node_permission` 先删该 URI 的行再写，结果只由 `.acl.json` 决定 |
 *
 * `write` / `attachment` 的失败记录没有可重放的输入（正文或原始字节不在日志里），
 * 保留不动并记一条 warn。把它们一起删掉会让「这里失败过」这个唯一线索消失。
 *
 * ## 已经不存在 / 换了类型的目标
 *
 * URI 在磁盘上没了，按「已解决」移出：失败的是一次已经不存在的写入，重试没有
 * 意义，也不该让它永远占着日志。目标是目录（原文件被同名目录替换）同理——原文档
 * 已经没了，按文档重建索引只会得到 EISDIR。
 *
 * ## 坏记录不挡路
 *
 * 解析失败或缺字段的行由适配层报出来，这里逐条 warn 后跳过；重写日志时丢掉。
 * 一条坏行不能让后面的记录永远重放不到。
 *
 * ## 日志清理与并发
 *
 * 成功的条目不是「原地标记」，而是重写日志只保留未解决的（见适配层的原子重写）。
 * 重放期间新追加的记录由适配层在重写前重新读取文件来保住——不能拿重放开始时的
 * 快照覆盖。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { Logger } from '../domain/log.js';
import { contextTypeOf, stableDigest } from '../domain/node.js';
import {
  reconcileEntryKey,
  replayableOpOf,
  type ReconcileLogSnapshot,
} from '../domain/reconcile.js';
import type { IndexRecord, RetrievalIndex } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';

import type { AclService } from './acl.js';
import { parseFrontmatterFields } from './index-observer.js';
import { skillIndexRecord } from './skill.js';

/** 资源文件的索引层级（与 `ResourceService` 一致，§9.1）。 */
const RESOURCE_LEVEL = 'L2';

/** 单条索引重放的结果。 */
type IndexReplayOutcome =
  | { readonly kind: 'indexed' }
  /** 读之前文件没了（重放过程中被删） */
  | { readonly kind: 'missing' }
  /** 同名位置已经是目录，原文档不存在 */
  | { readonly kind: 'not-a-file' };

export interface ReconcileCompactResult {
  readonly kept: number;
  readonly removed: number;
  readonly corruptDropped: number;
}

/**
 * 服务层只需要读与重写两个能力。具体实现是 `adapters/fs/reconcile-log.ts`，
 * 由 bootstrap 注入——services 不能直接 import `node:fs`（§4.2）。
 */
export interface ReconcileLogPort {
  read(): Promise<ReconcileLogSnapshot>;
  compact(resolvedKeys: ReadonlySet<string>): Promise<ReconcileCompactResult>;
}

export interface ReconcileServiceDeps {
  readonly store: ContentStore;
  readonly index: RetrievalIndex;
  /** 权限重放不经过 `Authorizer`：物化只写派生表，不需要请求身份。 */
  readonly acl: Pick<AclService, 'materializeNode'>;
  /** 重建索引时保留已有的 `context_type` / `memory_type` / `status`。 */
  readonly nodes: Pick<NodeRepository, 'get'>;
  readonly log: ReconcileLogPort;
  readonly logger: Logger;
}

export interface ReconcileReplayResult {
  /** 读到的有效记录数 */
  readonly scanned: number;
  /** 成功重放或目标已不存在的记录数 */
  readonly resolved: number;
  /** 重放失败、仍留在日志里的记录数 */
  readonly failed: number;
  /** 可解析但无法重放的记录数（`write` / `attachment`） */
  readonly unsupported: number;
  /** 解析失败或缺字段、被丢弃的行数 */
  readonly corrupt: number;
  /** 重写后文件里剩下的有效记录数（含本轮期间新追加的） */
  readonly remaining: number;
  /** 重写是否成功；失败时已解决的条目会在下一轮再执行一次（幂等） */
  readonly compacted: boolean;
}

const NOTHING_TO_DO: ReconcileReplayResult = Object.freeze({
  scanned: 0,
  resolved: 0,
  failed: 0,
  unsupported: 0,
  corrupt: 0,
  remaining: 0,
  compacted: true,
});

export class ReconcileService {
  readonly #store: ContentStore;
  readonly #index: RetrievalIndex;
  readonly #acl: Pick<AclService, 'materializeNode'>;
  readonly #nodes: Pick<NodeRepository, 'get'>;
  readonly #log: ReconcileLogPort;
  readonly #logger: Logger;
  /**
   * `write` / `attachment` 的 warn 每个进程只打一次。
   *
   * 这类记录没有可重放的输入，会永远留在日志里；调度器每 30 秒重放一次，如果每次都
   * warn，一天就是几千行，真正需要处理的新失败会被埋掉。首轮（启动时）一定会打，
   * 之后的轮次只在 `debug` 摘要里保留计数。
   */
  #warnedUnsupported = false;

  constructor(deps: ReconcileServiceDeps) {
    this.#store = deps.store;
    this.#index = deps.index;
    this.#acl = deps.acl;
    this.#nodes = deps.nodes;
    this.#log = deps.log;
    this.#logger = deps.logger;
  }

  /**
   * 重放一轮。**不抛错**：启动扫描与调度器都不该被一条修不了的记录打断。
   *
   * 返回计数供调用方写进已有的日志行（启动日志 / 调度轮次摘要），不另造指标。
   */
  async replay(): Promise<ReconcileReplayResult> {
    let snapshot: ReconcileLogSnapshot;
    try {
      snapshot = await this.#log.read();
    } catch (error) {
      this.#logger.error('对账日志读取失败，本轮不重放。', { error: errorMessage(error) });
      return { ...NOTHING_TO_DO, compacted: false };
    }

    for (const corrupt of snapshot.corrupt) {
      this.#logger.warn('对账日志记录已损坏，跳过。', {
        line: corrupt.line,
        reason: corrupt.reason,
      });
    }

    const resolvedKeys = new Set<string>();
    const unsupportedOps = new Map<string, number>();
    let resolved = 0;
    let failed = 0;
    let unsupported = 0;

    for (const entry of snapshot.entries) {
      const op = replayableOpOf(entry);
      if (op === null) {
        unsupported += 1;
        unsupportedOps.set(entry.op, (unsupportedOps.get(entry.op) ?? 0) + 1);
        continue;
      }

      const uri = Uri.tryParse(entry.uri);
      if (uri === null) {
        // URI 本身不合法：这条记录不可能修好任何东西，按已解决移出。
        this.#logger.warn('对账记录的 URI 不合法，视为已解决。', {
          op: entry.op,
          uri: entry.uri,
        });
        resolved += 1;
        resolvedKeys.add(reconcileEntryKey(entry));
        continue;
      }

      let exists: boolean;
      try {
        exists = (await this.#store.stat(uri)) !== null;
      } catch (error) {
        failed += 1;
        this.#logger.warn('对账记录检查目标失败，保留待下次重试。', {
          op,
          uri: entry.uri,
          error: errorMessage(error),
        });
        continue;
      }

      if (!exists) {
        this.#logger.debug('对账记录的目标已不存在，视为已解决。', {
          op,
          uri: entry.uri,
        });
        resolved += 1;
        resolvedKeys.add(reconcileEntryKey(entry));
        continue;
      }

      try {
        if (op === 'index') {
          const outcome = await this.#reindex(uri);
          if (outcome.kind === 'not-a-file') {
            this.#logger.warn('对账记录的目标已不是文件，视为已解决。', { uri: entry.uri });
            resolved += 1;
            resolvedKeys.add(reconcileEntryKey(entry));
            continue;
          }
          if (outcome.kind === 'missing') {
            resolved += 1;
            resolvedKeys.add(reconcileEntryKey(entry));
            continue;
          }
        } else {
          await this.#acl.materializeNode(uri);
        }
        resolved += 1;
        resolvedKeys.add(reconcileEntryKey(entry));
        this.#logger.debug('对账记录重放成功。', { op, uri: entry.uri });
      } catch (error) {
        failed += 1;
        this.#logger.warn('对账记录重放失败，保留待下次重试。', {
          op,
          uri: entry.uri,
          error: errorMessage(error),
        });
      }
    }

    let compacted = false;
    let remaining: number;
    try {
      const result = await this.#log.compact(resolvedKeys);
      compacted = true;
      remaining = result.kept;
    } catch (error) {
      // 重写失败不等于重放失败：已解决的操作本身是幂等的，下次再执行一次没有副作用。
      this.#logger.error('对账日志重写失败，已解决的条目会在下次重放时再执行一次。', {
        error: errorMessage(error),
      });
      // 重写失败时文件里还是这一轮读到的全部条目（外加期间新追加的）。报已知下界，
      // 不要用「总数 - 已解决」——那些已解决的条目其实还留在文件里。
      remaining = snapshot.entries.length;
    }

    if (unsupported > 0 && !this.#warnedUnsupported) {
      this.#warnedUnsupported = true;
      this.#logger.warn('对账日志里有无法重放的记录，已保留待人工处理。', {
        count: unsupported,
        ops: Object.fromEntries(unsupportedOps),
      });
    }

    const summary = {
      scanned: snapshot.entries.length,
      resolved,
      failed,
      unsupported,
      corrupt: snapshot.corrupt.length,
      remaining,
    };
    if (summary.scanned === 0 && summary.corrupt === 0) {
      this.#logger.debug('对账日志为空，无需重放。', {});
    } else if (failed > 0) {
      this.#logger.warn('对账重放完成，仍有记录未解决。', summary);
    } else if (resolved > 0 || summary.corrupt > 0) {
      this.#logger.info('对账重放完成。', summary);
    } else {
      // 只剩无法重放的记录：首轮已经 warn 过，轮询时闭嘴，计数留在 debug。
      this.#logger.debug('对账日志里只剩无法重放的记录。', summary);
    }

    return { ...summary, compacted };
  }

  /**
   * 从磁盘重建一条文件的索引记录。
   *
   * **技能走共享实现**：`context_type === 'skill'` 时由 `skillIndexRecord` 构造，
   * 与 `SkillService.addSkill` 调用的是同一个函数（§10.6）。不做这一层分流，重放器
   * 会按通用资源口径读 frontmatter 的 `summary`，而技能写路径写的是 `description`
   * ——「重放成功」之后技能的索引行与原状态不同，重放就不再是「恢复原样」。
   *
   * 其余文件与写路径的 `toIndexRecord` 对齐：正文是去掉 frontmatter 的文本，
   * `abstract` 是 frontmatter 的 `summary`，层级固定 L2。`context_type` /
   * `memory_type` / `status` 优先取索引里的旧行——重放是「补写丢掉的派生数据」，
   * 不该顺手改写已有元数据。
   *
   * **有效区间必须从 frontmatter 重放**（W98）。它不取旧行：索引行丢了就是丢了，
   * 而 `valid_until` 一旦重放成 NULL 就等于「永远有效」，一份已经失效的历史版本
   * 会在重放之后重新出现在 `find` 里。解析复用写路径的 `parseFrontmatterFields`
   * （`services/index-observer.ts`），不在这里写第四份——两份口径一旦不同，
   * 「哪一版有效」会取决于谁最后写了索引。
   *
   * 二进制（严格 UTF-8 解码失败）按附件处理：正文为空。附件写路径本来就不索引
   * 字节内容；把解码出来的替换字符写进 FTS 只会污染检索。
   */
  async #reindex(uri: Uri): Promise<IndexReplayOutcome> {
    const stat = await this.#store.stat(uri);
    if (stat === null) {
      return { kind: 'missing' };
    }
    if (stat.kind !== 'file') {
      return { kind: 'not-a-file' };
    }

    const existing = this.#nodes.get(uri.toString());
    const contextType = existing?.contextType ?? contextTypeOf(uri);
    const bytes = await this.#store.readBytes(uri);

    if (contextType === 'skill') {
      await this.#index.upsert([
        skillIndexRecord({
          uri,
          bytes,
          updatedAt: stat.updatedAt,
          memoryType: existing?.memoryType ?? null,
          status: existing?.status ?? 'active',
        }),
      ]);
      return { kind: 'indexed' };
    }

    const base = {
      uri: uri.toString(),
      parentUri: uri.parent()?.toString() ?? '',
      scope: uri.scope,
      kind: 'document' as const,
      contextType,
      memoryType: existing?.memoryType ?? null,
      level: RESOURCE_LEVEL,
      status: existing?.status ?? 'active',
    } satisfies Omit<IndexRecord, 'abstract' | 'content' | 'bodyDigest' | 'size' | 'updatedAt'>;

    const text = decodeText(bytes);
    if (text === null) {
      await this.#index.upsert([
        {
          ...base,
          abstract: null,
          content: '',
          bodyDigest: stableDigest(''),
          size: bytes.byteLength,
          updatedAt: stat.updatedAt,
        },
      ]);
      return { kind: 'indexed' };
    }

    const document = await this.#store.readText(uri);
    // 只有记忆文件 frontmatter 里才有 `valid_*`；其它文件读原始字节没有意义。
    const validity = contextType === 'memory' ? parseFrontmatterFields(text) : null;
    await this.#index.upsert([
      {
        ...base,
        abstract: document.frontmatter?.summary ?? null,
        content: document.text,
        bodyDigest: stableDigest(document.text),
        size: Buffer.byteLength(document.text, 'utf8'),
        updatedAt: document.stat.updatedAt,
        validFrom: validity?.validFrom ?? null,
        validUntil: validity?.validUntil ?? null,
      },
    ]);
    return { kind: 'indexed' };
  }
}

/** 严格 UTF-8 解码；二进制返回 `null`（与 `ResourceService.decodeText` 同一判定）。 */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
