/**
 * `.acl.json` 读写（架构文档 §6.7、§12）。
 *
 * `.acl.json` 是**保留名**（`Uri` 拒绝它作为普通路径段，§6.2 规则 6），所以这里
 * 按「目录 URI」定位文件，和 `metadata-file.ts` 的模式一致。
 *
 * ## 为什么解析必须严格
 *
 * `.acl.json` 是安全边界。一个手写笔误（`"level": "rw"`、`"effect": "allowed"`、
 * 少写 `user:` 前缀）如果被静默忽略，等于把一条 deny 变成「不存在」——用户以为
 * 自己收回了权限，实际没有。所以任何字段不合法都抛 `INVALID_ARGUMENT`，消息里
 * 带文件路径和具体字段，让人能直接定位。
 *
 * ## 未知字段要保留
 *
 * 有人会手工加注释字段（`"comment": "..."`）。读写往返时丢掉它们，下一次
 * `setAcl` 就把人的注释删了。顶层与条目级的未知键都原样保留，并且按**固定顺序**
 * 落盘：顶层 `mode` 在前、`entries` 次之，其余键升序；条目内 `principal` /
 * `level` / `effect` 在前、其余键升序。键顺序固定是为了让「同样的 ACL」产生同样
 * 的字节，`git diff` 里不出现纯噪音。`entries` 按 `principal` 升序。
 *
 * ## 原子写
 *
 * 临时文件（`TEMP_FILE_PREFIX`）→ `fsync` → `rename`。任何时刻读到的要么是旧的
 * 完整内容，要么是新的完整内容，不会读到写了一半的 JSON。
 */

import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

import { createFsErrorMapper, fsErrorCode } from './error-map.js';
import { TEMP_FILE_PREFIX, isArtifactName, toDiskPath } from './path.js';

/** 目录几何文件的名字（架构文档 §6.2 规则 6 的保留名之一）。 */
export const ACL_FILE_NAME = '.acl.json';

/**
 * §6.7 的磁盘格式：`level` 是字符串不是数字。
 *
 * 磁盘上用 `read` / `write` / `manage` 而不是 1 / 3 / 7：人得能直接读这个文件，
 * 而数字要在脑子里做一次映射（§8.2 对 `node.level` 有同样的判断）。
 */
export interface AclFileEntry {
  readonly principal: string;
  readonly level: 'read' | 'write' | 'manage';
  readonly effect: 'allow' | 'deny';
}

export interface AclFile {
  readonly mode: 'inherit' | 'restricted';
  readonly entries: readonly AclFileEntry[];
}

export interface AclFileStoreDeps {
  readonly dataDir: string;
  readonly logger: Logger;
}

export interface AclDirectoryScanOptions {
  /**
   * 最多访问多少个目录。达到上限就停，`truncated` 置 true。
   *
   * 调用方（`AclService.purgePrincipal`）用一个明确的上限把「撤权时扫全库」变成
   * 有界操作；截断时的残留风险由调用方记录并让运维处理。
   */
  readonly maxDirectories: number;
}

export interface AclDirectoryScan {
  /** 带 `.acl.json` 的目录，按 URI 升序（确定性，便于日志与测试）。 */
  readonly uris: readonly Uri[];
  /** 实际访问过的目录数（含数据根本身）。 */
  readonly directoriesScanned: number;
  /** 是否因为达到 `maxDirectories` 而提前停止。 */
  readonly truncated: boolean;
}

/**
 * 临时文件后缀的随机位数（base36），与 `metadata-file.ts` / `content-store.ts`
 * 保持同一形态。
 *
 * 8 位 36 进制约 41 bit 随机性，同目录并发写撞名概率可以忽略；前缀里的进程号
 * 负责区分多进程。
 */
const TEMP_SUFFIX_LENGTH = 8;

/** 顶层已知键。序列化时其余键按升序排在后面，读回时原样保留。 */
const TOP_LEVEL_KEYS = ['mode', 'entries'] as const;

/** 条目级已知键。同上。 */
const ENTRY_KEYS = ['principal', 'level', 'effect'] as const;

