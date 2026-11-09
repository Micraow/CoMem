/**
 * 资源摄取（架构文档 §6.5、§10.6、§13）。
 *
 * `add_resource` 是两步协议：先 `stageUpload` 把二进制附件传进临时目录拿到
 * `uploadId`，再 `addResource` 把「规范化文本 + 原始附件」一起落盘。原始附件必须
 * 保留——`download` 按 URI 直接读它；规范化文本是独立文件，带 frontmatter 摘要。
 *
 * ## 批量路径（§10.6 的性能验收点）
 *
 * 100 个文件不能循环调 `filesystem.write`：那会做 100 次索引事务、200 次摘要失效
 * 标记（每个文件的父目录各标一次，其中大量重复）。正确路径是：
 *
 * 1. 先把每个输入解析成目标 URI；
 * 2. 在持有目标目录 `TREE` 锁的窗口里写全部文件，然后用**一次**
 *    `index.upsert(records)` 写索引（`SqliteFtsIndex.upsert` 内部就是一个事务）；
 * 3. 锁释放后按「父目录」去重投递摘要失效，每个目录一次，而不是每个文件一次。
 *
 * **摘要失效为什么在锁外。** `SummaryService` 会为目标目录再拿 `EXACT` 锁；本服务
 * 持有父目录的 `TREE` 锁时两者互斥，在锁内调用会等到 `CONFLICT`。§10.6 的
 * 「提交后统一投递」也是这个顺序。
 *
 * ## 部分失败
 *
 * 单个文件写失败只进 `skipped`，其余继续。索引批量写是全有全无：失败时不回滚已经
 * 落盘的文件（§10.6「索引双写补偿」——文件已经是对的，回滚反而丢数据），把失败的
 * URI 追加到 `_meta/reconcile.log` 等重放。
 *
 * ## 为什么文件系统操作走端口
 *
 * `services/` 不能 import `node:fs`（§4.2 的分层规则），而临时上传目录与
 * `_meta/reconcile.log` 都不在 URI 命名空间里，`ContentStore` 表达不了。所以这里
 * 声明 `ResourceStorage` 端口，实例由 bootstrap 注入。测试里用真实临时目录实现。
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { PathLockManager } from '../adapters/fs/lock.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { stableDigest } from '../domain/node.js';
import type { IndexRecord, RetrievalIndex } from '../domain/retrieval.js';
import type { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import type { SummaryService } from './summary.js';
import { invalidateParentSummaries, materializeAncestorPermissions } from './write-through.js';

/**
 * 单文件大小上限默认值：50MB（52,428,800 字节）。
 *
 * 经验值，来源未知：架构文档 §13 没有给数值。选它是因为它同时满足「PDF / 图片
 * 放得下」与「一次上传不会把内存打爆」——`stageUpload` 接收的是完整 `Uint8Array`。
 */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 单个资源最多文件数默认值：1000。
 *
 * 经验值，来源未知：架构文档 §13 没有给数值。§10.6 的验收场景是 100 个文件，
 * 留一个数量级的余量；再高就该拆成多个资源。
 */
export const DEFAULT_MAX_FILES = 1000;

/** `stageUpload` 的返回值。 */
export interface TempUploadResult {
  readonly uploadId: string;
  /** 临时文件绝对路径，调用方不该用，只给日志 */
  readonly tempPath: string;
  readonly size: number;
}

export interface ResourceFileInput {
  /** 相对目标目录的路径，如 `docs/spec.md` */
  readonly path: string;
  /** 二进制附件的上传 ID；没有附件时省略 */
  readonly uploadId?: string;
  /** 规范化后的文本；省略时从附件解码（能解就解，不能就存空） */
  readonly content?: string;
  /** 一句话摘要；省略时不写 frontmatter */
  readonly summary?: string;
}

export interface AddResourceOptions {
  /** 目标目录，如 `comem://user/alice/resources` */
  readonly parentUri: Uri;
  readonly files: readonly ResourceFileInput[];
  readonly subject: string;
  readonly principals: readonly string[];
  /** 单文件大小上限，默认 50MB（经验值，来源未知） */
  readonly maxFileBytes?: number;
  /** 单个资源最多几个文件，默认 1000（经验值，来源未知） */
  readonly maxFiles?: number;
}

