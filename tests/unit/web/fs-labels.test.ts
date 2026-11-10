/**
 * 文件 / 目录 kind 文案与领域取值域的对拍（`web/utils/fsLabels.ts` ↔ 服务端 `kind`）。
 *
 * 取值域是闭集，证据在生产者：`src/adapters/fs/content-store.ts` 的 `StoredStat.kind`
 * 写死成 `'file' | 'directory'`（由 `fs.stat()` 的 `stats.isDirectory()` 二选一），
 * `src/services/filesystem.ts` 的 `TreeEntry.kind` 与 `src/api/http/routes/fs.ts` 的
 * `serializeEntry` 一路原样带出，没有字符串拼接。所以界面可以把三处内联三元收进
 * 表里；这里用 `TreeEntry['kind']`（HTTP 响应的静态类型）和 `StoredStat['kind']`
 * （磁盘侧生产者）把两侧绑在一起。
 *
 * 断言里的取值是**文档里的**（硬编码）：磁盘上只有文件（文档）与目录两种，
 * 不是从实现里推导的。
 */
import { describe, expect, it } from 'vitest'

import type { StoredStat } from '../../../src/adapters/fs/content-store.js'
import type { TreeEntry } from '../../../src/services/filesystem.js'
import {
  FS_ENTRY_KINDS,
  fsEntryDisplayName,
  fsEntryKindLabel,
  fsEntryLevelsLabel,
  type FsEntryKind,
} from '../../../web/utils/fsLabels.js'

type DomainEntryKind = TreeEntry['kind']
type StoredKind = StoredStat['kind']

describe('文件 / 目录 kind 文案', () => {
  it('清单是文档里的两种，且与领域类型双向一致', () => {
    const documented: readonly DomainEntryKind[] = ['file', 'directory']

    expect([...FS_ENTRY_KINDS]).toEqual([...documented])
    expect(FS_ENTRY_KINDS.map(fsEntryKindLabel)).toEqual(['文档', '目录'])
  })

  it('领域层加一种 kind 时双向 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<FsEntryKind, DomainEntryKind> = {
      file: 'file',
      directory: 'directory',
    }
    const domainToWeb: Record<DomainEntryKind, FsEntryKind> = {
      file: 'file',
      directory: 'directory',
    }
    // 磁盘侧的生产者与 HTTP 响应是同一个闭集。
    const storedToWeb: Record<StoredKind, FsEntryKind> = {
      file: 'file',
      directory: 'directory',
    }

    expect(Object.keys(webToDomain)).toEqual([...FS_ENTRY_KINDS])
    expect(Object.keys(domainToWeb)).toEqual([...FS_ENTRY_KINDS])
    expect(Object.keys(storedToWeb)).toEqual([...FS_ENTRY_KINDS])
  })

  it('名称后缀与摘要层级也按 kind 展开', () => {
    expect(fsEntryDisplayName('file', 'notes.md')).toBe('notes.md')
    expect(fsEntryDisplayName('directory', 'notes')).toBe('notes/')
    expect(fsEntryLevelsLabel('file')).toBe('L0 摘要')
    expect(fsEntryLevelsLabel('directory')).toBe('L0 摘要 · L1 概览')
  })
})
