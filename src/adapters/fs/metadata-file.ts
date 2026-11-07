/**
 * 目录摘要文件读写（架构文档 §6.6、§6.7、§9.1）。
 *
 * 一个目录的 L0 / L1 摘要是它自己的两个文件：`.abstract.md`（一句话）与
 * `.overview.md`（完整概览）。两者都是**保留名**——`Uri` 拒绝它们作为普通路径段，
 * 所以这一层按「目录 URI」定位文件，不按文件 URI。
 *
 * 摘要缺失是**正常状态**（新建目录、还没生成过摘要），不是错误：`readSummary` 对
 * 不存在的文件返回空串，调用方看到空串再决定降级（例如用标题树合成骨架概览，
 * 见 `domain/summary.ts` 的 `skeletonOverview`）。
 *
 * 三个不变量：
 *
 * 1. **原子写**：同目录临时文件（`TEMP_FILE_PREFIX`）→ `fsync` → `rename`。任何
 *    时刻读到的摘要要么是旧的完整内容，要么是新的完整内容。两个文件先各写一份
 *    临时文件、再依次改名，把「L0 已更新、L1 还是旧的」的窗口压到两次 rename 之间。
 * 2. **frontmatter 可带可剥**：读只返回正文（调用方拿到的是可以直接注入模型的
 *    文本），写的时候带上生成信息（`generated_by` / `generated_at` / `degraded`）。
 *    磁盘上已有的其它键（`freshness` 等）原样保留，与 `ContentStore` 的元数据
 *    写保护（§10.6）一致。
 * 3. **错误只有一种形状**：文件系统错误全部收敛成 `ComemError`，`ENOENT` 在
 *    `readSummary` 里被吞掉。
 */

import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ComemErrorCode } from '../../domain/errors.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import { parseDocument, serializeDocument } from './frontmatter.js';
import { TEMP_FILE_PREFIX, toDiskPath } from './path.js';

/** L0 摘要文件名（架构文档 §6.2 规则 6 的保留名之一）。 */
export const ABSTRACT_FILE_NAME = '.abstract.md';

/** L1 概览文件名（同上）。 */
export const OVERVIEW_FILE_NAME = '.overview.md';

/**
 * 生成信息。字段名是磁盘上的 YAML 键（snake_case，§6.7 的示例）。
 *
 * `degraded` 必须对调用方可见：静默降级等于骗人（§17.9）。断网时走规则摘要，
 * 模型看到的概览质量会明显下降，这个标记是它判断「要不要重试」的依据。
 */
export interface SummaryGeneration {
  readonly generatedBy: 'llm' | 'rule';
  /** ISO 8601；不传则由调用方决定是否落盘（重放时保持原值） */
  readonly generatedAt?: string;
  readonly degraded?: boolean;
}

export interface SummaryFileContent {
  /** 正文（不含 frontmatter）；文件不存在时是空串 */
  readonly abstract: string;
  readonly overview: string;
  /** 两个文件是否都存在 */
  readonly complete: boolean;
  /**
   * 生成信息；两个文件都没有 frontmatter 时为 `null`。
   *
   * **必须回填**：调用方（控制台的监控页、`health` 工具）靠 `degraded` 区分「模型
   * 生成的摘要」和「断网时规则拼出来的摘要」。少了这个字段，`degraded` 只能恒为
   * `false`，断网降级就变成静默降级（§9.2、§17.9）。
   *
   * L0 与 L1 是同一次生成写的，取非空的优先；两者不一致时以 L1 为准。
   */
  readonly generation: SummaryGeneration | null;
}

export interface MetadataFileStoreDeps {
  readonly dataDir: string;
  readonly logger: Logger;
}

/**
 * 临时文件后缀的随机位数（base36），与 `content-store.ts` 保持同一形态。
 *
 * 8 位 36 进制约 41 bit 随机性，同目录并发写撞名概率可以忽略；前缀里的进程号
 * 负责区分多进程。
 */
const TEMP_SUFFIX_LENGTH = 8;

/** 磁盘键名。YAML 惯例用 snake_case，TypeScript 用 camelCase，映射只发生在这里。 */
const FRONTMATTER_KEYS = {
  generatedBy: 'generated_by',
  generatedAt: 'generated_at',
  degraded: 'degraded',
} as const;