export interface AddResourceResult {
  readonly created: readonly Uri[];
  readonly updated: readonly Uri[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** 附件落盘后的 URI */
  readonly attachments: readonly Uri[];
  readonly tokens: { readonly indexed: number; readonly elapsedMs: number };
}

/**
 * 临时上传的元数据。
 *
 * `tempPath` 是绝对路径，只给日志与 `TempUploadResult` 用；调用方不应该拿它做
 * 任何路径运算（URI 才是寻址方式）。
 */
export interface StagedUploadInfo {
  readonly uploadId: string;
  readonly fileName: string | null;
  readonly size: number;
  readonly tempPath: string;
  /** 毫秒时间戳；`sweepStaged` 按它判断是否超时 */
  readonly stagedAtMs: number;
}

export interface StageUploadInput {
  readonly uploadId: string;
  readonly fileName: string | null;
  readonly bytes: Uint8Array;
  readonly stagedAtMs: number;
}

export interface StagedUpload {
  readonly info: StagedUploadInfo;
  readonly bytes: Uint8Array;
}

/** `_meta/reconcile.log` 的一行（架构文档 §10.6「索引双写补偿」）。 */
export interface ReconcileEntry {
  readonly op: string;
  readonly uri: string;
  readonly error: string;
  /** ISO 8601 */
  readonly at: string;
}

/**
 * 数据根下的原始文件访问端口。
 *
 * 只覆盖「URI 命名空间之外的产物」：临时上传目录（`_meta/tmp/`）与对账日志
 * （`_meta/reconcile.log`）。用户内容仍然只经过 `ContentStore`。
 */
export interface ResourceStorage {
  /** 写入一个临时上传，返回绝对路径。 */
  stage(input: StageUploadInput): Promise<string>;
  /** 读回临时上传；不存在（或已清理）返回 `null`。 */
  readStaged(uploadId: string): Promise<StagedUpload | null>;
  /** 全部临时上传，按 `stagedAtMs` 升序。 */
  listStaged(): Promise<readonly StagedUploadInfo[]>;
  /** 删除临时上传；不存在不是错误。 */
  removeStaged(uploadId: string): Promise<void>;
  /** 往 `_meta/reconcile.log` 追加一行。 */
  appendReconcile(entry: ReconcileEntry): Promise<void>;
}

export interface ResourceServiceDeps {
  readonly store: ContentStore;
  readonly locks: PathLockManager;
  readonly index: RetrievalIndex;
  readonly summary: Pick<SummaryService, 'markStale'>;
  /**
   * 写后物化权限（§12.4）。
   *
   * 本服务直接写 `ContentStore`，不经过 `FileSystemService` 的观察者，所以
   * `node_permission` 没有人为新建节点算一遍。`InheritingAuthorizer` 的写路径会先
   * `materializeNode` 再求权，调一次 `assert` 就是「算一遍」。
   */
  readonly authorizer: Authorizer;
  readonly storage: ResourceStorage;
  readonly logger: Logger;
  /** 默认 `DEFAULT_MAX_FILE_BYTES` */
  readonly maxFileBytes?: number;
  /** 默认 `DEFAULT_MAX_FILES` */
  readonly maxFiles?: number;
}

/** 资源文件的索引层级：原文件是 L2（L0 / L1 是目录摘要，§9.1）。 */
const RESOURCE_LEVEL = 'L2';

/** 附件目录名。它是**普通目录名**，不是保留名（§6.5）。 */
const ATTACHMENTS_DIRECTORY = '.attachments';

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 非负整数上限；配置错误时尽早报错，不把「负的上限」解释成「不限制」。 */
function assertLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidArgument(`${name} 必须是正整数。`, { [name]: value });
  }
}

/** 能按 UTF-8 严格解码就返回文本，否则返回空串（§13 的二进制分支）。 */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 相对路径 → 目标 URI。
 *
 * 逐段交给 `Uri.child`：`..`、绝对路径（首段为空）、保留名、控制字符、反斜杠都由
 * 它统一拒绝。字符串拼接会绕过这些规则，而权限按 URI 前缀匹配，一条越界 URI 就是
 * 越权。
 */
function resolveTarget(parentUri: Uri, rawPath: string): Uri {
  return parentUri.child(...rawPath.split('/'));
}

/** 同一批次里重复的 `path` 后者覆盖前者，保留首次出现的位置。 */
function dedupeFiles(
  files: readonly ResourceFileInput[],
  logger: Logger,
): readonly ResourceFileInput[] {
  const indexByPath = new Map<string, number>();
  const result: ResourceFileInput[] = [];
  for (const file of files) {
    const existingIndex = indexByPath.get(file.path);
    if (existingIndex === undefined) {
      indexByPath.set(file.path, result.length);
      result.push(file);
      continue;
    }
    logger.warn('同一批次里出现重复路径，后者覆盖前者。', {
      path: file.path,
      index: existingIndex,
    });
    result[existingIndex] = file;
  }
  return result;
}