/**
 * 本适配器的 errno → `ComemError` 映射（架构文档 §19）。公共表与机制在
 * `error-map.ts`，这里只声明覆盖项与本层自己的文案。
 *
 * **`ENOTDIR` 覆盖成 `NOT_FOUND`**：这里面对的是「没有这个 ACL 文件」。`read` /
 * `exists` / `remove` 在多处直接把 `ENOTDIR` 当成「没有 ACL 文件」吞掉（目录路径段
 * 其实是个文件），映射成 `INVALID_ARGUMENT` 会把一次「没有 ACL」变成异常，改变
 * 继承语义。`content-store` 对 `ENOTDIR` 用 `INVALID_ARGUMENT`（路径段是文件），
 * 那是有意保留的差异，见 `tests/integration/fs/error-map-consistency.test.ts`。
 *
 * 其余错误（磁盘满、权限、把目录当文件）都是真故障，必须让调用方看到。
 *
 * 导出是为了让一致性测试调用**适配器实际使用的映射**，不是一份测试专用的表。
 */
export const mapFsError = createFsErrorMapper(
  { ENOTDIR: 'NOT_FOUND' },
  {
    INVALID_ARGUMENT: 'ACL 文件路径类型不匹配',
    NOT_FOUND: 'ACL 文件不存在',
    PERMISSION_DENIED: '没有权限读写 ACL 文件',
    ALREADY_EXISTS: 'ACL 文件已存在',
    INTERNAL: 'ACL 文件系统操作失败',
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAclFileLevel(value: unknown): value is AclFileEntry['level'] {
  return value === 'read' || value === 'write' || value === 'manage';
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function invalidField(absolute: string, field: string, reason: string): ComemError {
  return new ComemError(
    'INVALID_ARGUMENT',
    `.acl.json 不合法（${absolute}）的 ${field}：${reason}`,
    { path: absolute, field, reason },
  );
}

function parseEntry(raw: unknown, absolute: string, index: number): AclFileEntry {
  const field = `entries[${index}]`;
  if (!isRecord(raw)) {
    throw invalidField(absolute, field, `必须是对象，实际是 ${describe(raw)}`);
  }

  const principal = raw['principal'];
  if (typeof principal !== 'string') {
    throw invalidField(absolute, `${field}.principal`, `必须是字符串，实际是 ${describe(principal)}`);
  }
  try {
    parsePrincipal(principal);
  } catch (error) {
    throw invalidField(
      absolute,
      `${field}.principal`,
      error instanceof Error ? error.message : String(error),
    );
  }

  const level = raw['level'];
  if (!isAclFileLevel(level)) {
    throw invalidField(
      absolute,
      `${field}.level`,
      `必须是 read / write / manage 之一，实际是 ${describe(level)}`,
    );
  }

  const effect = raw['effect'];
  if (effect !== 'allow' && effect !== 'deny') {
    throw invalidField(
      absolute,
      `${field}.effect`,
      `必须是 allow 或 deny，实际是 ${describe(effect)}`,
    );
  }

  return { principal, level, effect };
}

/**
 * 严格解析磁盘内容。
 *
 * `mode` / `entries` 缺失也拒绝：一个只有 `{"entries": [...]}` 的文件无法判断
 * 「继承还是切断」，按 `inherit` 猜等于把 `restricted` 悄悄改成可继承。
 */
function parseAclFile(raw: string, absolute: string): AclFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalidField(
      absolute,
      '（顶层）',
      `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw invalidField(absolute, '（顶层）', `必须是对象，实际是 ${describe(value)}`);
  }

  const mode = value['mode'];
  if (mode !== 'inherit' && mode !== 'restricted') {
    throw invalidField(absolute, 'mode', `必须是 inherit 或 restricted，实际是 ${describe(mode)}`);
  }

  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) {
    throw invalidField(absolute, 'entries', `必须是数组，实际是 ${describe(rawEntries)}`);
  }

  const entries = rawEntries.map((rawEntry, index) => parseEntry(rawEntry, absolute, index));
  return { mode, entries };
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** 去掉已知键后剩下的未知键，按升序。 */
function unknownKeys(record: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.includes(key)) {
      unknown[key] = value;
    }
  }
  return sortRecord(unknown);
}

function comparePrincipals(left: AclFileEntry, right: AclFileEntry): number {
  if (left.principal < right.principal) {
    return -1;
  }
  return left.principal > right.principal ? 1 : 0;
}

/**
 * 序列化。
 *
 * `existing` 是磁盘上现有的对象（不存在或不是合法 JSON 时为 `null`），用来保留
 * 未知字段。条目的未知字段按 `principal` 找回：同一个主体在同一节点上出现两次
 * （allow + deny）是 domain 允许的（deny 优先，§12.2），此时两条会共用同一份
 * 未知字段——这是可接受的，注释本身不属于任何一条授权的语义。
 */
function serializeAclFile(acl: AclFile, existing: Record<string, unknown> | null): string {
  const entryUnknown = new Map<string, Record<string, unknown>>();
  const existingEntries = existing?.['entries'];
  if (Array.isArray(existingEntries)) {
    for (const raw of existingEntries) {
      if (isRecord(raw) && typeof raw['principal'] === 'string') {
        entryUnknown.set(raw['principal'], unknownKeys(raw, ENTRY_KEYS));
      }
    }
  }

  const entries = [...acl.entries].sort(comparePrincipals).map((entry) => ({
    principal: entry.principal,
    level: entry.level,
    effect: entry.effect,
    ...entryUnknown.get(entry.principal),
  }));

  const top = existing === null ? {} : unknownKeys(existing, TOP_LEVEL_KEYS);
  return `${JSON.stringify({ mode: acl.mode, entries, ...top }, null, 2)}\n`;
}

function randomTempSuffix(): string {
  return `${process.pid.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 2 + TEMP_SUFFIX_LENGTH)}`;
}

export class AclFileStore {
  readonly #dataDir: string;
  readonly #logger: Logger;

  constructor(deps: AclFileStoreDeps) {
    this.#dataDir = deps.dataDir;
    this.#logger = deps.logger;
  }

  /**
   * 读目录的 ACL；文件不存在返回 `null`。
   *
   * 返回 `null` 而不是空 `AclFile`：「没有 ACL 文件」和「有 ACL 文件但 entries
   * 为空」语义不同——前者是纯继承，后者是 `restricted` 切断继承后的空授权。
   */
  async read(directoryUri: Uri): Promise<AclFile | null> {
    const absolute = this.#path(directoryUri);
    let raw: string;
    try {
      raw = (await readFile(absolute)).toString('utf8');
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        this.#logger.debug('ACL 文件不存在', { uri: directoryUri.toString() });
        return null;
      }
      throw mapFsError(error, directoryUri);
    }

    const acl = parseAclFile(raw, absolute);
    this.#logger.debug('读取 ACL 文件', {
      uri: directoryUri.toString(),
      mode: acl.mode,
      entries: acl.entries.length,
    });
    return acl;
  }

  /** 原子写。父目录不存在时自动创建（§7「写入需要先 mkdir」）。 */
  async write(directoryUri: Uri, acl: AclFile): Promise<void> {
    const absolute = this.#path(directoryUri);
    await this.#ensureDirectory(dirname(absolute), directoryUri);

    const existing = await this.#readRawObject(absolute, directoryUri);
    const content = serializeAclFile(acl, existing);
    await this.#writeAtomic(absolute, content, directoryUri);

    this.#logger.debug('写入 ACL 文件', {
      uri: directoryUri.toString(),
      mode: acl.mode,
      entries: acl.entries.length,
      bytes: content.length,
    });
  }

  /** 只删 ACL 文件，不动目录里的内容。不存在不算错误（`rm -f` 语义）。 */
  async remove(directoryUri: Uri): Promise<void> {
    const absolute = this.#path(directoryUri);
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return;
      }
      throw mapFsError(error, directoryUri);
    }
    this.#logger.debug('删除 ACL 文件', { uri: directoryUri.toString() });
  }

  /**
   * 目录下是否有 ACL 文件。
   *
   * 用 `stat().isFile()` 而不是「能 stat 到就算」：一个名叫 `.acl.json` 的**目录**
   * 不是 ACL 文件，把它当成已存在会让根预置跳过写盘。
   */
  async exists(directoryUri: Uri): Promise<boolean> {
    const absolute = this.#path(directoryUri);
    try {
      return (await stat(absolute)).isFile();
    } catch (error) {
      const fsCode = fsErrorCode(error);
      if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
        return false;
      }
      throw mapFsError(error, directoryUri);
    }
  }

  /**
   * 扫描数据根下所有带 `.acl.json` 的目录。
   *
   * 撤权（`AclService.purgePrincipal`）不能只依赖反查表：手工改过的
   * `.acl.json` 没有对应行，按表驱动会漏掉，删掉的账号重新创建同 ID 就继承
   * 旧授权。反查表与文件不同步时以文件为准（§7），所以需要一个「文件里到底
   * 有哪些节点」的入口。
   *
   * **有界**：`maxDirectories` 是访问目录数的上限，不是文件数。达到上限后停止
   * 并返回 `truncated: true`，由调用方决定怎么记录/处理——没有上限时，一个
   * 目录很多的部署上「删一个账号」会变成不可预期的长操作。
   *
   * 只进入 `user/` 与 `group/` 两个作用域：`_meta/`、`attachments/` 不是 URI
   * 空间。符号链接不跟随（`Dirent.isDirectory()` 对链接返回 false），避免扫描
   * 逃出数据根。
   */
  async scanDirectories(options: AclDirectoryScanOptions): Promise<AclDirectoryScan> {
    const uris: Uri[] = [];
    let directoriesScanned = 0;

    const walk = async (absolute: string, segments: readonly string[]): Promise<boolean> => {
      if (directoriesScanned >= options.maxDirectories) {
        return false;
      }
      directoriesScanned += 1;

      let entries: Dirent[];
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        const fsCode = fsErrorCode(error);
        if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') {
          return true;
        }
        throw new ComemError(
          'INTERNAL',
          `扫描 .acl.json 失败（${fsCode ?? 'UNKNOWN'}）：${absolute}`,
          { path: absolute, fsCode },
        );
      }

      // 数据根本身与 `user/`、`group/` 作用域目录不是 URI；至少要有
      // `{scope}/{rootId}` 两段才是一个可寻址节点。
      if (segments.length >= 2) {
        if (entries.some((entry) => entry.isFile() && entry.name === ACL_FILE_NAME)) {
          try {
            uris.push(Uri.parse(`comem://${segments.join('/')}`));
          } catch {
            // 目录名不是合法 URI 段（手工创建的怪名字）：跳过而不是让整次撤权
            // 失败。撤权失败会让账号删不掉，失败方向更差。
            this.#logger.warn('扫描 .acl.json 时跳过无法映射成 URI 的目录', {
              path: absolute,
            });
          }
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || isArtifactName(entry.name)) {
          continue;
        }
        // 数据根下只有 user/ 与 group/ 是 URI 空间。
        if (segments.length === 0 && entry.name !== 'user' && entry.name !== 'group') {
          continue;
        }
        if (!(await walk(join(absolute, entry.name), [...segments, entry.name]))) {
          return false;
        }
      }
      return true;
    };

    const complete = await walk(this.#dataDir, []);
    // 按 URI 升序：同一份文件系统两次扫描给出同一个顺序，日志与测试可复现。
    uris.sort((left, right) => {
      const leftUri = left.toString();
      const rightUri = right.toString();
      return leftUri < rightUri ? -1 : leftUri > rightUri ? 1 : 0;
    });

    this.#logger.debug('扫描 .acl.json 完成', {
      directoriesScanned,
      aclFiles: uris.length,
      truncated: !complete,
    });
    return { uris, directoriesScanned, truncated: !complete };
  }

  #path(directoryUri: Uri): string {
    return join(toDiskPath(this.#dataDir, directoryUri), ACL_FILE_NAME);
  }

  /** 读磁盘上的原始对象，只为保留未知字段；不存在或不是对象时返回 `null`。 */
  async #readRawObject(
    absolute: string,
    directoryUri: Uri,
  ): Promise<Record<string, unknown> | null> {
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
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : null;
    } catch {
      // 现有文件写坏了也要能覆盖：未知字段保留不了，但写入方不该被旧垃圾卡住。
      return null;
    }
  }

  async #writeAtomic(absolute: string, content: string, directoryUri: Uri): Promise<void> {
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
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw mapFsError(error, directoryUri);
    }

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
