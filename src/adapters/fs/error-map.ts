/**
 * 文件系统 errno → `ComemError` 的公共映射（架构文档 §19）。
 *
 * `content-store` / `metadata-file` / `acl-file` 三个适配器都要把 `node:fs` 抛出的
 * 错误收敛成 `ComemError`。三份表曾经各自维护并已经分叉：同一个 errno 在
 * `content-store` 落成 `INVALID_ARGUMENT`、在另外两个落成 `NOT_FOUND`，而
 * `content-store` 干脆没有 `EACCES` / `EPERM` 行——写内容时磁盘权限不足会落到默认的
 * `INTERNAL`（HTTP 500），把一次权限故障伪装成服务端内部错误（AGENTS.md §1「错误必须
 * 能定位」）。
 *
 * 这里只放**三个适配器语义相同**的部分：`ENOENT` / `EEXIST` / `EISDIR` / `ENOSPC` /
 * `EACCES` / `EPERM`。`ENOTDIR` 不在公共表里，因为它的含义随适配器而异，由各适配器
 * 显式覆盖（`ErrnoOverrides` 的类型就是公共表的补集）。
 *
 * 消息表同理：文案一致的 code 放公共表，其余由各适配器提供。`AdapterMessageCode`
 * 是 `ComemErrorCode` 的补集，所以新增一个错误码时它自动落到适配器一侧，三个适配器的
 * 消息表会各自报「缺键」，`pnpm typecheck` 直接红——不会出现「某个适配器悄悄用了
 * 兜底文案」。同理，往 `FS_ERRNO_CODES` 里加一个 errno，也会把缺失的覆盖项变成类型错误。
 */

import type { ComemErrorCode } from '../../domain/errors.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

/**
 * 适配器处理、或至少需要明确表态的 errno 集合。表外的一律 `INTERNAL`。
 *
 * `EXDEV` 不在这里：它只由 `content-store.move` 自己降级成「复制 + 删除」，不是
 * 「errno → 业务错误码」的映射。
 */
export const FS_ERRNO_CODES = [
  'ENOENT',
  'ENOTDIR',
  'EEXIST',
  'EISDIR',
  'ENOSPC',
  'EACCES',
  'EPERM',
] as const;

export type FsErrno = (typeof FS_ERRNO_CODES)[number];

/** 公共 errno → code。`ENOTDIR` 缺失是有意的，见文件头。 */
const SHARED_CODE_BY_ERRNO = {
  ENOENT: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  EISDIR: 'INVALID_ARGUMENT',
  ENOSPC: 'RESOURCE_EXHAUSTED',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
} as const satisfies Partial<Record<FsErrno, ComemErrorCode>>;

/** 公共表的补集：每个适配器必须自己给出答案的 errno（当前只有 `ENOTDIR`）。 */
type AdapterErrnoCode = Exclude<FsErrno, keyof typeof SHARED_CODE_BY_ERRNO>;

export type ErrnoOverrides = Readonly<Record<AdapterErrnoCode, ComemErrorCode>>;

/** 三个适配器文案相同的中文消息。 */
const SHARED_MESSAGE_BY_CODE = {
  INVALID_URI: 'URI 不合法',
  UNAUTHENTICATED: '未认证',
  CONFLICT: '并发写冲突',
  RESOURCE_EXHAUSTED: '磁盘空间不足',
  PROVIDER_UNAVAILABLE: '服务不可用',
} satisfies Partial<Record<ComemErrorCode, string>>;

/**
 * 文案必须由各适配器自己写的错误码。
 *
 * 同样是 `NOT_FOUND`，「文件不存在」「摘要文件不存在」「ACL 文件不存在」指向的对象
 * 不同；统一文案会把「哪个文件」这一诊断信息抹掉。`PERMISSION_DENIED` / `INTERNAL`
 * 同理。
 */
export type AdapterMessageCode = Exclude<ComemErrorCode, keyof typeof SHARED_MESSAGE_BY_CODE>;

export type AdapterMessages = Readonly<Record<AdapterMessageCode, string>>;

export type FsErrorMapper = (error: unknown, uri: Uri) => ComemError;

/** 从 `unknown` 里取 `code`，不用类型断言。 */
export function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 合并公共 errno 表与适配器的覆盖项，结果按 errno 字符串索引。
 *
 * 中间变量显式标成 `FsErrno` 全集：公共表漏一项、适配器漏覆盖项都会在这里
 * 编译不过。返回值放宽成 `string` 键，因为 `node:fs` 的 `code` 是 `string`。
 */
function errnoCodeTable(overrides: ErrnoOverrides): Readonly<Record<string, ComemErrorCode>> {
  const table: Readonly<Record<FsErrno, ComemErrorCode>> = {
    ...SHARED_CODE_BY_ERRNO,
    ...overrides,
  };
  return table;
}

/** 合并公共消息表与适配器自己的文案。缺文案编译不过。 */
function errorMessageTable(
  adapterMessages: AdapterMessages,
): Readonly<Record<ComemErrorCode, string>> {
  return { ...SHARED_MESSAGE_BY_CODE, ...adapterMessages };
}

/**
 * 造一个「文件系统错误 → `ComemError`」的映射函数。
 *
 * 这是三个适配器共用的机制，差异只剩传进来的两张表。已经是 `ComemError` 的原样返回
 * （例如 `writeText` 自己抛的 CONFLICT），否则按 errno 查表；查不到的是程序缺陷，
 * 标 `INTERNAL` 而不是假装成业务错误。
 */
export function createFsErrorMapper(
  errnoOverrides: ErrnoOverrides,
  adapterMessages: AdapterMessages,
): FsErrorMapper {
  const codeByErrno = errnoCodeTable(errnoOverrides);
  const messageByCode = errorMessageTable(adapterMessages);
  return (error, uri) => {
    if (error instanceof ComemError) {
      return error;
    }
    const fsCode = fsErrorCode(error);
    const code = (fsCode === null ? undefined : codeByErrno[fsCode]) ?? 'INTERNAL';
    const message = `${messageByCode[code]}（${fsCode ?? 'UNKNOWN'}）：${uri.toString()}`;
    return new ComemError(code, message, { uri: uri.toString(), fsCode });
  };
}
