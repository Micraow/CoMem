export type ReviewAction = 'approve' | 'reject'

export interface ApproveReviewEdit {
  readonly content: string
  readonly expectedUpdatedAt: string
}

export interface RejectReviewBody {
  readonly reason: string
}

/**
 * 复核操作共用一个端点族：普通通过不带请求体，编辑后通过才提交正文。
 */
export function reviewMutationBodyOf(
  action: ReviewAction,
  reason: string,
  edit?: ApproveReviewEdit,
): ApproveReviewEdit | RejectReviewBody | undefined {
  if (action === 'reject') {
    return { reason }
  }
  return edit
}

export function hasReviewContent(content: string): boolean {
  return content.trim() !== ''
}
