/**
 * 关联边展示映射的单元测试（`web/utils/memoryLinks.ts`）。
 *
 * 覆盖文件详情页「关联」区块依赖的两件事：
 * - 只有 `memories/` 下的节点才请求关联边；
 * - `link_type` 按方向翻译，未知类型显示原值（不能留空）。
 */
import { describe, expect, it } from 'vitest'

import { isMemoryUri, linkRowsOf, type LinkEdge } from '../../../web/utils/memoryLinks.js'

function edge(overrides: Partial<LinkEdge> = {}): LinkEdge {
  return {
    from: 'comem://user/alice/memories/experiences/release-check.md',
    to: 'comem://user/alice/sessions/sess_1/messages.jsonl',
    linkType: 'derived_from',
    description: '',
    ...overrides,
  }
}

describe('记忆关联边', () => {
  it('只把 memories/ 下的节点当记忆节点', () => {
    expect(isMemoryUri('comem://user/alice/memories/experiences/release-check.md')).toBe(true)
    expect(isMemoryUri('comem://group/dev/memories/rules/release/run-typecheck.md')).toBe(true)
    // memories 目录本身不是记忆；普通文件、会话文件都不是。
    expect(isMemoryUri('comem://user/alice/memories')).toBe(false)
    expect(isMemoryUri('comem://user/alice/sessions/sess_1/messages.jsonl')).toBe(false)
    expect(isMemoryUri('')).toBe(false)
  })

  it('正向边显示另一端 to，derived_from 译成「派生自」', () => {
    expect(linkRowsOf([edge()], 'links')).toEqual([
      {
        uri: 'comem://user/alice/sessions/sess_1/messages.jsonl',
        label: '派生自',
        description: '',
      },
    ])
  })

  it('反向边显示另一端 from，derived_from 译成「派生出」', () => {
    expect(linkRowsOf([edge()], 'backlinks')).toEqual([
      {
        uri: 'comem://user/alice/memories/experiences/release-check.md',
        label: '派生出',
        description: '',
      },
    ])
  })

  it('说明原样带出', () => {
    const rows = linkRowsOf(
      [edge({ linkType: 'references', description: '相关规则' })],
      'backlinks',
    )
    expect(rows[0]).toMatchObject({ label: '被引用', description: '相关规则' })
  })

  it('未知 link_type 显示原值而不是空白', () => {
    expect(linkRowsOf([edge({ linkType: 'cites_rule' })], 'links')[0]?.label).toBe('cites_rule')
  })
})
