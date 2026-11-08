<script setup lang="ts">
/**
 * 记忆复核（架构文档 §16 的第三页、§11.6）。
 *
 * 左队列右差异。通过 → `active`（进入检索）；拒绝 → 删除并记日志。
 *
 * **批量操作逐条独立。** 服务端没有批量端点，一次失败不应把后面的也拦下来，
 * 也不应该整批回滚——被拒绝的记录已经删掉了。所以逐条串行执行、逐条捕获，
 * 最后汇总「成功 N 条，失败 M 条」。
 *
 * **URI 参数必须 `encodeURIComponent`。** `comem://` 里的 `:` 与 `/` 不转义会被
 * Fastify 当成多段路径，路由匹配不到（`/memories/:uri/approve`）。
 *
 * **拒绝原因只写日志。** 服务端 `reject` 把 `reason` 交给 logger 就返回，没有
 * 落盘。界面上说明「会记入服务端日志」，不暗示它被持久化在记忆文件里。
 */
import { AlertTriangle } from 'lucide-vue-next'

import { errorMessageOf, useApi, type ContentReadPayload } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import type {
  PendingListPayload,
  PendingMemoryPayload,
} from '~/components/domain/ReviewList.vue'

useHead({ title: '记忆复核 · CoMem 控制台' })

/** 存储层把正文放在 `## content` 标题下；差异视图比较的是正文，标题是存储细节。 */
const CONTENT_HEADING = '## content'

const api = useApi()
const toast = useToast()

const memories = ref<readonly PendingMemoryPayload[] | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const selectedUri = ref<string | null>(null)
const checked = ref<readonly string[]>([])

const baseline = ref<string | null>(null)
const baselineLoading = ref(false)
const baselineError = ref<string | null>(null)

const busy = ref(false)
const batchRejectOpen = ref(false)
const batchReason = ref('')

/** 基线请求的序号：切换选中时丢弃迟到的响应，否则会显示上一条的正文。 */
let baselineToken = 0

const selectedMemory = computed<PendingMemoryPayload | null>(() => {
  if (memories.value === null || selectedUri.value === null) {
    return null
  }
  return memories.value.find((memory) => memory.uri === selectedUri.value) ?? null
})

function stripContentHeading(text: string): string {
  if (!text.startsWith(CONTENT_HEADING)) {
    return text
  }
  return text.slice(CONTENT_HEADING.length).replace(/^\n+/, '')
}

function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

function memoryPath(uri: string, action: 'approve' | 'reject'): string {
  return `/memories/${encodeURIComponent(uri)}/${action}`
}

