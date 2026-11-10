/**
 * 记忆服务的端口，以及基于文件端口的两个原语：读原样文档、列目录。
 *
 * `service` / `query` / `review` / `versioning` 只取自己用得到的那一部分，形状仍以
 * 这里的 `MemoryServicePorts` 为准，不另写第二份。两个原语把「文件不存在」与
 * 「解析不出记忆 frontmatter」统一成 `null` / 空数组，四处的判据只有这一份。
 *
 * ## 端口为什么是「原样文档」
 *
 * `filesystem.read` 的 `text` 必须是**磁盘上的原始内容**（含 frontmatter），
 * `filesystem.write` 收到的也必须是原始内容。`FileSystemService` 的 `read` 返回的是
 * 去掉 frontmatter 的正文、`write` 又会用适配层自己的 frontmatter 机制重新序列化，
 * 两者都不能直接接进来——见 `MemoryServicePorts.read` 的说明与本 wave 的报告。
 */

import type { PathLockManager } from '../../adapters/fs/lock.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';
import { parseMemoryDocument, type MemoryDocument } from './document.js';

/** 目录项：`kind` 供 `listPending` 递归（与文件端口 `list` 的元素同一形状）。 */
export type MemoryDirectoryEntry = {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
};

/**
 * 记忆服务的端口。
 *
 * `filesystem.read` / `filesystem.write` 的文本是**整份文档**（frontmatter + 正文），
 * 不是 `FileSystemService` 那种去掉 frontmatter 的正文：记忆的元数据必须能原样读回，
 * 否则 `fields` 只能靠猜。
 *
 * `remove` / `list` 不在最初的端口草图里，是「拒绝即删除」（§11.6）与「待复核列表」
 * 两个用例的必需能力。`FileSystemService` 结构上同时满足这四个方法。
 */
export interface MemoryServicePorts {
  /**
   * 记忆文件的路径锁（§18「并发控制」）。
   *
   * 记忆写入的「读 → 序列化 → 写」必须被同一把 `exact` 锁覆盖，而这把锁不能由
   * 调用方代持：`memory_merge` 步骤、记忆合并、HTTP 复核三条路径都会写同一个 URI，
   * 让每个调用方自己加锁等于把「忘记加锁」变成静默丢字段。
   */
  readonly locks: Pick<PathLockManager, 'withLock'>;
  /**
   * 需要复核（写入时 `status = 'pending'`）的记忆类型。
   *
   * 缺省时用 `DEFAULT_REVIEW_REQUIRED`。生产装配必须传 `config.memory.reviewRequired`——
   * 不传就是「配置项存在但不生效」。
   */
  readonly reviewRequired?: readonly string[];
  readonly filesystem: {
    /** 原样返回文件内容（含 frontmatter）。文件不存在时抛 `NOT_FOUND`。 */
    read(uri: Uri): Promise<{ readonly text: string }>;
    write(uri: Uri, text: string, options?: unknown): Promise<unknown>;
    /** 不存在返回 `null`；目录返回非 `null`（`read` 会以 `INVALID_ARGUMENT` 拒绝）。 */
    stat(uri: Uri): Promise<unknown>;
    /** `rm -f` 语义：不存在不是错误。 */
    remove(uri: Uri): Promise<unknown>;
    /** 直接子项，带 `kind` 供 `listPending` 递归。 */
    list(uri: Uri): Promise<readonly { readonly uri: Uri; readonly kind: 'file' | 'directory' }[]>;
  };
  /**
   * 检索端口（§11.3 的预取）。
   *
   * `options` 是 `unknown`：`SearchService.find` 的 `FindOptions` 要求调用方身份与
   * 展开后的 principals，而预取跑在后台任务里没有请求身份。装配方负责把它绑成
   * 「某个 scope 下已授权的检索」。
   */
  readonly search: {
    find(
      query: string,
      options: unknown,
    ): Promise<
      readonly { readonly uri: string; readonly abstract: string | null; readonly score: number }[]
    >;
  };
  readonly logger: Logger;
}

/** 文件端口：`query` / `review` / `versioning` 与两个原语共用的那一部分。 */
export type MemoryFileStore = MemoryServicePorts['filesystem'];

/** 检索端口：预取只用 `find` 一个方法。 */
export type MemorySearchPort = MemoryServicePorts['search'];

/**
 * 读一条记忆的原始文档：文件不存在返回 `null`，解析不出记忆 frontmatter 也返回
 * `null`（并记一条 warn）。
 *
 * 端口语义不对（例如注入了返回正文的 `FileSystemService`）时，这里会一路返回
 * `null`，看起来像「没有记忆」，抽取会重复新增。留一条 warn 让它可查。
 */
export async function readMemoryDocument(
  filesystem: MemoryFileStore,
  logger: Logger,
  uri: Uri,
): Promise<MemoryDocument | null> {
  if ((await filesystem.stat(uri)) === null) {
    return null;
  }
  const { text } = await filesystem.read(uri);
  const document = parseMemoryDocument(text);
  if (document === null) {
    logger.warn('记忆文件缺少可解析的 frontmatter，按不存在处理', {
      uri: uri.toString(),
    });
  }
  return document;
}

/** 目录不存在读作空：遍历方不该为「目录还没建」分支（端口的 `list` 会抛 `NOT_FOUND`）。 */
export async function listDirectoryOrEmpty(
  filesystem: MemoryFileStore,
  directory: Uri,
): Promise<readonly MemoryDirectoryEntry[]> {
  try {
    return await filesystem.list(directory);
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return [];
    }
    throw error;
  }
}
