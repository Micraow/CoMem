import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  LIVE_REFRESH_INTERVAL_MS,
  completedHermesSessions,
  mergeRefreshedCalls,
  personalScopeOf,
} from '../../../web/utils/monitorLive.js'
import { deriveVerification } from '../../../web/utils/connectGuide.js'

const MONITOR_PAGE = readFileSync(
  new URL('../../../web/pages/monitor.vue', import.meta.url),
  'utf8',
)
const HERMES_STATUS = readFileSync(
  new URL('../../../web/components/domain/HermesCaptureStatus.vue', import.meta.url),
  'utf8',
)
const MODEL_TABLE = readFileSync(
  new URL('../../../web/components/domain/ModelRequestTable.vue', import.meta.url),
  'utf8',
)

const hermesSession = {
  id: 'hermes-session',
  uri: 'comem://user/pengbo/sessions/hermes-session',
  status: 'archived',
  messageCount: 0,
  lastCommitAt: '2026-11-17T07:59:25.000Z',
  pendingTokens: 0,
  messages: [],
} as const

const codexSession = {
  ...hermesSession,
  id: 'cx-session',
  uri: 'comem://user/pengbo/sessions/cx-session',
} as const

function call(id: string, startedAt: string) {
  return {
    id,
    purpose: 'directory_summary',
    kind: 'chat',
    model: 'test',
    status: 'success',
    startedAt,
    endedAt: startedAt,
    durationMs: 1,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    costUsd: null,
    attempts: 1,
    errorCode: null,
    sessionId: null,
    requestId: null,
  } as const
}

describe('监控实时数据', () => {
  it('始终选择个人根，不受团队作用域影响', () => {
    expect(
      personalScopeOf([
        'comem://group/design',
        'comem://user/pengbo',
      ]),
    ).toBe('comem://user/pengbo')
    expect(personalScopeOf(['comem://group/design'])).toBe('')
  })

  it('只把已提交的 hermes-* 会话当作捕获证据', () => {
    expect(
      completedHermesSessions([
        hermesSession,
        { ...hermesSession, id: 'hermes-open', lastCommitAt: null },
        codexSession,
      ]),
    ).toEqual([hermesSession])
  })

  it('仅有非 Hermes 会话时捕获状态是待处理，而不是已归档', () => {
    const filtered = completedHermesSessions([codexSession])
    const result = deriveVerification({
      health: null,
      healthError: null,
      sessions: filtered,
      sessionsError: null,
      currentSubject: 'user:pengbo',
    })
    expect(result.checks.find((check) => check.key === 'sessions')).toMatchObject({
      tone: 'warn',
      label: '当前账号会话',
    })
  })

  it('后台刷新并入新首页，保留已经加载的更早分页', () => {
    const olderA = call('older-a', '2026-11-17T07:00:00.000Z')
    const olderB = call('older-b', '2026-11-17T06:00:00.000Z')
    const newest = call('newest', '2026-11-17T08:00:00.000Z')
    const refreshed = call('refreshed', '2026-11-17T07:30:00.000Z')

    expect(mergeRefreshedCalls([refreshed, olderA, olderB], [newest, refreshed])).toEqual([
      newest,
      refreshed,
      olderA,
      olderB,
    ])
  })

  it('轮询采用共享秒级间隔、可见性控制、请求版本与卸载清理', () => {
    expect(LIVE_REFRESH_INTERVAL_MS).toBe(3_000)
    expect(MONITOR_PAGE).toContain('useDocumentVisibility')
    expect(MONITOR_PAGE).toContain('LIVE_REFRESH_INTERVAL_MS')
    expect(MONITOR_PAGE).toContain('personalScopeOf')
    expect(MONITOR_PAGE).toContain('scopeUri: targetScope')
    expect(MONITOR_PAGE).toContain('sessionsRequestVersion')
    expect(MONITOR_PAGE).toContain('callsRequestVersion')
    expect(MONITOR_PAGE).toContain('callsLoadedMore')
    expect(MONITOR_PAGE).toContain('mergeRefreshedCalls')
    expect(MONITOR_PAGE).toContain('loadPendingReview(true)')
    expect(MONITOR_PAGE).toContain('liveRefreshRunning')
    expect(MONITOR_PAGE).toContain('pendingReviewToken += 1')
    expect(MONITOR_PAGE).toContain('onBeforeUnmount')
    expect(MONITOR_PAGE).toContain('stopPolling()')
    expect(MONITOR_PAGE).not.toContain('scopeUri: scopeRoot.value')
  })

  it('用户文案只描述 CoMem 模型调用，未知诊断状态不当成关闭事实', () => {
    expect(MONITOR_PAGE).toContain('title="CoMem 模型调用"')
    expect(MODEL_TABLE).toContain('caption="CoMem 模型调用记录"')
    expect(MODEL_TABLE).toContain('当前账号还没有 CoMem 模型调用记录')
    expect(MODEL_TABLE).not.toContain('诊断记录已关闭')
    expect(HERMES_STATUS).toContain('completedHermesSessions')
    expect(HERMES_STATUS).not.toContain("host: 'hermes'")
    expect(HERMES_STATUS).not.toContain('当前范围')
  })
})
