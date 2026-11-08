/**
 * 元数据文件读写（架构文档 §6.6、§6.7、§9.1、§10.1）。
 *
 * 这里管两类保留名文件，它们都不进 `ContentStore`（`Uri` 拒绝它们作为普通路径段，
 * 所以按「目录 URI」定位文件，不按文件 URI）：
 *
 * | 文件 | 描述什么 | 读写方法 |
 * |---|---|---|
 * | `.abstract.md` / `.overview.md` | 目录的一句话摘要（L0）与完整概览（L1） | `readSummary` / `writeSummary` |
 * | `.meta.json` | 会话元数据（`SessionMeta`）与归档元数据（`ArchiveMeta`） | `readSession` / `writeSession` / `readArchive` / `writeArchive` |
 *
 * **`node:fs` 只允许出现在 `adapters/`**（§4.2）。`.meta.json` 的读写必须在这里，
 * 不能在 `services/session.ts` 里做：那会让应用层直接依赖文件系统，领域层与用例层
 * 就无法用内存数据穷举测试，而且 errno → `ComemError` 的映射会各写一份、走样。
 *
 * 摘要缺失是**正常状态**（新建目录、还没生成过摘要），不是错误：`readSummary` 对
 * 不存在的文件返回空串，调用方看到空串再决定降级（例如用标题树合成骨架概览，
 * 见 `domain/summary.ts` 的 `skeletonOverview`）。`.meta.json` 同理：不存在返回
 * `null`，由调用方决定「没有会话」是否算 `NOT_FOUND`。
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

import type {
  ArchiveMeta,
  ArchivePhase1,
  ArchivePhaseStatus,
  CommitStepName,
} from '../../domain/archive.js';
import type { ComemErrorCode } from '../../domain/errors.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { SessionMeta, SessionStatus } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { parseDocument, serializeDocument } from './frontmatter.js';
import { TEMP_FILE_PREFIX, toDiskPath } from './path.js';

/** L0 摘要文件名（架构文档 §6.2 规则 6 的保留名之一）。 */
export const ABSTRACT_FILE_NAME = '.abstract.md';

/** L1 概览文件名（同上）。 */
export const OVERVIEW_FILE_NAME = '.overview.md';

/** 会话 / 归档目录里元数据的文件名（同上）。 */
export const META_FILE_NAME = '.meta.json';

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

/** 阶段一的提交步骤名集合（`domain/archive.ts` 的 `CommitStepName`）。 */
const COMMIT_STEP_NAMES: ReadonlySet<string> = new Set<CommitStepName>([
  'archive_summary',
  'memory_extract',
  'memory_merge',
  'summary_invalidate',
]);

/** 会话状态集合（`domain/session.ts` 的 `SessionStatus`）。 */
const SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  'open',
  'committing',
  'committed',
  // 空闲过期的终态（`session.expiry.action: archive`）。漏掉它时归档写盘成功、读回
  // 却抛 INTERNAL——「归档了一个会话，之后它从列表里消失」。
  'archived',
  'failed',
]);

/**
 * 磁盘上的 `.meta.json` 是本模块自己写的；内容不合法说明数据被改坏了，是程序缺陷。
 *
 * 用 `INTERNAL` 而不是 `INVALID_ARGUMENT`：调用方没有传错参数，是我们的写入方
 * （或者手工改文件的用户）破坏了格式。按 `INVALID_ARGUMENT` 报出去会让上层以为
 * 该去改请求。
 */
