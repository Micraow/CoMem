/**
 * 三个 fs 适配器的 errno → 错误码差异集合（架构文档 §19）。
 *
 * `content-store` / `metadata-file` / `acl-file` 曾经各有一份几乎相同、已经分叉的
 * `ERROR_CODE_BY_FS_ERRNO`。现在公共部分收在 `error-map.ts`，适配器只声明覆盖项；
 * 这里对 `FS_ERRNO_CODES` 逐个 errno 调用**适配器实际使用的映射函数**（不是测试专用
 * 的副本），断言落到的 code，并把「有意保留的差异」钉成集合。
 *
 * **差异只允许出现在 `ENOTDIR`，且只允许 `content-store` 与另外两个不同**：
 * `content-store` 面对的是「`memories` 这个路径段其实是个文件」，`INVALID_ARGUMENT`
 * 比 `NOT_FOUND` 准确；`metadata-file` / `acl-file` 面对的是「没有这个元数据文件」，
 * 且多处把 `ENOTDIR` 当成「没有 ACL 文件」吞掉。谁抹平或扩大差异，这里会红。
 */

import { describe, expect, it } from 'vitest';

import { mapFsError as mapAclFileError } from '../../../src/adapters/fs/acl-file.js';
import { mapFsError as mapContentStoreError } from '../../../src/adapters/fs/content-store.js';
import type { FsErrorMapper, FsErrno } from '../../../src/adapters/fs/error-map.js';
import { FS_ERRNO_CODES } from '../../../src/adapters/fs/error-map.js';
import { mapFsError as mapMetadataFileError } from '../../../src/adapters/fs/metadata-file.js';
import type { ComemErrorCode } from '../../../src/domain/errors.js';
import { Uri } from '../../../src/domain/uri.js';

const URI = Uri.parse('comem://user/alice/memories');

/** 与 `node:fs` 抛出的错误同一形态：`Error` 带一个 `code` 字符串。 */
function fsError(code: string): Error {
  return Object.assign(new Error(`模拟文件系统错误：${code}`), { code });
}

/** 顺序即 `EXPECTED_CODES` 里元组的顺序。 */
const ADAPTERS = [
  { name: 'content-store', map: mapContentStoreError },
  { name: 'metadata-file', map: mapMetadataFileError },
  { name: 'acl-file', map: mapAclFileError },
] as const satisfies readonly { readonly name: string; readonly map: FsErrorMapper }[];

function codeFor(map: FsErrorMapper, errno: FsErrno): ComemErrorCode {
  return map(fsError(errno), URI).code;
}

function codesFor(errno: FsErrno): readonly ComemErrorCode[] {
  return ADAPTERS.map((adapter) => codeFor(adapter.map, errno));
}

/**
 * 逐个 errno 的期望 code，顺序是 content-store / metadata-file / acl-file。
 *
 * `ENOTDIR` 那一行是唯一的差异，其余六个 errno 三者必须一致。
 */
const EXPECTED_CODES: Readonly<
  Record<FsErrno, readonly [ComemErrorCode, ComemErrorCode, ComemErrorCode]>
> = {
  ENOENT: ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'],
  ENOTDIR: ['INVALID_ARGUMENT', 'NOT_FOUND', 'NOT_FOUND'],
  EEXIST: ['ALREADY_EXISTS', 'ALREADY_EXISTS', 'ALREADY_EXISTS'],
  EISDIR: ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'],
  ENOSPC: ['RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED'],
  EACCES: ['PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
  EPERM: ['PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
};

describe('三个适配器的 errno 映射', () => {
  it.each(FS_ERRNO_CODES)('%s 在三个适配器上分别映射成固定 code', (errno) => {
    expect(codesFor(errno)).toEqual(EXPECTED_CODES[errno]);
  });

  it('差异集合只有 ENOTDIR，且只有 content-store 与另外两个不同', () => {
    const differing = FS_ERRNO_CODES.filter((errno) => new Set(codesFor(errno)).size > 1);
    expect(differing).toEqual(['ENOTDIR']);

    const [contentStore, metadataFile, aclFile] = codesFor('ENOTDIR');
    expect(contentStore).toBe('INVALID_ARGUMENT');
    expect(metadataFile).toBe('NOT_FOUND');
    expect(aclFile).toBe('NOT_FOUND');
  });

  it('表外的 errno 收敛成 INTERNAL，不当成业务错误', () => {
    const error = mapContentStoreError(fsError('EMFILE'), URI);

    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('EMFILE');
    expect(error.details).toMatchObject({ fsCode: 'EMFILE' });
  });

  it('同一错误码的文案按适配器各自保留，不强行统一', () => {
    const messages = ADAPTERS.map((adapter) => adapter.map(fsError('ENOENT'), URI).message);

    // 三条消息必须可区分：「哪个文件不存在」是诊断信息。
    expect(new Set(messages).size).toBe(ADAPTERS.length);
    expect(messages[0]).toContain('文件不存在');
    expect(messages[1]).toContain('摘要文件不存在');
    expect(messages[2]).toContain('ACL 文件不存在');
  });
});
