/**
 * 版本快照、截断与回退（W98，架构文档 §11.11）。
 *
 * 一次覆盖写不再永久销毁旧值。`upsertMemory` 在写新文档之前，如果磁盘上的文档
 * `status = 'active'` 且正文真的变了，就把**旧文档原样**写成一份版本文件，放在
 * 记忆类型目录下的 `.history/` 里（路径镜像 identity 的相对路径）：
 *
 * ```
 * memories/preferences/code-style.md                       ← 规范文件（当前有效）
 * memories/preferences/.history/code-style.md--20261110T022746123Z.md
 *                                                           ← 旧值，valid_until 非空
 * ```
 *
 * 两份文件的差别只有三处：版本文件带 `valid_until = 写入时刻`、带旧值自己的
 * `valid_from`、文件名带时间戳；正文与其它字段逐字节相同。新文档写
 * `valid_from = 写入时刻`、`supersedes = 版本文件 URI`，于是「这条记忆从哪一刻开始
 * 有效、顶替了哪一份」都在文件里说得清。
 *
 * 检索默认看不到版本文件：`node.valid_until` 非空，`search` 的 `asOf` 过滤把它挡在
 * 外面。它只能按 URI 直接 `read`——版本没有独立入口是刻意的（不加工具、不加接口）。
 *
 * 每个 identity 只留最新 `MAX_VERSIONS` 份。版本文件**不参与 TTL**：清扫的两条 SQL
 * 都带 `NOT_VERSION_FILE_SQL`（`adapters/sqlite/node-repository.ts`），配什么
 * `memory.ttl.*` 都动不到 `.history`，所以磁盘有界只靠这里的截断。
 *
 * `pending` 的旧值不快照（`pending` 不是有效值，没有「正确的旧值」可言），但新文档
 * **继承**它的 `supersedes`：否则拒绝一次基于 pending 的覆盖写会丢掉上一条有效版本
 * 的指向，`reject` 就回不到写入前。
 */

import { getMemoryType } from '../../domain/memory-types/index.js';
import type { Logger } from '../../domain/log.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';
import { Uri } from '../../domain/uri.js';
import { serializeMemoryDocument, type MemoryDocument } from './document.js';
import {
  listDirectoryOrEmpty,
  readMemoryDocument,
  type MemoryFileStore,
} from './ports.js';

/**
 * 每个 identity 保留的版本文件数上限（W98）。
 *
 * 来源：经验假设。目的是「回到上一次正确值」——回滚的粒度是上一次覆盖写，5 步
 * 够覆盖连续几次错误写入；同时把每个 identity 的历史占用固定在 5 份以内（一份约与
 * 规范文件同量级）。
 *
 * 这是版本文件**唯一**的删除点：TTL 不碰它们（`node-repository.ts` 的两条清扫 SQL
 * 都带 `NOT_VERSION_FILE_SQL`，按路径段排除 `.history`），与 `defaultDays` /
 * `retentionDays` 取值无关。所以「`supersedes` 回不去」只可能由这里造成。
 */
const MAX_VERSIONS = 5;

/**
 * 版本文件所在的隐藏目录（记忆类型目录下，如 `memories/preferences/.history/`）。
 *
 * 它不是保留名（`adapters/fs/path.ts` 的 `RESERVED_NAMES`）：`glob` / `grep` /
 * `list` / `tree` 是路径工具，契约是磁盘，应当看得到版本文件。检索面看不到它们
 * 靠的是 `valid_until` 过滤，不是目录名。
 */
export const HISTORY_DIRECTORY = '.history';

/**
 * 版本文件名里时间戳之后的形态：`YYYYMMDDTHHMMSSmmmZ`，同一毫秒内撞名时追加
 * `-1`、`-2`。
 *
 * 时间戳不带冒号与点，Windows 上也能直接当文件名。定长，所以按字符串排序与按时间
 * 排序等价（截断依赖这一点）。
 */
const VERSION_NAME_PATTERN = /^(\d{8}T\d{6}\d{3}Z)(?:-(\d+))?\.md$/;

/**
 * 版本文件名里的时间戳：`Date#toISOString()` 去掉 `-`、`:`、`.`。
 *
 * `2026-11-10T02:27:46.123Z` → `20261110T022746123Z`。定长、无冒号（冒号在 Windows
 * 文件名里非法），所以同一时刻的两次写入只可能因为毫秒相同而撞名，撞名由调用方
 * 追加 `-1`、`-2` 解决。
 */
function versionStamp(now: string): string {
  return now.replace(/[-:.]/g, '');
}

/**
 * 把磁盘上的旧文档快照成一份版本文件，返回它的 URI。
 *
 * 路径：`{scope}/{schema.directory}/.history/{identity 相对路径}--{stamp}.md`。
 * identity 的相对路径从**规范 URI** 里切出来（`upsertMemory` 刚校验过它等于
 * `renderMemoryUri` 的结果），所以 `rules` 的 `{scenario}/{rule}.md` 那层目录在
 * `.history` 里原样镜像，不需要第二份路径渲染。
 *
 * 内容与原文档的差别只有三处：frontmatter 的 `uri` 换成版本文件自己的地址、
 * `valid_until` 是本次写入的时刻、`valid_from` 沿用旧值自己的起点（缺键时退回
 * `created_at`，否则旧版本会变成「不知道从何时开始有效」，检索无法判断它是否
 * 在某个过去时刻有效）。
 */
