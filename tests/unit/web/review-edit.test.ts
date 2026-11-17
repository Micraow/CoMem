import { describe, expect, it } from 'vitest'

import {
  hasReviewContent,
  reviewMutationBodyOf,
} from '../../../web/utils/reviewEdit.js'

describe('复核编辑请求', () => {
  it('普通通过不提交请求体', () => {
    expect(reviewMutationBodyOf('approve', '')).toBeUndefined()
  })

  it('编辑后通过与队列版本一起提交正文', () => {
    expect(
      reviewMutationBodyOf('approve', '', {
        content: '  保留原始空白  \n',
        expectedUpdatedAt: '2026-11-17T08:00:00.000Z',
      }),
    ).toEqual({
      content: '  保留原始空白  \n',
      expectedUpdatedAt: '2026-11-17T08:00:00.000Z',
    })
  })

  it('拒绝仍只提交原因', () => {
    expect(reviewMutationBodyOf('reject', '证据不足')).toEqual({ reason: '证据不足' })
  })

  it('空白正文不能保存', () => {
    expect(hasReviewContent(' \n\t')).toBe(false)
    expect(hasReviewContent('正文')).toBe(true)
  })
})
