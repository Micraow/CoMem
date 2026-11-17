import type { PendingMemoryPayload } from '~/composables/useApi'

const URI_PREFIX = 'comem://'
const EVENT_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/u
const INFERRED_TOPIC_PREFIX = /^inferred-/u
const INFERENCE_HEADING = '推断偏好（需以用户明确表达为准）'
const CONDITION_PREFIX = '适用条件：'
const EVIDENCE_HEADING = '证据：'

const TYPE_IDENTITY_KEYS: Readonly<Record<string, readonly string[]>> = {
  profile: ['name'],
  preferences: ['topic'],
  entities: ['name'],
  events: ['event'],
  identity: ['name'],
  soul: ['name'],
  experiences: ['topic'],
  rules: ['rule'],
}

const GENERIC_IDENTITY_KEYS = ['topic', 'rule', 'event', 'name', 'scenario'] as const

export interface ReviewCitation {
  readonly uri: string
  readonly quote: string
}

export interface ReviewNarrative {
  readonly body: string
  readonly inferred: boolean
  readonly condition: string | null
  readonly citations: readonly ReviewCitation[]
}

function stringField(
  fields: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = fields[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function lastSegmentOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  return decodeSegment(trimmed.slice(trimmed.lastIndexOf('/') + 1))
}

function readableIdentity(value: string): string {
  return value
    .replace(INFERRED_TOPIC_PREFIX, '')
    .replace(EVENT_DATE_PREFIX, '')
    .replace(/[-_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** `fields.content` 是待复核记忆的正文；不是字符串时按空正文处理。 */
export function memoryReviewContentOf(memory: PendingMemoryPayload): string {
  const value = memory.fields['content']
  return typeof value === 'string' ? value : ''
}

function citationOf(line: string): ReviewCitation | null {
  if (!line.startsWith('- ')) {
    return null
  }
  const separator = line.indexOf('：', 2)
  if (separator <= 2) {
    return null
  }

  const uri = line.slice(2, separator).trim()
  if (!uri.startsWith(URI_PREFIX)) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(line.slice(separator + 1).trim())
    if (typeof parsed !== 'string' || parsed.trim() === '') {
      return null
    }
    return { uri, quote: parsed.trim() }
  } catch {
    return null
  }
}

/**
 * 把 Dreamer 的稳定写盘格式拆成可展示结构。
 *
 * 真实格式来自 `src/services/dreamer/preferences.ts`：
 * `推断偏好… / 适用条件 / preference / 证据 / - URI：JSON quote`。
 * 只有标题、条件行和证据标记全部命中时才拆；其它记忆保持原文，避免把正文里
 * 普通出现的「证据：」误当成结构化数据。引用单行必须能通过 `JSON.parse`，
 * 解析失败的内容不会升级成一句看似真实的引用。
 */
export function memoryReviewNarrativeOf(memory: PendingMemoryPayload): ReviewNarrative {
  const raw = memoryReviewContentOf(memory)
  const lines = raw.replace(/\r\n/gu, '\n').split('\n')
  if (memory.memoryType !== 'preferences' || lines[0]?.trim() !== INFERENCE_HEADING) {
    return { body: raw, inferred: false, condition: null, citations: [] }
  }

  const evidenceIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === EVIDENCE_HEADING,
  )
  if (evidenceIndex < 0) {
    return { body: raw, inferred: false, condition: null, citations: [] }
  }

  let index = 1
  while (index < evidenceIndex && lines[index]?.trim() === '') {
    index += 1
  }

  const conditionLine = lines[index]?.trim() ?? ''
  if (!conditionLine.startsWith(CONDITION_PREFIX)) {
    return { body: raw, inferred: false, condition: null, citations: [] }
  }
  const condition = conditionLine.slice(CONDITION_PREFIX.length).trim()
  const body = lines.slice(index + 1, evidenceIndex).join('\n').trim()
  const citations = lines
    .slice(evidenceIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(citationOf)

  if (citations.length === 0 || !citations.every((citation) => citation !== null)) {
    return { body: raw, inferred: false, condition: null, citations: [] }
  }

  return {
    body,
    inferred: true,
    condition: condition || null,
    citations,
  }
}

/**
 * 队列和详情共用的标题。
 *
 * 身份字段先于文件名：`topic` / `rule` / `event` / `name` 是用户能理解的记忆名字，
 * 文件名只是它们的存储投影。未知类型仍按常见身份字段查找；字段缺失时才回退到
 * 去掉 `.md` 的文件名，界面不会把 URI 当标题。
 */
export function memoryReviewTitleOf(memory: PendingMemoryPayload): string {
  const keys = TYPE_IDENTITY_KEYS[memory.memoryType] ?? GENERIC_IDENTITY_KEYS
  for (const key of keys) {
    const value = stringField(memory.fields, key)
    if (value !== null) {
      return readableIdentity(value) || value
    }
  }

  const filename = lastSegmentOf(memory.uri)
  return readableIdentity(filename.replace(/\.md$/iu, '')) || lastSegmentOf(memory.uri)
}

/**
 * 来源链接的标签；完整 URI 保留给链接的 `title`。
 *
 * 同一会话目录下常有同名 `archive_001`，只显示末段会得到两条完全相同的来源。
 * 对标准的 `sessions/{id}/history/archive_NNN`，把会话名一起保留下来；其它来源
 * 仍只显示末段，避免把整条 URI 变成可见小字。
 */
export function sourceContextLabelOf(uri: string): string {
  const relative = uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri
  const parts = relative.split('/').filter((segment) => segment !== '')
  const archive = parts.at(-1) ?? ''
  const sessionsIndex = parts.lastIndexOf('sessions')
  const session = sessionsIndex >= 0 ? parts[sessionsIndex + 1] : undefined
  return session === undefined ? lastSegmentOf(uri) || relative : `${decodeSegment(session)} / ${decodeSegment(archive)}`
}
