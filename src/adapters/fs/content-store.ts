/**
 * 内容读写（架构文档 §6.5、§6.7、§10.6）。
 *
 * 内容存储就是真实文件系统：一个 URI 一个文件，写下去的东西 `cat` 得到。这一层
 * 只做「字节怎么安全落盘」，不认识记忆类型、不更新索引、不触发摘要失效——那些
 * 是 `services/filesystem.ts` 的职责。
 *
 * 三个不变量由这一层保证：
 *
 * 1. **原子写**：先写同目录临时文件、`fsync`、再 `rename`。任何时刻被读到的文件
 *    要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的正文。
 * 2. **元数据写保护**：`writeText` 不传 `frontmatter` 时保留磁盘上现有的
 *    frontmatter，只替换正文（§10.6）。
 * 3. **错误只有一种形状**：文件系统错误全部收敛成 `ComemError`，调用方按 `code`
 *    分支，不用摸 `errno`。
 */

import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { cp, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ComemErrorCode } from '../../domain/errors.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { DocumentFrontmatter, SummaryState } from '../../domain/node.js';
import { stableDigest } from '../../domain/node.js';
import type { Uri } from '../../domain/uri.js';

import { TEMP_FILE_PREFIX, isArtifactName, isReservedName, toDiskPath } from './path.js';
import { parseDocument, serializeDocument } from './frontmatter.js';

export interface ContentStoreOptions {
  readonly dataDir: string;
  readonly logger: Logger;
}

export interface StoredStat {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
  /** 文件：UTF-8 字节数；目录：直接子项数 */
  readonly size: number;
  /** ISO 8601 */
  readonly updatedAt: string;
}

export interface TextDocument {
  /** 正文，不含 frontmatter */
  readonly text: string;
  /** 没有 frontmatter 时为 null */
  readonly frontmatter: DocumentFrontmatter | null;
  readonly stat: StoredStat;
}

export interface WriteTextOptions {
  /** 写回用的 frontmatter；不传则保留磁盘上现有的（§10.6 元数据写保护） */
  readonly frontmatter?: DocumentFrontmatter;
  /** 乐观并发：磁盘上正文的 digest 不等于它就抛 CONFLICT */
  readonly expectedDigest?: string;
}

/**
 * 临时文件后缀的随机位数（base36）。8 位 36 进制约 41 bit 随机性；同一目录
 * 并发写撞名概率可以忽略，同时保留进程号区分多进程。
 */
const TEMP_SUFFIX_LENGTH = 8;

/** 1 毫秒 = 1e6 纳秒，用于把 `hrtime` 差值换算成毫秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * frontmatter 的磁盘键名（架构文档 §6.7 的 YAML 示例）。
 *
 * 磁盘上是 snake_case（YAML 惯例），领域类型 `DocumentFrontmatter` 是 camelCase
 * （TypeScript 惯例）。映射只发生在适配层，领域层看不到磁盘键名。
 */
const FRONTMATTER_KEYS = {
  summary: 'summary',
  summaryDigest: 'summary_digest',
  summaryState: 'summary_state',
} as const;

/** 文件系统 errno → 领域错误码（架构文档 §19）。表里没有的一律 INTERNAL。 */
const ERROR_CODE_BY_FS_ERRNO: Readonly<Record<string, ComemErrorCode>> = {
  ENOENT: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  ENOTDIR: 'INVALID_ARGUMENT',
  EISDIR: 'INVALID_ARGUMENT',
  ENOSPC: 'RESOURCE_EXHAUSTED',
};

const ERROR_MESSAGE_BY_CODE: Readonly<Record<ComemErrorCode, string>> = {
  INVALID_URI: 'URI 不合法',
  INVALID_ARGUMENT: '路径类型不匹配',
  NOT_FOUND: '文件不存在',
  UNAUTHENTICATED: '未认证',
  PERMISSION_DENIED: '没有写入权限',
  ALREADY_EXISTS: '路径已存在',
  CONFLICT: '并发写冲突',
  RESOURCE_EXHAUSTED: '磁盘空间不足',
  PROVIDER_UNAVAILABLE: '服务不可用',
  INTERNAL: '文件系统操作失败',
};

