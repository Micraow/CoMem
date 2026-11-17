/**
 * 模型调用用途、状态文案与领域类型的对拍。
 *
 * web 包不能 import 后端领域值，所以两边都声明清单。这里用双向 `Record` 把漂移
 * 变成编译错误，并硬编码契约里的顺序，防止测试跟着实现一起改。
 */
import { describe, expect, it } from 'vitest'

import type {
  LlmCallKind as DomainKind,
  LlmCallPurpose as DomainPurpose,
  LlmCallStatus as DomainStatus,
} from '../../../src/domain/llm.js'
import {
  LLM_CALL_KINDS,
  LLM_CALL_PURPOSES,
  LLM_CALL_STATUSES,
  llmCallPurposeLabel,
  llmCallStatusLabel,
  type LlmCallKind,
  type LlmCallPurpose,
  type LlmCallStatus,
} from '../../../web/utils/modelRequestLabels.js'

describe('模型调用标签', () => {
  it('用途清单与后端领域类型一致', () => {
    const webToDomain: Record<LlmCallPurpose, DomainPurpose> = {
      query_rewrite: 'query_rewrite',
      recall_compression: 'recall_compression',
      directory_summary: 'directory_summary',
      archive_summary: 'archive_summary',
      working_memory: 'working_memory',
      memory_extract: 'memory_extract',
      dreamer: 'dreamer',
      config_probe: 'config_probe',
      unspecified: 'unspecified',
    }
    const domainToWeb: Record<DomainPurpose, LlmCallPurpose> = {
      query_rewrite: 'query_rewrite',
      recall_compression: 'recall_compression',
      directory_summary: 'directory_summary',
      archive_summary: 'archive_summary',
      working_memory: 'working_memory',
      memory_extract: 'memory_extract',
      dreamer: 'dreamer',
      config_probe: 'config_probe',
      unspecified: 'unspecified',
    }

    expect(Object.keys(webToDomain)).toHaveLength(LLM_CALL_PURPOSES.length)
    expect(Object.keys(domainToWeb)).toHaveLength(LLM_CALL_PURPOSES.length)
    expect([...LLM_CALL_PURPOSES]).toEqual([
      'query_rewrite',
      'recall_compression',
      'directory_summary',
      'archive_summary',
      'working_memory',
      'memory_extract',
      'dreamer',
      'config_probe',
      'unspecified',
    ])
  })

  it('状态清单与后端领域类型一致', () => {
    const webToDomain: Record<LlmCallStatus, DomainStatus> = {
      success: 'success',
      error: 'error',
    }
    const domainToWeb: Record<DomainStatus, LlmCallStatus> = {
      success: 'success',
      error: 'error',
    }

    expect(Object.keys(webToDomain)).toHaveLength(LLM_CALL_STATUSES.length)
    expect(Object.keys(domainToWeb)).toHaveLength(LLM_CALL_STATUSES.length)
    expect([...LLM_CALL_STATUSES]).toEqual(['success', 'error'])
  })

  it('调用类型与后端领域类型一致', () => {
    const webToDomain: Record<LlmCallKind, DomainKind> = {
      text: 'text',
      json: 'json',
    }
    const domainToWeb: Record<DomainKind, LlmCallKind> = {
      text: 'text',
      json: 'json',
    }

    expect(Object.keys(webToDomain)).toHaveLength(LLM_CALL_KINDS.length)
    expect(Object.keys(domainToWeb)).toHaveLength(LLM_CALL_KINDS.length)
    expect([...LLM_CALL_KINDS]).toEqual(['text', 'json'])
  })

  it('每个用途和状态都有中文界面文案', () => {
    expect(LLM_CALL_PURPOSES.map(llmCallPurposeLabel)).toEqual([
      '查询理解',
      '召回压缩',
      '目录摘要',
      '归档摘要',
      '会话工作记忆',
      '记忆抽取',
      '记忆整理',
      '模型连接测试',
      '其他调用',
    ])
    expect(LLM_CALL_STATUSES.map(llmCallStatusLabel)).toEqual(['成功', '失败'])
  })
})
