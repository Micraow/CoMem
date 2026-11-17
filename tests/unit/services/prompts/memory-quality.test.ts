import { describe, expect, it } from 'vitest'

import { readPromptDefault } from '../../../../src/config/prompt-defaults.js'

describe('memory prompt quality gates', () => {
  it('extract skips stale imports, explicit non-memory requests and assistant guesses', () => {
    const prompt = readPromptDefault('extract-system')

    expect(prompt).toContain('以消息时间而不是导入顺序判断新旧')
    expect(prompt).toContain('不要补造日期')
    expect(prompt).toContain('用户明确说不要记')
    expect(prompt).toContain('助手提出但用户未确认')
    expect(prompt).toContain('同义改写')
  })

  it('experience requires observed outcomes and preserves applicable limits', () => {
    const prompt = readPromptDefault('experience-system')

    expect(prompt).toContain('只沉淀已经观察到的结果')
    expect(prompt).toContain('不能把猜测写成结论')
    expect(prompt).toContain('较旧的验证结果不能覆盖较新的当前做法')
    expect(prompt).toContain('会改变适用范围的细节')
    expect(prompt).toContain('第一行直接给出可执行结论')
    expect(prompt).toContain('不要只写「按以下步骤操作」等提示语')
  })

  it('rewrite keeps history-dependent actions searchable and preserves exact nouns', () => {
    const prompt = readPromptDefault('rewrite-system')

    expect(prompt).toContain('按我以前的方式')
    expect(prompt).toContain('参数依赖记忆，仍要生成查询')
    expect(prompt).toContain('人名、项目名、命令、文件名')
  })

  it('consolidation requires evidence, conservative identity matching and lossless facts', () => {
    const prompt = readPromptDefault('consolidation-system')

    expect(prompt).toContain('同一对象、同一属性')
    expect(prompt).toContain('导入顺序')
    expect(prompt).toContain('不丢事实')
    expect(prompt).toContain('无法确定先后时保留')
    expect(prompt).toContain('内容冲突尚未解决时不能删除')
  })
})