/** 从 `unknown` 里取 `code`，不用类型断言。 */
function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 把文件系统错误收敛成 `ComemError`。
 *
 * 已经是 `ComemError` 的原样返回（例如 `writeText` 自己抛的 CONFLICT），否则按
 * errno 查表，查不到的是程序缺陷，标 INTERNAL 而不是假装成业务错误。
 */
function mapFsError(error: unknown, uri: Uri): ComemError {
  if (error instanceof ComemError) {
    return error;
  }
  const fsCode = fsErrorCode(error);
  const code = (fsCode === null ? undefined : ERROR_CODE_BY_FS_ERRNO[fsCode]) ?? 'INTERNAL';
  const message = `${ERROR_MESSAGE_BY_CODE[code]}（${fsCode ?? 'UNKNOWN'}）：${uri.toString()}`;
  return new ComemError(code, message, { uri: uri.toString(), fsCode });
}

function randomTempSuffix(): string {
  return `${process.pid.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 2 + TEMP_SUFFIX_LENGTH)}`;
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * 子条目的 URI；`Uri` 表示不了的名字（保留名、控制字符、Windows 上的非法名）返回
 * `null`。目录里可能真有这种文件，`list` 只返回可寻址的条目——给调用方一个它再也
 * 打不开的 URI 没有意义。
 */
function tryChildUri(parent: Uri, name: string): Uri | null {
  try {
    return parent.child(name);
  } catch (error) {
    if (error instanceof ComemError && error.code === 'INVALID_URI') {
      return null;
    }
    throw error;
  }
}

interface ListedChild {
  readonly uri: Uri;
  readonly absolute: string;
}

function toFrontmatterRecord(frontmatter: DocumentFrontmatter): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (frontmatter.summary !== undefined) {
    record[FRONTMATTER_KEYS.summary] = frontmatter.summary;
  }
  if (frontmatter.summaryDigest !== undefined) {
    record[FRONTMATTER_KEYS.summaryDigest] = frontmatter.summaryDigest;
  }
  if (frontmatter.summaryState !== undefined) {
    record[FRONTMATTER_KEYS.summaryState] = frontmatter.summaryState;
  }
  return record;
}

/**
 * 从原始键值里取摘要字段。
 *
 * frontmatter 是人可以直接改的（§7），一个类型不对的值不应该让整个文件读不出来，
 * 所以只收正确类型的字段，其余当作没写。
 */
function toFrontmatter(data: Readonly<Record<string, unknown>>): DocumentFrontmatter {
  const frontmatter: {
    summary?: string;
    summaryDigest?: string;
    summaryState?: SummaryState;
  } = {};

  const summary = data[FRONTMATTER_KEYS.summary];
  if (typeof summary === 'string') {
    frontmatter.summary = summary;
  }
  const summaryDigest = data[FRONTMATTER_KEYS.summaryDigest];
  if (typeof summaryDigest === 'string') {
    frontmatter.summaryDigest = summaryDigest;
  }
  const summaryState = data[FRONTMATTER_KEYS.summaryState];
  if (summaryState === 'fresh' || summaryState === 'stale') {
    frontmatter.summaryState = summaryState;
  }

  return frontmatter;
}

export class ContentStore {
  readonly #dataDir: string;
  readonly #logger: Logger;

  constructor(options: ContentStoreOptions) {
    this.#dataDir = options.dataDir;
    this.#logger = options.logger;
  }

