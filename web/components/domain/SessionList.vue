<script lang="ts">
/**
 * 会话列表（架构文档 §16 的「会话列表、归档列表」、§10.1 的两阶段提交）。
 *
 * ## 为什么消息要懒加载
 *
 * `GET /sessions` 的响应里带了每个会话的完整消息（`serializeSession` 原样输出
 * `session.messages`），但控制台一条都不渲染——展开时才 `GET /sessions/{id}` 取
 * 一份**当下**的快照。理由不是省流量（服务端已经发了），而是正确性：列表可能已经
 * 在页面上放了几分钟，拿列表里的旧消息渲染展开体，用户会以为会话停在那儿没动。
 *
 * ## 为什么 tool 消息默认折叠
 *
 * 工具输出是整段日志，一条就能把展开体撑到几千像素，把 user / assistant 的对话
 * 挤到看不见。默认只留一行标题，点开才看 `parts`（§10.1 的 `ToolPart`）。
 *
 * ## 状态文案
 *
 * 领域层是 `open` / `archived`（`SessionStatus`），界面用「进行中 / 已归档」。
 * 归档是 CoMem 里的动作名，不是内部术语，可以直接出现在界面上。两张标签表
 * （状态、角色）与取值清单都在 `utils/sessionLabels.ts`，这里只声明形状。
 */
import {
  messageRoleLabel,
  sessionStatusLabel,
  type MessageRole,
  type SessionStatus,
} from '~/utils/sessionLabels'

/** 会话消息的 part（`src/domain/session.ts` 的 `ContentPart`）。 */
export type SessionPartPayload =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly url: string; readonly alt: string | null }
  | { readonly kind: 'context'; readonly uri: string; readonly abstract: string }
  | {
      readonly kind: 'tool_use'
      readonly toolUseId: string
      readonly name: string
      readonly input: unknown
    }
  | {
      readonly kind: 'tool_result'
      readonly toolUseId: string
      readonly output: string
      readonly isError: boolean
    }

export interface SessionMessagePayload {
  readonly id: string
  readonly role: MessageRole
  readonly parts: readonly SessionPartPayload[]
  readonly createdAt: string
  readonly turn: number
}

/**
 * `GET /sessions` 的会话行与 `GET /sessions/{id}` 同一形状。
 *
 * `messages` 只用来取**第一条消息的时间**当会话起点（服务端没有单独的
 * `createdAt` 出口），不渲染。
 */
export interface SessionSummaryPayload {
  readonly id: string
  readonly uri: string
  readonly status: SessionStatus
  readonly messageCount: number
  readonly lastCommitAt: string | null
  readonly pendingTokens: number
  readonly messages: readonly SessionMessagePayload[]
}

export interface SessionListPayload {
  readonly scope: string
  readonly sessions: readonly SessionSummaryPayload[]
}

/**
 * 会话的「最近活动」时间。
 *
 * 服务端没有暴露 `createdAt`：`SessionMeta` 有，但 `serializeSession` 没带出来。
 * 能拿到的是两个更接近「活动」的时刻——最近一次提交，或第一条存活消息的时间。
 * 已归档的会话没有存活消息（`keepRecentCount` 默认 0），所以必须有 `lastCommitAt`
 * 这一支，否则归档过的会话会显示「—」。
 */
export function sessionActivityAt(session: SessionSummaryPayload): string | null {
  return session.lastCommitAt ?? session.messages[0]?.createdAt ?? null
}

/** 一条 part 的展示形态：标签行 + 正文 + 是否原样等宽显示。 */
export interface DisplayPart {
  readonly kind: string
  /** 正文上方的说明行；`text` part 没有。 */
  readonly meta: string | null
  readonly text: string
  readonly isError: boolean
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function toDisplayPart(part: SessionPartPayload): DisplayPart {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', meta: null, text: part.text, isError: false }
    case 'image':
      return { kind: 'image', meta: '图片', text: part.alt ?? part.url, isError: false }
    case 'context':
      return { kind: 'context', meta: `引用 ${part.uri}`, text: part.abstract, isError: false }
    case 'tool_use':
      return { kind: 'tool_use', meta: `调用 ${part.name}`, text: stringify(part.input), isError: false }
    case 'tool_result':
      return {
        kind: 'tool_result',
        meta: part.isError ? '工具返回（出错）' : '工具返回',
        text: part.output,
        isError: part.isError,
      }
  }
}
</script>

<script setup lang="ts">
import { CheckCircle2, ChevronRight, MessageSquare } from 'lucide-vue-next'

import {
  ApiClientError,
  errorMessageOf,
  useApi,
  useScopeRoot,
} from '~/composables/useApi'

import { formatDateTimeWithSeconds, formatRelativeTime } from '~/utils/format'

const props = withDefaults(
  defineProps<{
    sessions: readonly SessionSummaryPayload[]
    loading: boolean
    error: string | null
    /** 正在提交的会话 ID：按钮转成禁用态，避免重复提交。 */
    committing: readonly string[]
    /** 提交成功后服务端返回的任务 ID，挂在对应会话下方。 */
    committedTaskIds: Readonly<Record<string, string>>
  }>(),
  { committedTaskIds: () => ({}) },
)

