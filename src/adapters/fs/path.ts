/**
 * URI ↔ 磁盘路径（架构文档 §6.2、§6.5）。
 *
 * 磁盘布局就是 URI 的镜像：`comem://user/alice/memories/foo` 落在
 * `<dataDir>/user/alice/memories/foo`。这一层只做形状转换，不碰文件系统。
 *
 * `fromDiskPath` 是「磁盘上的文件 → 索引记录」的方向，输入可能来自 `readdir`
 * 之外的任何地方，所以必须严格拒绝越界：权限按 URI 前缀匹配，一条指向数据根
 * 之外的 URI 会绕过作用域隔离。
 */

import { isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';

import { ComemError } from '../../domain/errors.js';
import { RESERVED_SEGMENT_NAMES, Uri, type UriScope } from '../../domain/uri.js';

export interface DiskLocation {
  readonly uri: Uri;
  /** 绝对路径 */
  readonly absolute: string;
  /** 相对数据根的路径，用 `/` 分隔，与平台无关 */
  readonly relative: string;
}

const SCHEME_PREFIX = 'comem://';

/** 与 `Uri.toString` / `UriParseOptions` 一致的段分隔符。 */
const URI_SEGMENT_SEPARATOR = '/';

/**
 * 元数据文件名（架构文档 §6.2 规则 6、§6.7）。判定与 `domain/uri.ts` 是**同一份集合**
 * （那边导出、这边引用）：这些名字属于元数据文件，作为普通路径段写入会和它们抢地址。
 *
 * `.history` 故意不在这里：它是合法的 URI 段（系统写版本快照要用），归成产物会让
 * `list` / `tree` / `glob` 看不见版本文件（§11.11）；它由 identity 的标识清单拦。
 */
export const RESERVED_NAMES: ReadonlySet<string> = RESERVED_SEGMENT_NAMES;

/** 临时文件名前缀：原子写用（`.comem-tmp-<random>`）。 */
export const TEMP_FILE_PREFIX = '.comem-tmp-';

/**
 * 锁文件名后缀（架构文档 §10.6「路径锁」）。
 *
 * 锁文件是 `{目标文件名}.comem-lock`，不是恰好叫 `.comem-lock`：写
 * `comem://user/alice/a.md` 会在同一目录留下 `a.md.comem-lock`。所以按后缀
 * 判定——按精确名判定的话，持锁瞬间目录里的文件数会漂移。
 */
export const LOCK_FILE_SUFFIX = '.comem-lock';

/** 数据根本身不是合法 URI 时的提示（它连 scope 段都没有）。 */
function invalidDiskPath(reason: string, diskPath: string): ComemError {
  return new ComemError('INVALID_URI', `磁盘路径不合法：${reason}`, { diskPath, reason });
}

/** 是否保留名。只做集合查表，不做其它规范化。 */
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

/**
 * 是否是内部产物文件名（元数据文件、锁文件、临时文件）。
 *
 * 所有需要「这不是用户内容」判断的地方都只调它，不要各处自己拼字符串——
 * 判定散开之后，改一处就会漏一处。
 */
export function isArtifactName(name: string): boolean {
  return (
    isReservedName(name) || name.endsWith(LOCK_FILE_SUFFIX) || name.startsWith(TEMP_FILE_PREFIX)
  );
}

/** 数据根 + 作用域根 → 该作用域的绝对目录。如 `<dataDir>/user/alice`。 */
export function scopeRootOf(dataDir: string, scope: UriScope, rootId: string): string {
  return join(dataDir, scope, rootId);
}

/**
 * URI → 绝对磁盘路径。
 *
 * 用 `join` 而不是字符串拼接：段里可能出现盘符、分隔符（Windows 上 `join` 会
 * 统一成 `\`），手拼在 Windows 上必错。
 */
export function toDiskPath(dataDir: string, uri: Uri): string {
  return join(dataDir, uri.scope, uri.rootId, ...uri.segments);
}

export function toDiskLocation(dataDir: string, uri: Uri): DiskLocation {
  return {
    uri,
    absolute: toDiskPath(dataDir, uri),
    // `relative` 固定用 `/`，与平台无关；磁盘布局本身由 `toDiskPath` 决定。
    relative: [uri.scope, uri.rootId, ...uri.segments].join(URI_SEGMENT_SEPARATOR),
  };
}

/**
 * 绝对磁盘路径 → URI，`toDiskPath` 的逆运算。
 *
 * 三种越界一律拒绝：`relative` 里出现 `..`、绝对路径不在 `dataDir` 下、
 * 路径段是保留名。前三段的合法性（`user` / `group`、根标识字符集、段字符集、
 * NFC、长度）交给 `Uri.parse` 统一校验，避免两处规则各写一遍后走样。
 */
export function fromDiskPath(dataDir: string, diskPath: string): Uri {
  const base = resolve(dataDir);
  const target = resolve(diskPath);
  const relative = relativePath(base, target);

  if (relative === '') {
    throw invalidDiskPath('数据根自身不是 URI，至少需要 scope 与根标识两段', diskPath);
  }
  if (isAbsolute(relative) || relative === '..' || relative.startsWith(`..${sep}`)) {
    throw invalidDiskPath('路径不在数据根下', diskPath);
  }

  const segments = relative.split(sep);
  // 段里的保留名、控制字符、反斜杠等由 `Uri.parse` 拒绝；这里只负责拼回 URI 形状。
  return Uri.parse(`${SCHEME_PREFIX}${segments.join(URI_SEGMENT_SEPARATOR)}`);
}
