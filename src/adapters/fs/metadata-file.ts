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
 * 1. **单文件原子、双文件同代**：同目录临时文件（`TEMP_FILE_PREFIX`）→ `fsync` →
 *    `rename`。同一目录的 `writeSummary` 调用串行执行，两个文件先都写好临时文件，
 *    再依次改名，避免两代写入互相穿插。
 * 2. **frontmatter 可带可剥**：读只返回正文（调用方拿到的是可以直接注入模型的
 *    文本），写的时候带上生成信息（`generated_by` / `generated_at` / `degraded`）。
 *    磁盘上已有的其它键（`freshness` 等）原样保留，与 `ContentStore` 的元数据
 *    写保护（§10.6）一致。
 * 3. **错误只有一种形状**：文件系统错误全部收敛成 `ComemError`，`ENOENT` 在
 *    `readSummary` 里被吞掉。
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ArchiveMeta,
  ArchivePhase1,
  CommitStepName,
  SkippedCommitStep,
} from '../../domain/archive.js';
import { isArchivePhaseStatus, isCommitStepName } from '../../domain/archive.js';
import { ComemError } from '../../domain/errors.js';
import { fsErrorCode } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type { Logger } from '../../domain/log.js';
import { normalizeProjectId } from '../../domain/project.js';
import type { SessionMeta } from '../../domain/session.js';
import { isSessionStatus } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { writeFileAtomic } from './atomic-write.js';
import { createFsErrorMapper } from './error-map.js';
import { toDiskPath } from './path.js';
import {
  SummaryFileStore,
  type SummaryFileContent,
  type SummaryGeneration,
} from './summary-file-store.js';

export { ABSTRACT_FILE_NAME, OVERVIEW_FILE_NAME } from './summary-file-store.js';
export type {
  SummaryFileContent,
  SummaryGeneration,
} from './summary-file-store.js';

export const META_FILE_NAME = '.meta.json';

export interface MetadataFileStoreDeps {
  readonly dataDir: string;
  readonly logger: Logger;
}

/**
 * 本适配器的 errno → `ComemError` 映射（架构文档 §19）。公共表与机制在
 * `error-map.ts`，这里只声明覆盖项与本层自己的文案。
 *
 * **`ENOTDIR` 覆盖成 `NOT_FOUND`**：这里面对的是「没有这个元数据文件」——上层多处
 * （`readSummary` / `readSession` / `readArchive`）直接把 `ENOTDIR` 当成「文件不存在」
 * 吞掉，映射成 `INVALID_ARGUMENT` 会与吞掉行为自相矛盾。`content-store` 对
 * `ENOTDIR` 用 `INVALID_ARGUMENT`（路径段是文件），那是有意保留的差异，
 * 见 `tests/integration/fs/error-map-consistency.test.ts`。
 *
 * 摘要文件是内部产物，`ENOENT` 在 `readSummary` 里被当成「没有摘要」吞掉；其余错误
 * （磁盘满、权限、目录被当成文件）都是真故障，必须让调用方看到。
 *
 * 导出是为了让一致性测试调用**适配器实际使用的映射**，不是一份测试专用的表。
 */
export const mapFsError = createFsErrorMapper(
  { ENOTDIR: 'NOT_FOUND' },
  {
    INVALID_ARGUMENT: '摘要文件路径类型不匹配',
    NOT_FOUND: '摘要文件不存在',
    PERMISSION_DENIED: '没有权限读写摘要文件',
    ALREADY_EXISTS: '摘要文件已存在',
    INTERNAL: '摘要文件系统操作失败',
  },
);

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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCommitStepNameArray(value: unknown): value is readonly CommitStepName[] {
  return isStringArray(value) && value.every(isCommitStepName);
}

/**
 * 一项「被跳过的步骤」。
 *
 * 原因只接受领域契约中的白名单值，未知值按损坏元数据处理。
 */
