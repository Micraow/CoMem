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
import { Uri, type UriScope } from '../../domain/uri.js';

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
 * 元数据文件名（架构文档 §6.2 规则 6、§6.7）。
 *
 * 这些名字属于元数据文件，不是目录内容：作为普通路径段写入会和元数据文件
 * 抢地址，也会让「按 URI 前缀鉴权」把元数据当成内容。
 *
 * 和 `domain/uri.ts` 里的私有集合必须完全一致——那边没有导出，所以这里自己
 * 声明一份，并由 `tests/integration/fs/path.test.ts` 断言两边对同一批候选名
 * 的判定相同。改一处忘了另一处，测试会红。
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  '.abstract.md',
  '.overview.md',
  '.acl.json',
  '.meta.json',
  '.done',
  'memory_diff.json',
  'memory_operations.json',
]);

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

/**
 * Windows 设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`）。
 *
 * 这些名字在 Windows 上不能作为文件名，`git checkout` 到 Windows 会直接失败。
 * `Uri` 是冻结契约，不在里面拦；仓库又跑在 Linux 上，所以要有一个显式判断函数，
 * 让需要跨平台导出的调用方自己决定怎么处理。
 */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  // COM1–COM9 / LPT1–LPT9：Windows 传统串口与并口设备名，各 9 个。
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

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

/**
 * 是否是 Windows 保留设备名。
 *
 * Windows 的判定看**第一个点之前的部分**，`CON.md`、`con.tar.gz` 同样不可创建，
 * 并且名字末尾的空格会被系统吞掉，所以先 `trimEnd` 再比较。这里只回答「这个
 * 名字在 Windows 上会不会炸」，不做拦截。
 */
export function isWindowsReservedName(name: string): boolean {
  const baseName = name.split('.')[0] ?? '';
  return WINDOWS_DEVICE_NAMES.has(baseName.trimEnd().toUpperCase());
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
