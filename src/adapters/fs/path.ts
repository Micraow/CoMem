/**
 * URI ↔ 磁盘路径（架构文档 §6.2、§6.5）。
 *
 * 磁盘布局就是 URI 的镜像：`comem://user/alice/memories/foo` 落在
 * `<dataDir>/user/alice/memories/foo`。这一层只做形状转换，不碰文件系统。
 */

import { join } from 'node:path';

import { RESERVED_SEGMENT_NAMES, Uri } from '../../domain/uri.js';

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
 * URI → 绝对磁盘路径。
 *
 * 用 `join` 而不是字符串拼接：段里可能出现盘符、分隔符（Windows 上 `join` 会
 * 统一成 `\`），手拼在 Windows 上必错。
 */
export function toDiskPath(dataDir: string, uri: Uri): string {
  return join(dataDir, uri.scope, uri.rootId, ...uri.segments);
}

