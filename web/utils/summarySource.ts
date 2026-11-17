export type SummarySource = 'index' | 'summary' | 'none'

const ARCHIVED_MESSAGES_PATH =
  /^comem:\/\/user\/([^/]+)\/sessions\/([^/]+)\/([^/]+)\/archive_\d+\/messages\.jsonl$/u

export function summarySourceLabelOf(source: SummarySource | null): string | null {
  if (source === 'index') {
    return '索引摘要'
  }
  if (source === 'summary') {
    return '文件摘要'
  }
  return null
}

/**
 * 仅定位个人会话归档里的原始消息文件所在目录。
 *
 * 归档目录名可以由 `session.archiveDirectoryName` 配置，所以这里不写死 `history`；
 * 调用方还必须用 `/fs/stat` 与目录摘要确认，不能只凭路径显示入口。
 */
export function archiveMessagesDirectoryOf(uri: string): string | null {
  const normalized = uri.replace(/\/+$/u, '')
  const match = ARCHIVED_MESSAGES_PATH.exec(normalized)
  if (match === null || match.slice(1).some((segment) => segment === '.' || segment === '..')) {
    return null
  }
  return normalized.slice(0, normalized.lastIndexOf('/'))
}