/**
 * 文件系统 errno → 领域错误码（架构文档 §19）。表里没有的一律 INTERNAL。
 *
 * 摘要文件是内部产物，`ENOENT` 在 `readSummary` 里被当成「没有摘要」吞掉；
 * 其余错误（磁盘满、权限、目录被当成文件）都是真故障，必须让调用方看到。
 */
const ERROR_CODE_BY_FS_ERRNO: Readonly<Record<string, ComemErrorCode>> = {
  ENOENT: 'NOT_FOUND',
  ENOTDIR: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  EISDIR: 'INVALID_ARGUMENT',
  ENOSPC: 'RESOURCE_EXHAUSTED',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
};

const ERROR_MESSAGE_BY_CODE: Readonly<Record<ComemErrorCode, string>> = {
  INVALID_URI: 'URI 不合法',
  INVALID_ARGUMENT: '摘要文件路径类型不匹配',
  NOT_FOUND: '摘要文件不存在',
  UNAUTHENTICATED: '未认证',
  PERMISSION_DENIED: '没有权限读写摘要文件',
  ALREADY_EXISTS: '摘要文件已存在',
  CONFLICT: '并发写冲突',
  RESOURCE_EXHAUSTED: '磁盘空间不足',
  PROVIDER_UNAVAILABLE: '服务不可用',
  INTERNAL: '摘要文件系统操作失败',
};

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

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

/**
 * 从 frontmatter 回填生成信息；没有任何生成键时返回 `null`。
 *
 * 手工写的摘要文件可能没有这三个键，此时按「来源未知」处理（`null`），不要编造
 * `generatedBy: 'llm'`——那会让监控页把手工内容算成模型产出。
 */
function readGeneration(data: Readonly<Record<string, unknown>>): SummaryGeneration | null {
  const generatedBy = data[FRONTMATTER_KEYS.generatedBy];
  const generatedAt = data[FRONTMATTER_KEYS.generatedAt];
  const degraded = data[FRONTMATTER_KEYS.degraded];
  if (generatedBy !== 'llm' && generatedBy !== 'rule') {
    return null;
  }
  return {
    generatedBy,
    ...(typeof generatedAt === 'string' ? { generatedAt } : {}),
    ...(typeof degraded === 'boolean' ? { degraded } : {}),
  };
}

function toGenerationRecord(generation: SummaryGeneration): Record<string, unknown> {
  const record: Record<string, unknown> = {
    [FRONTMATTER_KEYS.generatedBy]: generation.generatedBy,
  };
  if (generation.generatedAt !== undefined) {
    record[FRONTMATTER_KEYS.generatedAt] = generation.generatedAt;
  }
  if (generation.degraded !== undefined) {
    record[FRONTMATTER_KEYS.degraded] = generation.degraded;
  }
  return record;
}

export class MetadataFileStore {
  readonly #dataDir: string;
  readonly #logger: Logger;

  constructor(deps: MetadataFileStoreDeps) {
    this.#dataDir = deps.dataDir;
    this.#logger = deps.logger;
  }

  /**
   * 读目录的 L0 + L1；缺哪个就把哪个当空串。
   *
   * **目录不存在不抛错**：摘要缺失是正常状态（从没生成过摘要的目录、刚建的目录），
   * 抛错会逼每个调用方先 `exists` 再读，而那个判断在并发下没有意义。
   */
  async readSummary(directoryUri: Uri): Promise<SummaryFileContent> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    const [abstract, overview] = await Promise.all([
      this.#readDocument(join(directory, ABSTRACT_FILE_NAME), directoryUri),
      this.#readDocument(join(directory, OVERVIEW_FILE_NAME), directoryUri),
    ]);

