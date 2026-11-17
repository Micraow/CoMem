import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  archiveMessagesDirectoryOf,
  summarySourceLabelOf,
} from '../../../web/utils/summarySource.js'

const FILE_PAGE = readFileSync(
  new URL('../../../web/pages/files/[...path].vue', import.meta.url),
  'utf8',
)
const SUMMARY_PANEL = readFileSync(
  new URL('../../../web/components/domain/SummaryPanel.vue', import.meta.url),
  'utf8',
)

describe('摘要来源', () => {
  it('按服务端来源区分索引摘要与摘要文件', () => {
    expect(summarySourceLabelOf('index')).toBe('索引摘要')
    expect(summarySourceLabelOf('summary')).toBe('文件摘要')
    expect(summarySourceLabelOf('none')).toBeNull()
    expect(summarySourceLabelOf(null)).toBeNull()
  })

  it('页面不再从降级字段推断模型生成', () => {
    expect(FILE_PAGE).not.toContain('模型生成')
    expect(SUMMARY_PANEL).not.toContain('模型生成')
    expect(FILE_PAGE).toContain('查看归档摘要')
    expect(FILE_PAGE).toContain('打开原文')
  })
})

describe('会话归档消息目录', () => {
  it('支持默认和配置后的单段归档目录名', () => {
    expect(
      archiveMessagesDirectoryOf(
        'comem://user/alice/sessions/sess_123/history/archive_001/messages.jsonl',
      ),
    ).toBe('comem://user/alice/sessions/sess_123/history/archive_001')
    expect(
      archiveMessagesDirectoryOf(
        'comem://user/alice/sessions/sess_123/archives/archive_012/messages.jsonl',
      ),
    ).toBe('comem://user/alice/sessions/sess_123/archives/archive_012')
  })

  it('不把项目、资源或其它同名目录当成会话归档', () => {
    for (const uri of [
      'comem://user/alice/projects/demo/sessions/sess_123/history/archive_001/messages.jsonl',
      'comem://user/alice/resources/sessions/sess_123/history/archive_001/messages.jsonl',
      'comem://user/alice/sessions/sess_123/history/archive_001/other/messages.jsonl',
      'comem://group/design/sessions/sess_123/history/archive_001/messages.jsonl',
    ]) {
      expect(archiveMessagesDirectoryOf(uri)).toBeNull()
    }
  })
})
