import { describe, expect, it } from 'vitest'

import {
  workspaceBreadcrumbs,
  workspaceChildUri,
  workspaceContainingRootOf,
  workspaceCopyNameOf,
  workspaceNameOf,
  workspaceParentUriOf,
} from '../../../web/utils/workspacePath.js'

describe('文件工作区路径', () => {
  it('保留空间根并生成可点击的逐级位置', () => {
    expect(
      workspaceBreadcrumbs(
        'comem://user/alice',
        'comem://user/alice/projects/demo/notes.md',
        '个人空间',
      ),
    ).toEqual([
      { uri: 'comem://user/alice', label: '个人空间' },
      { uri: 'comem://user/alice/projects', label: 'projects' },
      { uri: 'comem://user/alice/projects/demo', label: 'demo' },
      { uri: 'comem://user/alice/projects/demo/notes.md', label: 'notes.md' },
    ])
  })

  it('不会把同名前缀误认成子路径', () => {
    expect(
      workspaceBreadcrumbs('comem://user/alice', 'comem://user/alice-other', '个人空间'),
    ).toEqual([{ uri: 'comem://user/alice', label: '个人空间' }])
  })

  it('只接受单个目录段作为新名称', () => {
    expect(workspaceChildUri('comem://user/alice/projects/', ' demo ')).toBe(
      'comem://user/alice/projects/demo',
    )
    expect(workspaceChildUri('comem://user/alice/projects', '../escape')).toBeNull()
    expect(workspaceChildUri('comem://user/alice/projects', 'nested/name')).toBeNull()
  })

  it('选择最具体的直接共享根，不把同名前缀误认成子目录', () => {
    const roots = [
      'comem://user/alice/resources/team',
      'comem://user/alice/resources/team/design',
    ]
    expect(
      workspaceContainingRootOf(
        'comem://user/alice/resources/team/design/notes.md',
        roots,
      ),
    ).toBe('comem://user/alice/resources/team/design')
    expect(
      workspaceContainingRootOf(
        'comem://user/alice/resources/team-other/notes.md',
        roots,
      ),
    ).toBeNull()
  })

  it('提取父目录和显示名', () => {
    expect(workspaceParentUriOf('comem://user/alice')).toBeNull()
    expect(workspaceParentUriOf('comem://user/alice/projects/demo')).toBe(
      'comem://user/alice/projects',
    )
    expect(workspaceNameOf('comem://user/alice/projects/space%20name')).toBe('space name')
  })

  it('在扩展名前生成文档副本名称', () => {
    expect(workspaceCopyNameOf('notes.md', false)).toBe('notes 副本.md')
    expect(workspaceCopyNameOf('.profile', false)).toBe('.profile 副本')
    expect(workspaceCopyNameOf('projects', true)).toBe('projects 副本')
  })
})