  /** 不存在抛 NOT_FOUND；目标是目录抛 INVALID_ARGUMENT（`EISDIR`）。 */
  async readText(uri: Uri): Promise<TextDocument> {
    const absolute = toDiskPath(this.#dataDir, uri);
    const bytes = await this.#readFile(absolute, uri);
    const document = parseDocument(bytes.toString('utf8'));
    const stats = await this.#statOrThrow(absolute, uri);

    return {
      text: document.body,
      frontmatter: document.hasFrontmatter ? toFrontmatter(document.data) : null,
      stat: {
        uri,
        kind: 'file',
        // 文件大小按磁盘上的 UTF-8 字节数算，含 frontmatter——它是文件的一部分。
        size: bytes.byteLength,
        updatedAt: stats.mtime.toISOString(),
      },
    };
  }

  /** 不存在抛 NOT_FOUND。返回的数组是拷贝，不与文件系统共享缓冲区。 */
  async readBytes(uri: Uri): Promise<Uint8Array> {
    const absolute = toDiskPath(this.#dataDir, uri);
    return new Uint8Array(await this.#readFile(absolute, uri));
  }

  /**
   * 写正文。
   *
   * `options.frontmatter` 提供时，同名摘要字段覆盖磁盘上的值；未提供的键（包括
   * `freshness`、`uri`、`generated_by` 这些本层不认识的键）全部原样保留，这就是
   * §10.6 的元数据写保护。文件不存在时基底是空对象。
   *
   * `options.expectedDigest` 是乐观并发：磁盘上**正文**的摘要与它不符就抛
   * CONFLICT；文件不存在也抛 CONFLICT（「按期望版本改一个不存在的文件」同样是冲突）。
   */
  async writeText(uri: Uri, text: string, options: WriteTextOptions = {}): Promise<StoredStat> {
    const startedAt = process.hrtime.bigint();
    assertWritableName(uri);

    const absolute = toDiskPath(this.#dataDir, uri);
    const existing = await this.#readRawDocument(absolute, uri);

    if (options.expectedDigest !== undefined) {
      if (existing === null) {
        throw new ComemError('CONFLICT', `文件不存在，无法按期望摘要写入：${uri.toString()}`, {
          uri: uri.toString(),
          expectedDigest: options.expectedDigest,
        });
      }
      const actualDigest = stableDigest(existing.body);
      if (actualDigest !== options.expectedDigest) {
        throw new ComemError('CONFLICT', `正文已被改动，摘要不匹配：${uri.toString()}`, {
          uri: uri.toString(),
          expectedDigest: options.expectedDigest,
          actualDigest,
        });
      }
    }

    const base = existing?.data ?? {};
    const data =
      options.frontmatter === undefined
        ? base
        : { ...base, ...toFrontmatterRecord(options.frontmatter) };
    const content = serializeDocument(text, data);

    await this.#ensureParentDirectory(absolute, uri);
    const stats = await this.#writeAtomically(absolute, content, uri);

    const durationMs =
      Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
    this.#logger.debug('写入文本文件', {
      uri: uri.toString(),
      bytes: Buffer.byteLength(content, 'utf8'),
      durationMs,
    });

    return { uri, kind: 'file', size: stats.size, updatedAt: stats.mtime.toISOString() };
  }

  /** 写原始字节。不解析 frontmatter，二进制内容原样落盘。 */
  async writeBytes(uri: Uri, bytes: Uint8Array): Promise<StoredStat> {
    assertWritableName(uri);

    const absolute = toDiskPath(this.#dataDir, uri);
    await this.#ensureParentDirectory(absolute, uri);
    const stats = await this.#writeAtomically(absolute, bytes, uri);

    return { uri, kind: 'file', size: stats.size, updatedAt: stats.mtime.toISOString() };
  }

  /** 与 `stat` 一致：产物名不算节点，返回 `false`。 */
  async exists(uri: Uri): Promise<boolean> {
    if (isArtifactName(uri.name)) {
      return false;
    }
    const absolute = toDiskPath(this.#dataDir, uri);
    try {
      await stat(absolute);
      return true;
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return false;
      }
      throw mapFsError(error, uri);
    }
  }

  /** 不存在返回 `null`。目录的 `size` 是直接子项数（与 `list` 返回的条目一致）。 */
  async stat(uri: Uri): Promise<StoredStat | null> {
    // 产物不是用户可见节点：即使磁盘上真有这个名字，也不该出现在 tree 里。
    if (isArtifactName(uri.name)) {
      return null;
    }
    const absolute = toDiskPath(this.#dataDir, uri);
    const stats = await this.#statOrNull(absolute, uri);
    if (stats === null) {
      return null;
    }
    if (!stats.isDirectory()) {
      return { uri, kind: 'file', size: stats.size, updatedAt: stats.mtime.toISOString() };
    }
    const children = await this.#listChildren(absolute, uri);
    return {
      uri,
      kind: 'directory',
      size: children.length,
      updatedAt: stats.mtime.toISOString(),
    };
  }

  /** 直接子项，按 name 升序。跳过临时文件、锁文件与 `Uri` 表示不了的条目。 */
  async list(uri: Uri): Promise<readonly StoredStat[]> {
    const absolute = toDiskPath(this.#dataDir, uri);
    const children = await this.#listChildren(absolute, uri);

    const stats = await Promise.all(
      children.map(async (child): Promise<StoredStat> => {
        const childStats = await this.#statOrThrow(child.absolute, child.uri);
        if (childStats.isDirectory()) {
          return {
            uri: child.uri,
            kind: 'directory',
            size: (await this.#listChildren(child.absolute, child.uri)).length,
            updatedAt: childStats.mtime.toISOString(),
          };
        }
        return {
          uri: child.uri,
          kind: 'file',
          size: childStats.size,
          updatedAt: childStats.mtime.toISOString(),
        };
      }),
    );

    return stats.sort((left, right) => compareNames(left.uri.name, right.uri.name));
  }

  /** 已存在抛 ALREADY_EXISTS（`recursive: true` 时不算错误，与 `fs.mkdir` 一致）。 */
  async mkdir(uri: Uri, options: { readonly recursive?: boolean } = {}): Promise<void> {
    assertWritableName(uri);
    const absolute = toDiskPath(this.#dataDir, uri);
    try {
      await mkdir(absolute, { recursive: options.recursive ?? false });
    } catch (error) {
      throw mapFsError(error, uri);
    }
  }

  /**
   * 删除，返回删掉的文件数（不含目录）。
   *
   * 不存在返回 0 而不是抛错——`rm -f` 的语义，调用方不用先 `exists` 再删。
   * 删除目录必须显式 `recursive`，否则抛 INVALID_ARGUMENT：静默删空目录、
   * 或者静默失败都更难查。
   */
  async remove(uri: Uri, options: { readonly recursive?: boolean } = {}): Promise<number> {
    const absolute = toDiskPath(this.#dataDir, uri);
    const stats = await this.#statOrNull(absolute, uri);
    if (stats === null) {
      return 0;
    }

    if (stats.isDirectory()) {
      if (options.recursive !== true) {
        throw new ComemError('INVALID_ARGUMENT', `删除目录需要 recursive 选项：${uri.toString()}`, {
          uri: uri.toString(),
        });
      }
      const removed = await countFiles(absolute);
      try {
        await rm(absolute, { recursive: true, force: true });
      } catch (error) {
        throw mapFsError(error, uri);
      }
      return removed;
    }

    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw mapFsError(error, uri);
    }
    return 1;
  }

  /**
   * 移动 / 改名。目标已存在抛 ALREADY_EXISTS。
   *
   * `fs.rename` 跨设备会抛 `EXDEV`（数据根挂在与临时目录不同的卷上时会发生），
   * 这里降级成「复制 + 删除」。
   */
  async move(from: Uri, to: Uri): Promise<void> {
    assertWritableName(to);

    const source = toDiskPath(this.#dataDir, from);
    const target = toDiskPath(this.#dataDir, to);
    // 先确认源存在，避免为一个不存在的东西建出目标父目录。
    await this.#statOrThrow(source, from);
    if (await this.exists(to)) {
      throw new ComemError('ALREADY_EXISTS', `目标路径已存在：${to.toString()}`, {
        uri: to.toString(),
        from: from.toString(),
      });
    }

    await this.#ensureParentDirectory(target, to);
    try {
      await rename(source, target);
    } catch (error) {
      if (fsErrorCode(error) === 'EXDEV') {
        await this.#copyThenRemove(source, target, from, to);
        return;
      }
      throw mapFsError(error, from);
    }
  }

  async #copyThenRemove(source: string, target: string, from: Uri, to: Uri): Promise<void> {
    this.#logger.debug('跨设备移动，降级为复制后删除', {
      from: from.toString(),
      to: to.toString(),
    });
    try {
      await cp(source, target, { recursive: true, force: false, errorOnExist: true });
      await rm(source, { recursive: true, force: true });
    } catch (error) {
      throw mapFsError(error, from);
    }
  }

  async #readFile(absolute: string, uri: Uri): Promise<Buffer> {
    try {
      return await readFile(absolute);
    } catch (error) {
      throw mapFsError(error, uri);
    }
  }

  /** 磁盘上的原始文档（含未知 frontmatter 键）；文件不存在返回 `null`。 */
  async #readRawDocument(absolute: string, uri: Uri) {
    try {
      return parseDocument((await readFile(absolute)).toString('utf8'));
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw mapFsError(error, uri);
    }
  }

  async #statOrNull(absolute: string, uri: Uri): Promise<Stats | null> {
    try {
      return await stat(absolute);
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return null;
      }
      throw mapFsError(error, uri);
    }
  }

  async #statOrThrow(absolute: string, uri: Uri): Promise<Stats> {
    const stats = await this.#statOrNull(absolute, uri);
    if (stats === null) {
      throw new ComemError('NOT_FOUND', `文件不存在：${uri.toString()}`, { uri: uri.toString() });
    }
    return stats;
  }

  async #listChildren(absolute: string, uri: Uri): Promise<readonly ListedChild[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, uri);
    }