export async function writeVersionSnapshot(
  filesystem: MemoryFileStore,
  logger: Logger,
  scopeUri: Uri,
  schema: MemoryTypeSchema,
  identityUri: Uri,
  document: MemoryDocument,
  now: string,
): Promise<Uri> {
  const directorySegments = schema.directory.split('/');
  const mirror = identityUri.segments.slice(scopeUri.depth + directorySegments.length);
  const directory = scopeUri.child(
    ...directorySegments,
    HISTORY_DIRECTORY,
    ...mirror.slice(0, -1),
  );
  const name = mirror.at(-1) ?? '';
  const stamp = versionStamp(now);

  let versionUri = directory.child(`${name}--${stamp}.md`);
  // 同一毫秒内的第二次快照会撞名（两次写入落在同一毫秒）。追加 `-1`、`-2`，
  // 与截断的排序规则一致：同一个 stamp 里序号大的更新。
  for (let collision = 1; (await filesystem.stat(versionUri)) !== null; collision += 1) {
    versionUri = directory.child(`${name}--${stamp}-${collision}.md`);
  }

  await filesystem.write(
    versionUri,
    serializeMemoryDocument({
      uri: versionUri,
      memoryType: document.memoryType,
      status: document.status,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      schema,
      fields: document.fields,
      sources: document.sources,
      validFrom: document.validFrom ?? (document.createdAt === '' ? null : document.createdAt),
      validUntil: now,
      supersedes: document.supersedes,
    }),
  );
  await truncateVersions(filesystem, logger, directory, name);

  logger.info('记忆旧值已存为版本', {
    uri: identityUri.toString(),
    version: versionUri.toString(),
    memoryType: schema.type,
  });
  return versionUri;
}

/**
 * 每个 identity 只留最新 `MAX_VERSIONS` 份版本文件，按 stamp 升序删最旧。
 *
 * 只处理同一个 `baseName` 的文件：`.history` 目录里可能有多个 identity 的版本
 * （`rules` 的镜像目录里一个 scenario 下有多条规则），互相不能算进对方的配额。
 * 删不掉只记 warn 不抛错：写盘已经成功，截断失败不该让这次记忆写入失败——下一轮
 * 覆盖写会再试一次。
 */
async function truncateVersions(
  filesystem: MemoryFileStore,
  logger: Logger,
  directory: Uri,
  baseName: string,
): Promise<void> {
  const prefix = `${baseName}--`;
  const versions: { readonly uri: Uri; readonly stamp: string; readonly collision: number }[] = [];
  for (const entry of await listDirectoryOrEmpty(filesystem, directory)) {
    if (entry.kind !== 'file' || !entry.uri.name.startsWith(prefix)) {
      continue;
    }
    const matched = VERSION_NAME_PATTERN.exec(entry.uri.name.slice(prefix.length));
    if (matched === null) {
      continue;
    }
    versions.push({
      uri: entry.uri,
      stamp: matched[1] ?? '',
      collision: Number(matched[2] ?? 0),
    });
  }
  if (versions.length <= MAX_VERSIONS) {
    return;
  }

  versions.sort((left, right) =>
    left.stamp === right.stamp
      ? left.collision - right.collision
      : left.stamp < right.stamp
        ? -1
        : 1,
  );
  for (const oldest of versions.slice(0, versions.length - MAX_VERSIONS)) {
    try {
      await filesystem.remove(oldest.uri);
    } catch (error) {
      logger.warn('旧版本文件删除失败，保留待下次截断', {
        uri: oldest.uri.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 把 `supersedes` 指向的版本写回规范 URI，返回被恢复的版本 URI。
 *
 * 恢复出来的文档取版本文件自己的字段与时间戳：目标是「与写入前的那份文件相同」，
 * 所以不刷新 `updated_at`，也不重新过复核闸门（那个版本本来就是 active 的）。
 * 版本文件本身留在 `.history`（它的 `valid_until` 仍然非空，检索看不到它）。
 *
 * 任何一种「恢复不了」都返回 `null`，由调用方维持删除：`supersedes` 不是合法
 * URI、指向的文件不存在、或那个文件已经读不出记忆类型。这些都不该让一次拒绝
 * 失败——拒绝的语义是「别留下这条 pending」。
 */
export async function restoreSuperseded(
  filesystem: MemoryFileStore,
  logger: Logger,
  uri: Uri,
  document: MemoryDocument,
): Promise<Uri | null> {
  if (document.supersedes === null) {
    return null;
  }
  const previousUri = Uri.tryParse(document.supersedes);
  if (previousUri === null) {
    logger.warn('记忆的 supersedes 不是合法 URI，拒绝时按删除处理', {
      uri: uri.toString(),
      supersedes: document.supersedes,
    });
    return null;
  }
  const previous = await readMemoryDocument(filesystem, logger, previousUri);
  if (previous === null) {
    logger.warn('记忆的 supersedes 指向的文件不存在，拒绝时按删除处理', {
      uri: uri.toString(),
      supersedes: document.supersedes,
    });
    return null;
  }
  const schema = getMemoryType(previous.memoryType);
  if (schema === undefined) {
    logger.warn('记忆的 supersedes 指向未知的记忆类型，拒绝时按删除处理', {
      uri: uri.toString(),
      supersedes: document.supersedes,
      memoryType: previous.memoryType,
    });
    return null;
  }

  await filesystem.write(
    uri,
    serializeMemoryDocument({
      uri,
      memoryType: previous.memoryType,
      status: previous.status,
      createdAt: previous.createdAt,
      updatedAt: previous.updatedAt,
      schema,
      fields: previous.fields,
      sources: previous.sources,
      validFrom: previous.validFrom,
      // 又有效了：清掉终点，检索重新看得到它。
      validUntil: null,
      supersedes: previous.supersedes,
    }),
  );
  return previousUri;
}