/** 附件文件名：只取最后一段，拒绝空段与 `.` / `..`，其余交给 `Uri.child` 校验。 */
function attachmentFileName(raw: string | null, fallback: string): string {
  const candidate = (raw ?? '').split(/[/\\]/).filter((segment) => segment !== '').at(-1) ?? '';
  if (candidate === '' || candidate === '.' || candidate === '..') {
    return basename(fallback);
  }
  return candidate;
}

export class ResourceService {
  readonly #store: ContentStore;
  readonly #locks: PathLockManager;
  readonly #index: RetrievalIndex;
  readonly #summary: Pick<SummaryService, 'markStale'>;
  readonly #authorizer: Authorizer;
  readonly #storage: ResourceStorage;
  readonly #logger: Logger;
  readonly #maxFileBytes: number;
  readonly #maxFiles: number;

  constructor(deps: ResourceServiceDeps) {
    const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
    assertLimit(maxFileBytes, 'maxFileBytes');
    assertLimit(maxFiles, 'maxFiles');

    this.#store = deps.store;
    this.#locks = deps.locks;
    this.#index = deps.index;
    this.#summary = deps.summary;
    this.#authorizer = deps.authorizer;
    this.#storage = deps.storage;
    this.#logger = deps.logger;
    this.#maxFileBytes = maxFileBytes;
    this.#maxFiles = maxFiles;
  }

  /**
   * 第一步：把二进制写进临时目录，返回 `uploadId`。
   *
   * 大小在上传入口校验：等到落盘之后再拒绝，磁盘已经承担了一次完整写入。
   */
  async stageUpload(
    bytes: Uint8Array,
    options: { readonly fileName?: string } = {},
  ): Promise<TempUploadResult> {
    const size = bytes.byteLength;
    if (size > this.#maxFileBytes) {
      throw new ComemError(
        'RESOURCE_EXHAUSTED',
        `文件大小 ${size} 字节超过单文件上限 ${this.#maxFileBytes} 字节。`,
        { size, maxFileBytes: this.#maxFileBytes },
      );
    }

    const uploadId = randomUUID();
    const tempPath = await this.#storage.stage({
      uploadId,
      fileName: options.fileName ?? null,
      bytes,
      stagedAtMs: Date.now(),
    });