    const children: ListedChild[] = [];
    for (const entry of entries) {
      if (isArtifactName(entry.name)) {
        continue;
      }
      const childUri = tryChildUri(uri, entry.name);
      if (childUri === null) {
        continue;
      }
      children.push({ uri: childUri, absolute: join(absolute, entry.name) });
    }
    return children;
  }

  async #ensureParentDirectory(absolute: string, uri: Uri): Promise<void> {
    try {
      // §7「写入需要先 mkdir」：write 内部自动建父目录，调用方不用关心。
      await mkdir(dirname(absolute), { recursive: true });
    } catch (error) {
      throw mapFsError(error, uri);
    }
  }

  /**
   * 原子写：同目录临时文件 → `fsync` → `rename`。
   *
   * `open` 用 `wx`：临时文件名撞上已存在的文件时直接失败，不复用别人的半成品。
   * 失败路径上清掉临时文件，不让它变成 `list` 里的垃圾。
   */
  async #writeAtomically(absolute: string, data: string | Uint8Array, uri: Uri): Promise<Stats> {
    const temp = join(dirname(absolute), `${TEMP_FILE_PREFIX}${randomTempSuffix()}`);
    let handle: FileHandle;
    try {
      handle = await open(temp, 'wx');
    } catch (error) {
      throw mapFsError(error, uri);
    }
    try {
      await handle.writeFile(data);
      // 没有 fsync 的话，rename 之后断电可能留下空文件——「写了一半」的另一种形态。
      await handle.sync();
      const stats = await handle.stat();
      await handle.close();
      await rename(temp, absolute);
      return stats;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapFsError(error, uri);
    }
  }
}

/**
 * 写入目标的最后一段不能是内部产物。
 *
 * 两种拒绝的语义不同，所以分开写：元数据文件的读写走专门 API（W4 的
 * `metadata-file.ts`），锁文件与临时文件是 CoMem 自己的运行时产物，任何调用方
 * 都不该往那儿写。
 */
function assertWritableName(uri: Uri): void {
  if (isReservedName(uri.name)) {
    throw new ComemError(
      'PERMISSION_DENIED',
      `${uri.name} 是元数据文件，必须通过元数据文件 API 读写：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
  if (isArtifactName(uri.name)) {
    throw new ComemError(
      'PERMISSION_DENIED',
      `这个文件名由 CoMem 内部使用，不能作为写入目标：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
}

/**
 * 递归统计文件数（不含目录）。
 *
 * `remove` 用它在删除前算出返回值：删除后再数就没得数了。临时文件与锁文件是
 * 运行时产物，不算「删掉的文件」。
 */
async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (isArtifactName(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      count += await countFiles(join(directory, entry.name));
      continue;
    }
    count += 1;
  }
  return count;
}
