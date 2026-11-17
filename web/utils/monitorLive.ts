interface MonitorSession {
  readonly id: string
  readonly lastCommitAt: string | null
}

interface MonitorModelCall {
  readonly id: string
}

/**
 * 监控刷新间隔。
 *
 * 会话提交和后台任务状态都按秒级迁移；3 秒与 `pages/sessions.vue` 的任务轮询使用
 * 同一观察粒度。页面不可见时暂停，避免后台标签页持续请求。
 */
export const LIVE_REFRESH_INTERVAL_MS = 3_000

/** 身份里第一个个人根；团队作用域不能用于账号级监控。 */
export function personalScopeOf(scopes: readonly string[]): string {
  return scopes.find((scope) => scope.startsWith('comem://user/')) ?? ''
}

/** 只保留已完成提交的 Hermes 原生会话。 */
export function completedHermesSessions<Session extends MonitorSession>(
  sessions: readonly Session[] | null,
): readonly Session[] | null {
  if (sessions === null) {
    return null
  }
  return sessions.filter(
    (session) => session.id.startsWith('hermes-') && session.lastCommitAt !== null,
  )
}

/**
 * 把轮询返回的第一页并入用户已加载的列表。
 *
 * 新记录排在最前，已经加载过的旧页保留，避免自动刷新把“加载更早记录”的结果冲掉。
 */
export function mergeRefreshedCalls<Call extends MonitorModelCall>(
  current: readonly Call[],
  firstPage: readonly Call[],
): readonly Call[] {
  const refreshedIds = new Set(firstPage.map((item) => item.id))
  return [...firstPage, ...current.filter((item) => !refreshedIds.has(item.id))]
}
