/**
 * 装配用的端口实现：临时上传存储与写路径授权。
 *
 * 两个类都依赖「装配层构造、服务层只拿接口」的边界（§4.4）。它们不持有任何跨阶段的
 * 可变状态：`FileResourceStorage` 只读 `dataDir`，`InheritingAuthorizer` 只读注入的
 * `AclService` 与 `ContentStore`。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ContentStore } from '../../adapters/fs/content-store.js';
import { ReconcileLog } from '../../adapters/fs/reconcile-log.js';
import type { Uri } from '../../domain/uri.js';
import type { AclService } from '../../services/acl.js';
import { permissionDenied } from '../../services/authorizer.js';
import type { AclAction, Authorizer } from '../../services/authorizer.js';
import type {
  ReconcileEntry,
  ResourceStorage,
  StageUploadInput,
  StagedUpload,
  StagedUploadInfo,
} from '../../services/resource.js';
import { fsErrorCode } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import { metaPath } from './support.js';

/** 临时上传的位置（`ResourceStorage` 的端口注释）。 */
const TEMP_UPLOAD_DIRECTORY = 'tmp';

/** 临时上传的元数据后缀。与文件同目录，`listStaged` 靠它枚举。 */
const STAGED_METADATA_SUFFIX = '.meta.json';

/**
 * 临时上传与对账日志的存储（`ResourceStorage` 的 `node:fs` 实现）。
 *
 * 元数据与字节分开存：`listStaged` 不需要把每个上传的文件读进内存就能回答「有哪些」。
 *
 * 对账日志的读写交给 `ReconcileLog`：重放器与写路径必须共用同一个实例，才能让
 * 「追加」与「重写」走同一条串行队列（见 `adapters/fs/reconcile-log.ts` 的文件头）。
 */
export class FileResourceStorage implements ResourceStorage {
  readonly #dataDir: string;
  readonly #reconcileLog: ReconcileLog;

  constructor(dataDir: string, reconcileLog: ReconcileLog) {
    this.#dataDir = dataDir;
    this.#reconcileLog = reconcileLog;
  }

  async stage(input: StageUploadInput): Promise<string> {
    const tempPath = this.#tempPathOf(input.uploadId);
    const metadataPath = this.#metadataPathOf(input.uploadId);
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, input.bytes);
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        uploadId: input.uploadId,
        fileName: input.fileName,
        size: input.bytes.byteLength,
        stagedAtMs: input.stagedAtMs,
      })}\n`,
      'utf8',
    );
    return tempPath;
  }

  async readStaged(uploadId: string): Promise<StagedUpload | null> {
    const info = await this.#readInfo(uploadId);
    if (info === null) {
      return null;
    }
    try {
      const bytes = await readFile(this.#tempPathOf(uploadId));
      return { info, bytes: new Uint8Array(bytes) };
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async listStaged(): Promise<readonly StagedUploadInfo[]> {
    const directory = this.#tempDirectory();
    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const infos: StagedUploadInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(STAGED_METADATA_SUFFIX)) {
        continue;
      }
      const info = await this.#readInfo(name.slice(0, -STAGED_METADATA_SUFFIX.length));
      if (info !== null) {
        infos.push(info);
      }
    }
    return infos.sort((left, right) => left.stagedAtMs - right.stagedAtMs);
  }

  async removeStaged(uploadId: string): Promise<void> {
    await rm(this.#tempPathOf(uploadId), { force: true });
    await rm(this.#metadataPathOf(uploadId), { force: true });
  }

  async appendReconcile(entry: ReconcileEntry): Promise<void> {
    await this.#reconcileLog.append(entry);
  }

  #tempDirectory(): string {
    return metaPath(this.#dataDir, TEMP_UPLOAD_DIRECTORY);
  }

  #tempPathOf(uploadId: string): string {
    return join(this.#tempDirectory(), uploadId);
  }

  #metadataPathOf(uploadId: string): string {
    return `${this.#tempPathOf(uploadId)}${STAGED_METADATA_SUFFIX}`;
  }

  async #readInfo(uploadId: string): Promise<StagedUploadInfo | null> {
    try {
      const raw = await readFile(this.#metadataPathOf(uploadId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      const record = parsed;
      const fileName = record['fileName'];
      const size = record['size'];
      const stagedAtMs = record['stagedAtMs'];
      if (typeof size !== 'number' || typeof stagedAtMs !== 'number') {
        return null;
      }
      return {
        uploadId,
        fileName: typeof fileName === 'string' ? fileName : null,
        size,
        tempPath: this.#tempPathOf(uploadId),
        stagedAtMs,
      };
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * 写路径的授权端口：物化表里没有这一行时先按链求值并落表。
 *
 * `node_permission` 是**物化缓存**（§8.2），`AclService.check` 只查缓存里该节点的行。
 * 新建节点时缓存里没有它，直接查就是 deny——「文件都还没写，权限先被拒」，写路径
 * 根本走不到观察者。`AclService.materializeNode` 的文档写的正是「用于「新建节点时
 * 从父目录复制有效权限」」，但 `FileSystemService` 不知道它该在什么时候调。
 *
 * 这里把「写操作发现行缺失 → 物化一次 → 再查」收在一处，而不是在每个路由 / 工具里
 * 各写一遍：
 *
 * - 写操作（`write` / `manage`）无条件物化：目标是新建的，磁盘上还没有它。
 * - 读操作只在**节点确实存在于磁盘**时物化：批量摄取、会话、技能这些绕过
 *   `FileSystemService` 的写入路径已经把文件写下去了，但物化表里没有行。一个拼错的
 *   URI 不会因为 GET 就在数据库里多一条权限行。
 * - 已经在缓存里的节点不会重复物化（第一次 `check` 就通过）。
 *
 * 这不是「绕过授权」：物化的结果就是 `effective(N)` 本身，与 `setAcl` 重算整棵子树
 * 用的是同一个纯函数。
 */
export class InheritingAuthorizer implements Authorizer {
  readonly #acl: AclService;
  readonly #store: ContentStore;

  constructor(acl: AclService, store: ContentStore) {
    this.#acl = acl;
    this.#store = store;
  }

  async check(uri: Uri, action: AclAction, principals: readonly string[]): Promise<boolean> {
    return this.#acl.check(uri, action, principals);
  }

  async filterReadable(
    uris: readonly Uri[],
    principals: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.#acl.filterReadable(uris, principals);
  }

  async assert(uri: Uri, action: AclAction, principals: readonly string[]): Promise<void> {
    if (await this.#acl.check(uri, action, principals)) {
      return;
    }
    // 写操作的目标可能还不存在（新建节点），读操作只有「磁盘上有、物化表里没有」
    // （批量写入 / 会话 / 技能这些绕过 `FileSystemService` 的路径）才值得物化。
    // `store.stat` 不求权，所以这个判断本身不会触发权限检查。
    const exists = action >= 3 ? true : (await this.#store.stat(uri)) !== null;
    if (exists) {
      await this.#acl.materializeNode(uri);
      if (await this.#acl.check(uri, action, principals)) {
        return;
      }
    }
    throw permissionDenied(uri, action);
  }
}
