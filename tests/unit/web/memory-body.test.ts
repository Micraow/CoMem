/**
 * 记忆正文显示形态的单元测试（`web/utils/memoryBody.ts`）。
 *
 * 覆盖的是差异左栏对 `/content/read` 正文的处理：正文来自
 * `ContentStore.readText` 的 `document.body`，所以输入**没有** frontmatter，只有
 * 存储层加的 `## content` 标题。标题必须去掉，正文里自带的 `## ` 小标题必须留下。
 *
 * 期望值按 `src/services/memory.ts` 的 `extractContent()` 写死：标题行 `## content\n`
 * 与紧随其后的**一个** `\n` 被剥掉，其余字节原样保留。正文自己以空行开头时，
 * 多出来的换行属于正文——它与复核记录里的 `fields.content` 必须一致，否则左右两栏
 * 会显示出一处并不存在的差异。
 */
import { describe, expect, it } from 'vitest'

import { memoryBodyText } from '../../../web/utils/memoryBody.js'

describe('记忆正文的显示形态', () => {
  it('剥掉标题行与紧随其后的一个换行', () => {
    expect(memoryBodyText('## content\n\n发版前先跑一遍 typecheck。')).toBe(
      '发版前先跑一遍 typecheck。',
    )
  })

  it('没有标题时原样返回纯正文', () => {
    expect(memoryBodyText('发版前先跑一遍 typecheck。')).toBe('发版前先跑一遍 typecheck。')
  })

  it('空正文：标题行后没有内容时返回空串', () => {
    expect(memoryBodyText('## content\n')).toBe('')
    expect(memoryBodyText('## content\n\n')).toBe('')
    // 没有换行的半截标题不是 `renderBody` 的产物（它总是写 `## content\n\n`），
    // `extractContent()` 也不把它认作标题行，所以原样返回。
    expect(memoryBodyText('## content')).toBe('## content')
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

  it('CRLF：标题行不命中，整段原样返回', () => {
    // `renderBody` 只写 LF，`extractContent()` 的前缀也是 `## content\n`；这里不
    // 发明第三套换行语义，所以 CRLF 文件连标题一起原样显示。
    expect(memoryBodyText('## content\r\n\r\n发版前先跑一遍 typecheck。')).toBe(
      '## content\r\n\r\n发版前先跑一遍 typecheck。',
    )
  })

  it('正文自己以空行开头时，那个空行留下', () => {
    // 磁盘上是 `## content\n\n` + `\n\n步骤…`：正文本身就是 `\n\n步骤…`。
    // 旧实现删掉全部前导换行，左栏会显示 `步骤…`，与右栏的 `\n\n步骤…` 差两行。
    expect(memoryBodyText('## content\n\n\n\n步骤一：跑 typecheck。')).toBe(
      '\n\n步骤一：跑 typecheck。',
    )
    // 只多一个换行同理：被剥掉的只有标题行与 `renderBody` 写的那一个空行。
    expect(memoryBodyText('## content\n\n\n步骤一：跑 typecheck。')).toBe(
      '\n步骤一：跑 typecheck。',
    )
  })
})