const emit = defineEmits<{ commit: [sessionId: string] }>()

const api = useApi()
/**
 * 详情必须带与列表相同的 `scopeUri`。
 *
 * `GET /sessions/{id}` 缺省按当前身份的个人根定位会话；在组作用域下列表能列出
 * 组里的会话，详情却去个人根找同一个 ID，结果恒为 404「会话已不存在」。
 */
const scopeRoot = useScopeRoot()

const openId = ref<string | null>(null)
/** 已取回的会话快照：来回展开不重复请求。 */
const snapshots = ref<Readonly<Record<string, readonly SessionMessagePayload[]>>>({})
/** 折叠着的 tool 消息 ID（§16：tool 消息默认折叠）。 */
const expandedTools = ref<readonly string[]>([])
const detailLoadingId = ref<string | null>(null)
const detailError = ref<string | null>(null)

async function toggle(sessionId: string): Promise<void> {
  if (openId.value === sessionId) {
    openId.value = null
    return
  }

  openId.value = sessionId
  detailError.value = null

  if (snapshots.value[sessionId] !== undefined) {
    return
  }

  detailLoadingId.value = sessionId
  try {
    const payload = await api.get<{ messages: readonly SessionMessagePayload[] }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { scopeUri: scopeRoot.value },
    )
    snapshots.value = { ...snapshots.value, [sessionId]: payload.messages }
  } catch (caught) {
    detailError.value =
      caught instanceof ApiClientError && caught.statusCode === 404
        ? '这个会话已经不存在，可能已经被清理。'
        : errorMessageOf(caught)
  } finally {
    detailLoadingId.value = null
  }
}

function isToolExpanded(messageId: string): boolean {
  return expandedTools.value.includes(messageId)
}

function toggleTool(messageId: string): void {
  expandedTools.value = isToolExpanded(messageId)
    ? expandedTools.value.filter((id) => id !== messageId)
    : [...expandedTools.value, messageId]
}

function partsOf(sessionId: string): readonly SessionMessagePayload[] {
  return snapshots.value[sessionId] ?? []
}

/**
 * 提交成功后丢掉该会话的缓存快照。
 *
 * 提交会清空会话的存活消息（`keepRecentCount` 默认 0）。留着快照的话，用户点开
 * 刚提交过的会话还会看到「提交前」的消息，而列表上的待提交计数已经是 0——两处
 * 互相矛盾，读起来像丢数据。
 */
watch(
  () => props.committedTaskIds,
  (committed) => {
    const stale = Object.keys(committed).filter((id) => snapshots.value[id] !== undefined)
    if (stale.length === 0) {
      return
    }
    const next = { ...snapshots.value }
    for (const id of stale) {
      delete next[id]
    }
    snapshots.value = next
  },
)

function commitTitleOf(session: SessionSummaryPayload): string {
  if (props.committing.includes(session.id)) {
    return '正在提交。'
  }
  return '把未提交的消息归档，并创建后台任务。'
}
</script>

