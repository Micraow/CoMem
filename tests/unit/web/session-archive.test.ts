/**
 * 已提交会话的展开空态入口（`web/utils/sessionArchive.ts`）。
 *
 * 提交会把 live 消息移进 `history/archive_NNN/`。展开详情只返回 live 消息，因此
 * 这里固定：有提交记录且 live 为空时进入真实 `history/`；仍有 live 或从未提交时
 * 不显示归档入口。
 */
import { describe, expect, it } from 'vitest'

import { sessionArchiveRouteOf } from '../../../web/utils/sessionArchive.js'

const SESSION = {
  uri: 'comem://user/local/sessions/hermes-1',
  lastCommitAt: '2026-11-17T08:00:00.000Z',
}

describe('会话历史归档入口', () => {
  it('有提交记录且 live 为空时打开该会话的 history 目录', () => {
    expect(sessionArchiveRouteOf(SESSION, 0)).toBe(
      '/files/user/local/sessions/hermes-1/history',
    )
  })

  it('live 还有消息时不显示归档入口', () => {
    expect(sessionArchiveRouteOf(SESSION, 1)).toBeNull()
  })

  it('从未提交的空会话不显示归档入口', () => {
    expect(sessionArchiveRouteOf({ ...SESSION, lastCommitAt: null }, 0)).toBeNull()
  })
})