function corruptMetadata(uri: Uri, reason: string): ComemError {
  return new ComemError('INTERNAL', `元数据文件内容不合法：${uri.toString()}（${reason}）`, {
    uri: uri.toString(),
    reason,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCommitStepName(value: string): value is CommitStepName {
  return COMMIT_STEP_NAMES.has(value);
}

function isCommitStepNameArray(value: unknown): value is readonly CommitStepName[] {
  return isStringArray(value) && value.every(isCommitStepName);
}

function isArchivePhaseStatus(value: unknown): value is ArchivePhaseStatus {
  return value === 'preparing' || value === 'ready' || value === 'failed';
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && SESSION_STATUSES.has(value);
}

function toArchivePhase1(value: unknown, uri: Uri): ArchivePhase1 {
  if (!isRecord(value)) {
    throw corruptMetadata(uri, 'phase1 不是对象');
  }
  const status = value['status'];
  const messagesSha256 = value['messagesSha256'];
  const archivedMessageIds = value['archivedMessageIds'];
  const retainedMessageIds = value['retainedMessageIds'];
  if (!isArchivePhaseStatus(status)) {
    throw corruptMetadata(uri, 'phase1.status 不是 preparing | ready | failed');
  }
  if (typeof messagesSha256 !== 'string') {
    throw corruptMetadata(uri, 'phase1.messagesSha256 不是字符串');
  }
  if (!isStringArray(archivedMessageIds) || !isStringArray(retainedMessageIds)) {
    throw corruptMetadata(uri, 'phase1 的消息 ID 不是字符串数组');
  }
  return { status, messagesSha256, archivedMessageIds, retainedMessageIds };
}

function toArchiveMeta(value: unknown, uri: Uri): ArchiveMeta {
  if (!isRecord(value)) {
    throw corruptMetadata(uri, '不是对象');
  }
  const archiveId = value['archiveId'];
  const stepsDone = value['stepsDone'];
  const taskId = value['taskId'];
  if (typeof archiveId !== 'string') {
    throw corruptMetadata(uri, 'archiveId 不是字符串');
  }
  if (!isCommitStepNameArray(stepsDone)) {
    throw corruptMetadata(uri, 'stepsDone 不是步骤名数组');
  }
  if (taskId !== null && typeof taskId !== 'string') {
    throw corruptMetadata(uri, 'taskId 不是字符串或 null');
  }
  return { archiveId, phase1: toArchivePhase1(value['phase1'], uri), stepsDone, taskId };
}

function toSessionMeta(value: unknown, uri: Uri): SessionMeta {
  if (!isRecord(value)) {
    throw corruptMetadata(uri, '不是对象');
  }
  const sessionId = value['sessionId'];
  const userId = value['userId'];
  const status = value['status'];
  const createdAt = value['createdAt'];
  const commitCount = value['commitCount'];
  const lastCommitAt = value['lastCommitAt'];
  const pendingTokens = value['pendingTokens'];
  if (typeof sessionId !== 'string' || typeof userId !== 'string') {
    throw corruptMetadata(uri, 'sessionId / userId 不是字符串');
  }
  if (!isSessionStatus(status)) {
    throw corruptMetadata(uri, 'status 不是合法的会话状态');
  }
  if (typeof createdAt !== 'string') {
    throw corruptMetadata(uri, 'createdAt 不是字符串');
  }
  if (typeof commitCount !== 'number' || !Number.isInteger(commitCount) || commitCount < 0) {
    throw corruptMetadata(uri, 'commitCount 不是非负整数');
  }
  if (lastCommitAt !== null && typeof lastCommitAt !== 'string') {
    throw corruptMetadata(uri, 'lastCommitAt 不是字符串或 null');
  }
  if (typeof pendingTokens !== 'number' || !Number.isFinite(pendingTokens)) {
    throw corruptMetadata(uri, 'pendingTokens 不是数字');
  }
  return { sessionId, userId, status, createdAt, commitCount, lastCommitAt, pendingTokens };
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

  /**
   * 读会话元数据（`sessions/sess_NNN/.meta.json`）。不存在返回 `null`。
   *
   * 与 `readSummary` 同一套语义：**没有文件是正常状态**，不是错误。会话是否存在的
   * 判定属于用例层（`SessionService.#requireSession` 抛 `NOT_FOUND`），适配层不替
   * 调用方决定「读不到」该不该是异常。
   */
  async readSession(sessionUri: Uri): Promise<SessionMeta | null> {
    const raw = await this.#readMetadata(sessionUri);
    return raw === null ? null : toSessionMeta(raw, sessionUri);
  }

  async writeSession(sessionUri: Uri, meta: SessionMeta): Promise<void> {
    await this.#writeMetadata(sessionUri, meta);
    this.#logger.debug('写入会话元数据', {
      uri: sessionUri.toString(),
      commitCount: meta.commitCount,
    });
  }

  /** 读归档元数据（`history/archive_NNN/.meta.json`）。不存在返回 `null`。 */
  async readArchive(archiveUri: Uri): Promise<ArchiveMeta | null> {
    const raw = await this.#readMetadata(archiveUri);
    return raw === null ? null : toArchiveMeta(raw, archiveUri);
  }

  async writeArchive(archiveUri: Uri, meta: ArchiveMeta): Promise<void> {
    await this.#writeMetadata(archiveUri, meta);
    this.#logger.debug('写入归档元数据', {
      uri: archiveUri.toString(),
      status: meta.phase1.status,
    });
  }

  /**
   * 读一个目录下的 `.meta.json`；不存在返回 `null`。
   *
   * JSON 解析失败抛 `INTERNAL`：`.meta.json` 只由本模块写，磁盘上出现非法 JSON
   * 说明文件被手工改坏了，这是程序缺陷级别的问题，不是调用方能修的输入错误。
   */
  async #readMetadata(directoryUri: Uri): Promise<unknown | null> {
    const absolute = join(toDiskPath(this.#dataDir, directoryUri), META_FILE_NAME);
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
    try {
      return JSON.parse(raw);
    } catch {
      throw corruptMetadata(directoryUri, '不是合法 JSON');
    }
  }

  /**
   * 原子写一个目录下的 `.meta.json`：同目录临时文件 → `fsync` → `rename`。
   *
   * 键顺序由调用方传入的对象决定（`SessionMeta` / `ArchiveMeta` 的字段顺序），
   * 与 `.acl.json` 一致：磁盘上的文件要能稳定 diff，键顺序随实现漂移会让每次
   * 提交都产生噪声。末尾带换行，与其它手写 JSON 文件一致。
   */
  async #writeMetadata(directoryUri: Uri, value: unknown): Promise<void> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    await this.#ensureDirectory(directory, directoryUri);

    const absolute = join(directory, META_FILE_NAME);
    const temp = join(directory, `${TEMP_FILE_PREFIX}${randomTempSuffix()}`);
    let handle: FileHandle;
    try {
      // `wx`：临时文件名撞上已存在的文件时直接失败，不复用别人的半成品。
      handle = await open(temp, 'wx');
    } catch (error) {
      throw mapFsError(error, directoryUri);
    }

    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      // 没有 fsync 的话，rename 之后断电可能留下空文件——「写了一半」的另一种形态。
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapFsError(error, directoryUri);
    }

    await this.#rename(temp, absolute, directoryUri);
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