<template>
  <div class="stack-16">
    <UiErrorCallout v-if="props.error !== null" :message="props.error" />

    <div v-if="props.loading && props.sessions.length === 0" class="session-skeleton">
      <UiSkeleton v-for="index in 4" :key="index" :width="`${72 - index * 6}%`" height="16px" />
    </div>

    <div v-else-if="props.sessions.length > 0" class="sessions">
      <article
        v-for="session in props.sessions"
        :key="session.id"
        class="session"
        :class="{ 'is-open': openId === session.id }"
      >
        <div class="session__head">
          <button
            type="button"
            class="session__toggle"
            :aria-expanded="openId === session.id"
            @click="toggle(session.id)"
          >
            <ChevronRight
              class="session__caret"
              :class="{ 'is-open': openId === session.id }"
              :size="14"
              :stroke-width="1.6"
              aria-hidden="true"
            />
            <span class="session__id mono">{{ session.id }}</span>
          </button>

          <UiBadge :variant="session.status === 'open' ? 'solid' : 'outline-faint'" size="sm">
            {{ sessionStatusLabel(session.status) }}
          </UiBadge>

          <span class="session__count">待提交 {{ session.messageCount }} 条</span>

          <time
            v-if="sessionActivityAt(session) !== null"
            class="session__time mono"
            :title="formatDateTimeWithSeconds(sessionActivityAt(session) ?? '')"
          >
            {{ formatRelativeTime(sessionActivityAt(session) ?? '') }}
          </time>
          <span v-else class="session__time faint">—</span>

          <UiButton
            variant="secondary"
            size="sm"
            :disabled="props.committing.includes(session.id)"
            :title="commitTitleOf(session)"
            @click="emit('commit', session.id)"
          >
            提交
          </UiButton>
        </div>

        <p v-if="props.committedTaskIds[session.id] !== undefined" class="session__task">
          已创建任务
          <b class="mono">{{ props.committedTaskIds[session.id] }}</b>
          ，切到「任务」查看。
        </p>

        <div v-if="openId === session.id" class="session__body">
          <UiErrorCallout v-if="detailError !== null" :message="detailError" />

          <div v-else-if="detailLoadingId === session.id" class="stack-10" aria-busy="true">
            <UiSkeleton width="60%" height="14px" />
            <UiSkeleton width="88%" height="14px" />
            <UiSkeleton width="42%" height="14px" />
          </div>

          <UiEmpty
            v-else-if="partsOf(session.id).length === 0"
            v-slot="{ size }"
            :title="session.status === 'open' ? '这个会话还没有消息' : '没有待提交的消息'"
          >
            <MessageSquare :size="size" :stroke-width="1.4" />
          </UiEmpty>

          <ol v-else class="messages">
            <li
              v-for="message in partsOf(session.id)"
              :key="message.id"
              class="message"
              :data-role="message.role"
            >
              <div class="message__head">
                <span class="message__role">{{ messageRoleLabel(message.role) }}</span>
                <time class="message__time mono" :title="formatDateTimeWithSeconds(message.createdAt)">
                  {{ formatRelativeTime(message.createdAt) }}
                </time>
              </div>

              <template v-if="message.role === 'tool' && !isToolExpanded(message.id)">
                <button type="button" class="message__expand" @click="toggleTool(message.id)">
                  展开工具输出（{{ message.parts.length }} 段）
                </button>
              </template>

              <div v-else class="message__parts">
                <template v-if="message.role === 'tool'">
                  <button type="button" class="message__expand" @click="toggleTool(message.id)">
                    收起工具输出
                  </button>
                </template>

                <div
                  v-for="(part, index) in message.parts.map(toDisplayPart)"
                  :key="index"
                  class="part"
                  :class="{ 'is-error': part.isError }"
                >
                  <div v-if="part.meta !== null" class="part__meta">{{ part.meta }}</div>
                  <pre v-if="part.kind !== 'text' && part.kind !== 'image'" class="part__raw">{{
                    part.text
                  }}</pre>
                  <p v-else class="part__text">{{ part.text }}</p>
                </div>
              </div>
            </li>
          </ol>
        </div>
      </article>
    </div>

    <UiEmpty v-else-if="props.error === null" v-slot="{ size }" title="还没有会话">
      <CheckCircle2 :size="size" :stroke-width="1.4" />
    </UiEmpty>
  </div>
</template>

<style scoped>
.session-skeleton {
  display: grid;
  gap: 16px;
  padding: 24px 20px;
  border-radius: var(--r-panel);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.sessions {
  display: grid;
  gap: 10px;
}

.session {
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
  overflow: hidden;
  transition: box-shadow var(--dur-fast) var(--ease);
}

.session.is-open {
  border-radius: var(--r-panel);
}

.session__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  flex-wrap: wrap;
}

.session__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--label);
  cursor: pointer;
  text-align: left;
}

.session__caret {
  color: var(--label-3);
  transition: transform var(--dur) var(--ease), color var(--dur-fast) var(--ease);
}

.session__caret.is-open {
  transform: rotate(90deg);
  color: var(--accent-ink);
}

.session__toggle:hover .session__id {
  color: var(--accent-ink);
}

.session__id {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session__count {
  font-size: 13px;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.session__time {
  font-size: 13px;
  color: var(--label-3);
  margin-left: auto;
}

.session__task {
  display: block;
  padding: 0 16px 12px 38px;
  font-size: 13px;
  color: var(--label-3);
}

.session__task b {
  color: var(--accent-ink);
  font-weight: 600;
}

.session__body {
  padding: 4px 16px 18px 38px;
  border-top: 0.5px solid var(--separator);
}

.messages {
  display: grid;
  gap: 14px;
  margin-top: 14px;
}

.message {
  display: grid;
  gap: 7px;
  padding-left: 12px;
  border-left: 2px solid var(--fill-2);
}

.message[data-role="user"] {
  border-left-color: var(--accent);
}

.message[data-role="assistant"] {
  border-left-color: var(--teal);
}

.message[data-role="system"] {
  border-left-color: var(--purple);
}

.message[data-role="tool"] {
  border-left-color: var(--fill-3);
}

.message__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.message__role {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--label-2);
}

.message[data-role="user"] .message__role {
  color: var(--accent-ink);
}

.message[data-role="assistant"] .message__role {
  color: var(--teal-ink);
}

.message[data-role="system"] .message__role {
  color: var(--purple-ink);
}

.message__time {
  font-size: 12px;
  color: var(--label-4);
}

.message__expand {
  justify-self: start;
  padding: 3px 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  font-size: 13px;
  color: var(--label-2);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.message__expand:hover {
  background: var(--fill-3);
  color: var(--label);
}

.message__parts {
  display: grid;
  gap: 10px;
}

.part {
  display: grid;
  gap: 5px;
}

.part__meta {
  font-size: 13px;
  color: var(--label-3);
  word-break: break-all;
}

.part__text {
  font-size: 14px;
  line-height: 1.55;
  color: var(--label);
  white-space: pre-wrap;
  word-break: break-word;
}

.part__raw {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-control);
  background: var(--bg-2);
  box-shadow: var(--inset-hair);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--label-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

.part.is-error .part__raw {
  color: var(--label);
}
</style>
