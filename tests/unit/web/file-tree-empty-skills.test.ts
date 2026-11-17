import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const FILE_TREE = readFileSync(
  new URL('../../../web/components/domain/FileTree.vue', import.meta.url),
  'utf8',
)

describe('文件树旧版空 Skills 目录', () => {
  it('只隐藏当前 scope 根下确实为空的 skills，并让空状态和列表共用过滤结果', () => {
    expect(FILE_TREE).toContain('const visibleRows = computed')
    expect(FILE_TREE).toContain('node.depth === 0')
    expect(FILE_TREE).toContain("node.kind === 'directory'")
    expect(FILE_TREE).toContain('node.size === 0')
    expect(FILE_TREE).toContain('=== emptySkillsUri')
    expect(FILE_TREE).toContain('v-else-if="visibleRows.length === 0"')
    expect(FILE_TREE).toContain('v-for="node in visibleRows"')
  })
})