function isSkippedCommitStep(value: unknown): value is SkippedCommitStep {
  if (!isRecord(value)) {
    return false;
  }
  const step = value['step'];
  return (
    typeof step === 'string' &&
    isCommitStepName(step) &&
    (value['reason'] === 'llm_disabled' || value['reason'] === 'llm_unconfigured')
  );
}

function isSkippedCommitStepArray(value: unknown): value is readonly SkippedCommitStep[] {
  return Array.isArray(value) && value.every(isSkippedCommitStep);
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
    throw corruptMetadata(uri, 'phase1.status 不是 preparing | ready');
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
  const projectId = readProjectId(value['projectId'], uri);
  const rawDone = value['stepsDone'];
  const stepsDone = Array.isArray(rawDone) ? rawDone.map((step: unknown) => step === 'experience_distill' ? 'dreamer' : step) : rawDone;
  const rawSkipped = value['skippedSteps'] ?? [];
  const skippedSteps = Array.isArray(rawSkipped) ? rawSkipped.map((item: unknown) =>
    isRecord(item) && item['step'] === 'experience_distill' ? { ...item, step: 'dreamer' } : item) : rawSkipped;
  const taskId = value['taskId'];
  if (typeof archiveId !== 'string') {
    throw corruptMetadata(uri, 'archiveId 不是字符串');
  }
  if (!isCommitStepNameArray(stepsDone)) {
    throw corruptMetadata(uri, 'stepsDone 不是步骤名数组');
  }
  if (!isSkippedCommitStepArray(skippedSteps)) {
    throw corruptMetadata(uri, 'skippedSteps 不是 { step, reason } 数组');
  }
  if (taskId !== null && typeof taskId !== 'string') {
    throw corruptMetadata(uri, 'taskId 不是字符串或 null');
  }
  const archiveMeta: ArchiveMeta = {
    archiveId,
    phase1: toArchivePhase1(value['phase1'], uri),
    stepsDone,
    skippedSteps,
    taskId,
  };
  return projectId === undefined ? archiveMeta : { ...archiveMeta, projectId };
}

function toSessionMeta(value: unknown, uri: Uri): SessionMeta {
  if (!isRecord(value)) {
    throw corruptMetadata(uri, '不是对象');
  }
  const sessionId = value['sessionId'];
  const userId = value['userId'];
  const status = value['status'];
  const projectId = readProjectId(value['projectId'], uri);
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
  const sessionMeta: SessionMeta = {
    sessionId,
    userId,
    status,
    createdAt,
    commitCount,
    lastCommitAt,
    pendingTokens,
  };
  return projectId === undefined ? sessionMeta : { ...sessionMeta, projectId };
}

function readProjectId(value: unknown, uri: Uri): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw corruptMetadata(uri, 'projectId 不是字符串');
  }
  try {
    return normalizeProjectId(value);
  } catch {
    throw corruptMetadata(uri, 'projectId 不是合法的单路径段');
  }
}

export class MetadataFileStore {
  readonly #dataDir: string;
  readonly #logger: Logger;
  readonly #summaries: SummaryFileStore;

  constructor(deps: MetadataFileStoreDeps) {
    this.#dataDir = deps.dataDir;
    this.#logger = deps.logger;
    this.#summaries = new SummaryFileStore({
      dataDir: deps.dataDir,
      logger: deps.logger,
      mapError: mapFsError,
    });
  }

  /**
   * 读目录的 L0 + L1；缺哪个就把哪个当空串。
   *
   * **目录不存在不抛错**：摘要缺失是正常状态（从没生成过摘要的目录、刚建的目录），
   * 抛错会逼每个调用方先 `exists` 再读，而那个判断在并发下没有意义。
   */
  async readSummary(directoryUri: Uri): Promise<SummaryFileContent> {
    return this.#summaries.read(directoryUri);
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
    await this.#summaries.write(directoryUri, abstract, overview, generation);
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
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await writeFileAtomic(absolute, content, (error) => mapFsError(error, directoryUri));
  }

  async #ensureDirectory(directory: string, directoryUri: Uri): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw mapFsError(error, directoryUri);
    }
  }
}
