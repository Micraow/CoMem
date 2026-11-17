import { describe, expect, it } from 'vitest'

import { readPromptDefault } from '../../../../src/config/prompt-defaults.js'
import {
  experienceSchema,
  renderExperienceContent,
} from '../../../../src/services/dreamer/experience.js'

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
    expect(prompt).toContain('`claim` 是一句可直接检索、单独理解的结论')
    expect(prompt).toContain('用户长期采用的格式、语言、详略、审美或工具选择 → 偏好')
    expect(prompt).toContain('单次答题结果、一道题答错、一次格式偏差')
    expect(prompt).toContain('`appliesWhen` 写 1–4 条适用条件')
  })

  it('structurally validates experience fields and renders claim as the summary line', () => {
    const experience = experienceSchema.parse({
      category: 'computer-architecture',
      topic: 'single-cycle-datapath-critical-path',
      claim: '判断新增指令的数据通路时，先逐项检查已有组件和新增路径。',
      appliesWhen: ['在已有单周期数据通路上新增指令。'],
      procedure: ['列出新增控制信号。', '检查写回与访存路径。', '验证关键路径。'],
      limitations: [],
      evidence: ['add3 与 sll 两条例题按该顺序检查通过。'],
    })

    const content = renderExperienceContent(experience)
    expect(content.split('\n')[0]).toBe(experience.claim)
    expect(content).toContain('## 适用条件')
    expect(content).toContain('## 做法')
    expect(content).toContain('1. 列出新增控制信号。')
    expect(content).not.toContain('## 限制')
    expect(content).toContain('## 证据')
  })

  it('rejects conclusions without evidence or with invalid routing fields', () => {
    const base = {
      category: 'workflow',
      topic: 'monorepo-migration',
      claim: '迁移前先固定依赖版本。',
      appliesWhen: ['仓库需要迁移。'],
      procedure: ['固定依赖版本。'],
      limitations: [],
      evidence: ['本次构建通过。'],
    }

    expect(experienceSchema.safeParse({ ...base, evidence: [] }).success).toBe(false)
    expect(experienceSchema.safeParse({ ...base, evidence: ['   '] }).success).toBe(false)
    expect(experienceSchema.safeParse({ ...base, procedure: undefined }).success).toBe(false)
    expect(experienceSchema.safeParse({ ...base, category: 'Workflow / Other' }).success).toBe(false)
    expect(experienceSchema.safeParse({ ...base, claim: '第一行\n第二行' }).success).toBe(false)
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