    const content: SummaryFileContent = {
      abstract: abstract?.body ?? '',
      overview: overview?.body ?? '',
      complete: abstract !== null && overview !== null,
      generation: overview?.generation ?? abstract?.generation ?? null,
    };
    this.#logger.debug('读取目录摘要', {
      uri: directoryUri.toString(),
      hasAbstract: abstract !== null,
      hasOverview: overview !== null,
    });
    return content;
  }

  /**
   * 写目录的 L0 + L1（两个文件各写一次，原子写）。
   *
   * `generation` 提供时写入生成信息 frontmatter；不提供时不额外加键，磁盘上已有的
   * 其它键仍然保留。父目录不存在时自动创建——写入方不该关心目录是否已经存在
   * （§7「写入需要先 mkdir」，与 `ContentStore.writeText` 一致）。
   */
  async writeSummary(
    directoryUri: Uri,
    abstract: string,
    overview: string,
    generation?: SummaryGeneration,
  ): Promise<void> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    await this.#ensureDirectory(directory, directoryUri);

    const abstractPath = join(directory, ABSTRACT_FILE_NAME);
    const overviewPath = join(directory, OVERVIEW_FILE_NAME);

    const abstractTemp = await this.#writeTemp(abstractPath, abstract, directoryUri, generation);
    let overviewTemp: string;
    try {
      overviewTemp = await this.#writeTemp(overviewPath, overview, directoryUri, generation);
    } catch (error) {
      // 第二个文件写不出来时清掉第一个的临时文件，不留垃圾。
      await rm(abstractTemp, { force: true }).catch(() => undefined);
      throw error;
    }

    await this.#rename(abstractTemp, abstractPath, directoryUri);
    await this.#rename(overviewTemp, overviewPath, directoryUri);

    this.#logger.debug('写入目录摘要', {
      uri: directoryUri.toString(),
      abstractChars: abstract.length,
      overviewChars: overview.length,
      degraded: generation?.degraded ?? false,
    });
  }

  /**
   * 只删摘要文件，不动目录里的内容。
   *
   * 文件不存在不算错误（`rm -f` 语义）：摘要失效之后重算之前，调用方不需要先判断
   * 它存不存在。
   */
  async removeSummary(directoryUri: Uri): Promise<void> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    for (const name of [ABSTRACT_FILE_NAME, OVERVIEW_FILE_NAME]) {
      try {
        await rm(join(directory, name), { force: true });
      } catch (error) {
        throw mapFsError(error, directoryUri);
      }
    }
    this.#logger.debug('删除目录摘要', { uri: directoryUri.toString() });
  }

  /** 读一个摘要文件的正文与生成信息；不存在返回 `null`。 */
  async #readDocument(
    absolute: string,
    directoryUri: Uri,
  ): Promise<{ readonly body: string; readonly generation: SummaryGeneration | null } | null> {
    let raw: string;
    try {
      raw = (await readFile(absolute)).toString('utf8');
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return null;
      }
      throw mapFsError(error, directoryUri);
    }
    const parsed = parseDocument(raw);
    return { body: parsed.body, generation: readGeneration(parsed.data) };
  }

  /** 读磁盘上现有的 frontmatter 键值；文件不存在返回空对象。 */
  async #readFrontmatter(
    absolute: string,
    directoryUri: Uri,
  ): Promise<Readonly<Record<string, unknown>>> {
    let raw: string;
    try {
      raw = (await readFile(absolute)).toString('utf8');
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return {};
      }
      throw mapFsError(error, directoryUri);
    }
    return parseDocument(raw).data;
  }

  /** 写一份临时文件，返回它的路径。改名由调用方在两边都写成功之后统一做。 */
  async #writeTemp(
    absolute: string,
    body: string,
    directoryUri: Uri,
    generation: SummaryGeneration | undefined,
  ): Promise<string> {
    const existing = await this.#readFrontmatter(absolute, directoryUri);
    const data =
      generation === undefined ? existing : { ...existing, ...toGenerationRecord(generation) };
    const content = serializeDocument(body, data);

    const temp = join(dirname(absolute), `${TEMP_FILE_PREFIX}${randomTempSuffix()}`);
    let handle: FileHandle;
    try {
      // `wx`：临时文件名撞上已存在的文件时直接失败，不复用别人的半成品。
      handle = await open(temp, 'wx');
    } catch (error) {
      throw mapFsError(error, directoryUri);
    }

    try {
      await handle.writeFile(content, 'utf8');
      // 没有 fsync 的话，rename 之后断电可能留下空文件——「写了一半」的另一种形态。
      await handle.sync();
      await handle.close();
      return temp;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapFsError(error, directoryUri);
    }
  }

  async #rename(temp: string, absolute: string, directoryUri: Uri): Promise<void> {
    try {
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapFsError(error, directoryUri);
    }
  }

  async #ensureDirectory(directory: string, directoryUri: Uri): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw mapFsError(error, directoryUri);
    }
  }
}