    this.#logger.debug('临时上传已落盘', {
      uploadId,
      size,
      tempPath,
      fileName: options.fileName ?? null,
    });
    return { uploadId, tempPath, size };
  }

  /**
   * 第二步：批量导入。
   *
   * 步骤见文件头的「批量路径」。返回值区分新建与覆盖；失败的文件进 `skipped`，
   * 不中断整批。
   */
  async addResource(options: AddResourceOptions): Promise<AddResourceResult> {
    const startedAt = Date.now();
    const maxFiles = options.maxFiles ?? this.#maxFiles;
    const maxFileBytes = options.maxFileBytes ?? this.#maxFileBytes;
    assertLimit(maxFiles, 'maxFiles');
    assertLimit(maxFileBytes, 'maxFileBytes');

    if (options.files.length > maxFiles) {
      throw new ComemError(
        'RESOURCE_EXHAUSTED',
        `本批 ${options.files.length} 个文件超过单个资源上限 ${maxFiles} 个。`,
        { count: options.files.length, maxFiles },
      );
    }

    const files = dedupeFiles(options.files, this.#logger);
    const created: Uri[] = [];
    const updated: Uri[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const attachments: Uri[] = [];
    const written: Uri[] = [];
    const records: IndexRecord[] = [];
    let indexed = 0;
    let indexFailed = false;

    await this.#locks.withLock(options.parentUri, 'tree', async () => {
      for (const file of files) {
        let target: Uri;
        try {
          target = resolveTarget(options.parentUri, file.path);
        } catch (error) {
          // 路径不合法是永久失败，重放也不会成功，所以只进 skipped，不写对账日志。
          skipped.push({ path: file.path, reason: errorMessage(error) });
          this.#logger.warn('资源路径不合法，已跳过。', {
            path: file.path,
            reason: errorMessage(error),
          });
          continue;
        }

        try {
          const staged = await this.#readStaged(file.uploadId);
          const content = file.content ?? (staged === null ? '' : decodeText(staged.bytes));
          this.#assertFileSize(content, staged?.info.size ?? null, maxFileBytes, file.path);

          // 已有的摘要要先读出来：本次没给 summary 时索引里的 abstract 不能凭空清空。
          const existed = await this.#store.exists(target);
          const priorSummary = existed
            ? (await this.#store.readText(target)).frontmatter?.summary
            : undefined;

          const stat = await this.#store.writeText(
            target,
            content,
            target.name.toLowerCase().endsWith('.md') && file.summary !== undefined
              ? { frontmatter: { summary: file.summary } }
              : {},
          );
          records.push(
            toIndexRecord(target, content, file.summary ?? priorSummary ?? null, stat.updatedAt),
          );
          (existed ? updated : created).push(target);
          written.push(target);

          if (staged !== null) {
            try {
              const attachment = await this.#writeAttachment(target, staged, records);
              attachments.push(attachment);
              // 附件不进摘要失效集合：`.attachments/` 存的是原始字节，给它生成目录摘要
              // 没有意义（二进制不是可读正文），只会多两次模型/规则调用。
            } catch (attachmentError) {
              // 规范化文本已经落盘，不能因为附件失败把整个文件算作 skipped——那会告诉
              // 调用方「什么都没写」，而实际上检索是好的。
              const reason = errorMessage(attachmentError);
              this.#logger.error('附件落盘失败，规范化文本已保留。', {
                path: file.path,
                reason,
              });
              await this.#recordReconcile('attachment', file.path, reason);
            }
          }
        } catch (error) {
          if (error instanceof ComemError && error.code === 'RESOURCE_EXHAUSTED') {
            throw error;
          }
          const reason = errorMessage(error);
          skipped.push({ path: file.path, reason });
          this.#logger.warn('资源文件导入失败，已跳过。', { path: file.path, reason });
          await this.#recordReconcile('write', file.path, reason);
        }
      }

      if (records.length > 0) {
        try {
          await this.#index.upsert(records);
          indexed = records.length;
        } catch (error) {
          indexFailed = true;
          const reason = errorMessage(error);
          this.#logger.error('索引批量写入失败，已写入的文件保持不变，记录待重放。', {
            count: records.length,
            error: reason,
          });
          for (const record of records) {
            await this.#recordReconcile('index', record.uri, reason);
          }
        }
      }

      // §12.4 的「写时算」：本服务直接写 `ContentStore`，观察者收不到通知。不补
      // 这一步，`node_permission` 里没有新文件的行，而 `list` / `tree` / `find`
      // 的权限过滤是纯 SQL 查询——写成功了，树里却什么都没有。
      //
      // 放在 `index.upsert` 之后：`materializeNode` 从 `node` 表读 kind 决定链的
      // 起点。索引写失败时仍然要物化——权限是独立的派生数据，而且 `kind` 缺失时
      // 的兜底（按目录算）得到的是同一条有效权限。
      await materializeAncestorPermissions(
        {
          authorizer: this.#authorizer,
          logger: this.#logger,
          nodeLabel: '资源节点',
          onFailure: (uri, reason) => this.#recordReconcile('permission', uri, reason),
        },
        [...written, ...attachments],
        options.principals,
      );
    });

    // §10.6 第 3 步：提交后统一投递摘要重算，每个父目录一次。
    if (!indexFailed) {
      await invalidateParentSummaries(
        { summary: this.#summary, logger: this.#logger },
        written,
      );
    }

    const elapsedMs = Date.now() - startedAt;
    this.#logger.info('资源导入完成', {
      parent: options.parentUri.toString(),
      subject: options.subject,
      principalCount: options.principals.length,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      attachments: attachments.length,
      indexed,
      elapsedMs,
    });

    return {
      created,
      updated,
      skipped,
      attachments,
      tokens: { indexed, elapsedMs },
    };
  }

  /**
   * 清理超时未使用的临时上传。
   *
   * 启动扫描与定时任务共用：两者都只需要「比某个年龄更旧的删掉」。返回删除数量。
   */
  async sweepStaged(olderThanSeconds: number): Promise<number> {
    if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 0) {
      throw invalidArgument('olderThanSeconds 必须是非负数。', { olderThanSeconds });
    }

    const cutoff = Date.now() - olderThanSeconds * 1000;
    let removed = 0;
    for (const info of await this.#storage.listStaged()) {
      if (info.stagedAtMs >= cutoff) {
        continue;
      }
      await this.#storage.removeStaged(info.uploadId);
      removed += 1;
    }

    if (removed > 0) {
      this.#logger.info('已清理超时的临时上传', { removed, olderThanSeconds });
    }
    return removed;
  }

  // ── 内部 ──

  async #readStaged(uploadId: string | undefined): Promise<StagedUpload | null> {
    if (uploadId === undefined) {
      return null;
    }
    const staged = await this.#storage.readStaged(uploadId);
    if (staged === null) {
      throw new ComemError(
        'NOT_FOUND',
        `临时上传不存在或已过期：${uploadId}。`,
        { uploadId },
      );
    }
    return staged;
  }

  #assertFileSize(
    content: string,
    stagedSize: number | null,
    maxFileBytes: number,
    path: string,
  ): void {
    // 两者都存在时取较大者：附件与规范化文本是两份独立数据，任何一份超限都要拒绝。
    const size = Math.max(stagedSize ?? 0, utf8ByteLength(content));
    if (size > maxFileBytes) {
      throw new ComemError(
        'RESOURCE_EXHAUSTED',
        `文件 ${path} 大小 ${size} 字节超过单文件上限 ${maxFileBytes} 字节。`,
        { path, size, maxFileBytes },
      );
    }
  }

  /**
   * 写原始附件到目标文件同级的 `.attachments/`（§6.5：附件与规范化文本放在一起）。
   *
   * 同名已存在时加 `-1`、`-2` 后缀，**不覆盖**：附件是原始字节，覆盖等于丢数据。
   * 附件也是普通节点，进索引（`download` 按 URI 读它）。
   */
  async #writeAttachment(
    target: Uri,
    staged: StagedUpload,
    records: IndexRecord[],
  ): Promise<Uri> {
    const directory = target.parent();
    if (directory === null) {
      throw invalidArgument(`根节点不能作为资源目标：${target.toString()}。`, {
        uri: target.toString(),
      });
    }
    const name = attachmentFileName(staged.info.fileName, target.name);
    const attachment = await this.#uniqueAttachmentUri(directory, name);
    await this.#store.writeBytes(attachment, staged.bytes);
    records.push({
      uri: attachment.toString(),
      parentUri: attachment.parent()?.toString() ?? '',
      scope: attachment.scope,
      kind: 'document',
      contextType: 'resource',
      memoryType: null,
      level: RESOURCE_LEVEL,
      abstract: null,
      // 二进制没有可检索正文；索引只承担「这个 URI 存在」。
      content: '',
      bodyDigest: stableDigest(''),
      size: staged.info.size,
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    this.#logger.debug('附件已落盘', {
      uri: attachment.toString(),
      size: staged.info.size,
    });
    return attachment;
  }

  async #uniqueAttachmentUri(directory: Uri, fileName: string): Promise<Uri> {
    const attachmentsDirectory = directory.child(ATTACHMENTS_DIRECTORY);
    const candidate = attachmentsDirectory.child(fileName);
    if (!(await this.#store.exists(candidate))) {
      return candidate;
    }

    const dot = fileName.lastIndexOf('.');
    const stem = dot <= 0 ? fileName : fileName.slice(0, dot);
    const extension = dot <= 0 ? '' : fileName.slice(dot);
    for (let index = 1; ; index += 1) {
      const suffixed = attachmentsDirectory.child(`${stem}-${index}${extension}`);
      if (!(await this.#store.exists(suffixed))) {
        return suffixed;
      }
    }
  }

  /** 对账日志写失败不能让导入失败：它只是补偿线索，不是真相。 */
  async #recordReconcile(op: string, uri: string, error: string): Promise<void> {
    try {
      await this.#storage.appendReconcile({ op, uri, error, at: new Date().toISOString() });
    } catch (appendError) {
      this.#logger.error('对账日志写入失败，已忽略。', {
        op,
        uri,
        error: errorMessage(appendError),
      });
    }
  }
}

function toIndexRecord(
  target: Uri,
  content: string,
  abstract: string | null,
  updatedAt: string,
): IndexRecord {
  return {
    uri: target.toString(),
    parentUri: target.parent()?.toString() ?? '',
    scope: target.scope,
    kind: 'document',
    contextType: 'resource',
    memoryType: null,
    level: RESOURCE_LEVEL,
    abstract,
    content,
    bodyDigest: stableDigest(content),
    size: utf8ByteLength(content),
    updatedAt,
    status: 'active',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