async function loadBaseline(uri: string | null): Promise<void> {
  baselineToken += 1
  const token = baselineToken
  baseline.value = null
  baselineError.value = null

  if (uri === null) {
    baselineLoading.value = false
    return
  }

  baselineLoading.value = true
  try {
    const payload = await api.get<ContentReadPayload>('/content/read', { uri })
    if (token === baselineToken) {
      baseline.value = stripContentHeading(payload.text)
    }
  } catch (caught) {
    if (token === baselineToken) {
      baselineError.value = errorMessageOf(caught)
    }
  } finally {
    if (token === baselineToken) {
      baselineLoading.value = false
    }
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null

  try {
    const payload = await api.get<PendingListPayload>('/memories/pending')
    memories.value = payload.memories

    const present = new Set(payload.memories.map((memory) => memory.uri))
    checked.value = checked.value.filter((uri) => present.has(uri))

    if (selectedUri.value === null || !present.has(selectedUri.value)) {
      selectedUri.value = payload.memories[0]?.uri ?? null
    }
  } catch (caught) {
    error.value = errorMessageOf(caught)
    memories.value = null
    selectedUri.value = null
  } finally {
    loading.value = false
    await loadBaseline(selectedUri.value)
  }
}

function selectUri(uri: string): void {
  if (uri === selectedUri.value) {
    return
  }
  selectedUri.value = uri
  void loadBaseline(uri)
}

/** 从队列里移出若干条，并把选中项落到下一条上。 */
function dropFromQueue(uris: readonly string[]): void {
  const dropped = new Set(uris)
  const remaining = (memories.value ?? []).filter((memory) => !dropped.has(memory.uri))
  memories.value = remaining
  checked.value = checked.value.filter((uri) => !dropped.has(uri))

  if (selectedUri.value !== null && dropped.has(selectedUri.value)) {
    selectedUri.value = remaining[0]?.uri ?? null
    void loadBaseline(selectedUri.value)
  }
}

async function approveOne(uri: string): Promise<string | null> {
  try {
    await api.post<unknown>(memoryPath(uri, 'approve'))
    return null
  } catch (caught) {
    return errorMessageOf(caught)
  }
}

async function rejectOne(uri: string, reason: string): Promise<string | null> {
  try {
    await api.post<unknown>(memoryPath(uri, 'reject'), { reason })
    return null
  } catch (caught) {
    return errorMessageOf(caught)
  }
}

async function approveSelected(): Promise<void> {
  const memory = selectedMemory.value
  if (memory === null || busy.value) {
    return
  }

  busy.value = true
  const failure = await approveOne(memory.uri)
  busy.value = false

  if (failure === null) {
    dropFromQueue([memory.uri])
    toast.show('success', `已通过：${nameOf(memory.uri)}`)
    return
  }
  toast.show('error', failure)
}

async function rejectSelected(reason: string): Promise<void> {
  const memory = selectedMemory.value
  if (memory === null || busy.value) {
    return
  }

  busy.value = true
  const failure = await rejectOne(memory.uri, reason)
  busy.value = false

  if (failure === null) {
    dropFromQueue([memory.uri])
    toast.show('success', `已拒绝：${nameOf(memory.uri)}`)
    return
  }
  toast.show('error', failure)
}

async function runBatch(action: 'approve' | 'reject', reason: string): Promise<void> {
  const uris = [...checked.value]
  if (uris.length === 0 || busy.value) {
    return
  }

  busy.value = true
  const succeeded: string[] = []
  const failures: string[] = []

  for (const uri of uris) {
    const failure = action === 'approve' ? await approveOne(uri) : await rejectOne(uri, reason)
    if (failure === null) {
      succeeded.push(uri)
    } else {
      failures.push(`${nameOf(uri)}：${failure}`)
    }
  }

  busy.value = false
  dropFromQueue(succeeded)

  if (failures.length === 0) {
    toast.show('success', `成功 ${succeeded.length} 条，失败 0 条`)
    return
  }

  toast.show(
    succeeded.length === 0 ? 'error' : 'warning',
    `成功 ${succeeded.length} 条，失败 ${failures.length} 条`,
  )
}

function openBatchReject(): void {
  if (checked.value.length === 0) {
    return
  }
  batchReason.value = ''
  batchRejectOpen.value = true
}

function confirmBatchReject(): void {
  const reason = batchReason.value.trim()
  if (reason === '') {
    return
  }
  batchRejectOpen.value = false
  void runBatch('reject', reason)
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="content content--split">
    <div class="split">
      <DomainReviewList
        v-model:checked="checked"
        :memories="memories ?? []"
        :loading="loading"
        :error="error"
        :selected-uri="selectedUri"
        @select="selectUri"
        @refresh="load"
        @batch-approve="runBatch('approve', '')"
        @batch-reject="openBatchReject"
      />

      <DomainMemoryDiff
        :memory="selectedMemory"
        :baseline="baseline"
        :baseline-loading="baselineLoading"
        :baseline-error="baselineError"
        :busy="busy"
        @approve="approveSelected"
        @reject="rejectSelected"
      />
    </div>

    <UiDialog v-model="batchRejectOpen" title="拒绝所选的记忆">
      <div class="stack-16">
        <p class="body-sm muted">
          将删除 {{ checked.length }} 条待复核记录。原因会记入服务端日志，不会保存在记忆文件里。
        </p>
        <UiTextarea v-model="batchReason" aria-label="批量拒绝原因" :rows="3" />
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="batchRejectOpen = false">取消</UiButton>
          <UiButton
            variant="danger"
            :disabled="batchReason.trim() === '' || busy"
            @click="confirmBatchReject"
          >
            <AlertTriangle :size="14" :stroke-width="1.8" />
            确认拒绝
          </UiButton>
        </div>
      </div>
    </UiDialog>

    <UiToast />
  </div>
</template>
