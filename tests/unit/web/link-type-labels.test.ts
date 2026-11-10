/**
 * 关联边展示映射与领域清单的对拍（`web/utils/memoryLinks.ts` ↔ `src/domain/memory-link.ts`）。
 *
 * `link_type` 在领域层是**开放字符串**（`MemoryLinkType` 带 `(string & {})` 分支），
 * 所以控制台的映射必须保留「未知类型显示原值」的兜底。但**已知**的三种类型是
 * 硬清单（`BUILTIN_MEMORY_LINK_TYPES`）：领域层加一种关系而控制台没跟上时，界面会
 * 露出 `derived_from` 这样的原始值。这里把那个漂移变成测试失败。
 */
import { describe, expect, it } from 'vitest'

import { BUILTIN_MEMORY_LINK_TYPES } from '../../../src/domain/memory-link.js'
import { linkRowsOf, type LinkEdge } from '../../../web/utils/memoryLinks.js'

function edge(linkType: string): LinkEdge {
  return {
    from: 'comem://user/alice/memories/experiences/release-check.md',
    to: 'comem://user/alice/resources/notes/deploy.md',
    linkType,
    description: '',
  }
}

describe('关联边类型文案', () => {
  it('领域层的每个内置类型两侧都有中文文案', () => {
    for (const linkType of BUILTIN_MEMORY_LINK_TYPES) {
      // 正向与反向都翻译过：`derived_from` 两个方向的说法不同。
      expect(linkRowsOf([edge(linkType)], 'links')[0]?.label).not.toBe(linkType)
      expect(linkRowsOf([edge(linkType)], 'backlinks')[0]?.label).not.toBe(linkType)
    }
  })

  it('领域层的内置清单仍是文档里的三种', () => {
    expect([...BUILTIN_MEMORY_LINK_TYPES]).toEqual(['references', 'derived_from', 'related'])
  })
})
