import { fileRouteOf } from './fileRoute'

interface CommittedSession {
  readonly uri: string
  readonly lastCommitAt: string | null
}

/**
 * 已提交且 live 为空时的历史归档目录入口。
 *
 * `lastCommitAt` 由阶段一提交写入；提交成功后 live 消息按 `keepRecentCount` 保留，
 * 默认整批移入 `history/archive_NNN/`。这里只把该会话真实的 `history/` 目录变成
 * 文件树路由，不拼接具体归档序号，也不读取归档正文。
 */
export function sessionArchiveRouteOf(
  session: CommittedSession,
  liveMessageCount: number,
): string | null {
  if (session.lastCommitAt === null || session.lastCommitAt === '' || liveMessageCount !== 0) {
    return null
  }
  const sessionUri = session.uri.replace(/\/+$/u, '')
  return fileRouteOf(`${sessionUri}/history`)
}
