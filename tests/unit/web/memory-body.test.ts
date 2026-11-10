/**
 * 记忆正文显示形态的单元测试（`web/utils/memoryBody.ts`）。
 *
 * 覆盖的是差异左栏对 `/content/read` 正文的处理：正文来自
 * `ContentStore.readText` 的 `document.body`，所以输入**没有** frontmatter，只有
 * 存储层加的 `## content` 标题。标题必须去掉，正文里自带的 `## ` 小标题必须留下。
 */
import { describe, expect, it } from 'vitest'

import { memoryBodyText } from '../../../web/utils/memoryBody.js'

describe('记忆正文的显示形态', () => {
  it('去掉存储层标题与标题后的空行', () => {
    expect(memoryBodyText('## content\n\n发版前先跑一遍 typecheck。')).toBe(
      '发版前先跑一遍 typecheck。',
    )
  })

  it('没有标题时原样返回纯正文', () => {
    expect(memoryBodyText('发版前先跑一遍 typecheck。')).toBe('发版前先跑一遍 typecheck。')
  })

  it('空正文：只有标题时返回空串', () => {
    expect(memoryBodyText('## content')).toBe('')
  })

  it('空字符串原样返回', () => {
    expect(memoryBodyText('')).toBe('')
  })

  it('正文里自带的 ## 小标题不被误剥', () => {
    expect(memoryBodyText('## content\n\n## 步骤\n\n1. 先跑 typecheck。')).toBe(
      '## 步骤\n\n1. 先跑 typecheck。',
    )
  })

  it('半截 --- 块按正文处理（本函数不解析 frontmatter）', () => {
    // `/content/read` 已经剥离 frontmatter；只有开始分隔符的文本也不该被这里改写。
    expect(memoryBodyText('---\nmemory_type: experiences\n')).toBe(
      '---\nmemory_type: experiences\n',
    )
  })

  it('CRLF：标题剥掉，其余字节原样保留', () => {
    // 当前语义：`replace(/^\\n+/)` 不吃 `\\r\\n`，所以分隔符后的换行留在正文前。
    expect(memoryBodyText('## content\r\n\r\n发版前先跑一遍 typecheck。')).toBe(
      '\r\n\r\n发版前先跑一遍 typecheck。',
    )
  })
})
