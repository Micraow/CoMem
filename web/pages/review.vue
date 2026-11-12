<script setup lang="ts">
/**
 * 记忆复核（架构文档 §16 的第三页、§11.6）。
 *
 * 左队列右差异。通过 → `active`（进入检索）；拒绝 → 回到上一次被覆盖前的值，
 * 没有可回退的版本时才删除。
 *
 * **批量操作逐条独立。** 服务端没有批量端点，一次失败不应把后面的也拦下来，
 * 也不应该整批回滚——已经处理过的记录不会回到待复核队列。所以逐条串行执行、
 * 逐条捕获，最后汇总「成功 N 条，失败 M 条」。
 *
 * **失败原因留在页面上。** 逐条的「哪条、为什么」放在队列上方的横栏里，只在下一轮
 * 批量操作或重新拉取队列时清空。toast 只报总数：它 3 秒后自动消失，装不下需要
 * 用户对照队列逐条处理的信息（`composables/useToast.ts` 的约定）。
 *
 * **URI 参数必须 `encodeURIComponent`。** `comem://` 里的 `:` 与 `/` 不转义会被
 * Fastify 当成多段路径，路由匹配不到（`/memories/:uri/approve`）。
 *
 * **拒绝原因只写日志。** 服务端 `reject` 把 `reason` 交给 logger 就返回，没有
 * 落盘。界面上说明「会记入服务端日志」，不暗示它被持久化在记忆文件里。
 */
import { AlertTriangle, X } from 'lucide-vue-next'

import {
  forbiddenMessageOf,
  useApi,
  type ContentReadPayload,
} from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { memoryBodyText } from '~/utils/memoryBody'
import type {
  PendingListPayload,
  PendingMemoryPayload,
} from '~/components/domain/ReviewList.vue'

/**
 * 批量操作里失败的条目。
 *
 * 失败原因逐条留在页面上，不塞进 toast：toast 是 3 秒后自动消失的一次性回执，
 * 「哪几条失败、各自为什么」需要用户对照队列逐条处理。`uri` 留着做 key 与
 * `title`——不同目录下可能有同名记忆。
 */
interface BatchFailure {
  readonly uri: string
  readonly reason: string
}

useHead({ title: '记忆复核 · CoMem 控制台' })

const api = useApi()
const toast = useToast()
const scopeRoot = useScopeRoot()

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

/** 上一轮批量操作里没成功的条目；名称在模板里由 URI 推，不重复存一份。 */
const batchFailures = ref<readonly BatchFailure[]>([])

/** 基线请求的序号：切换选中时丢弃迟到的响应，否则会显示上一条的正文。 */
let baselineToken = 0

const selectedMemory = computed<PendingMemoryPayload | null>(() => {
  if (memories.value === null || selectedUri.value === null) {
    return null
  }
  return memories.value.find((memory) => memory.uri === selectedUri.value) ?? null
})

function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

function memoryPath(uri: string, action: 'approve' | 'reject'): string {
  return `/memories/${encodeURIComponent(uri)}/${action}`
}

/**
 * 通过 / 拒绝失败的提示。
 *
 * 403 的服务端原文是「没有权限：<uri> 需要 write（3）级别。」——动作名与级别数字
 * 是内部术语（§11），界面上只说「没有权限复核这条记忆」。其它失败仍显示服务端
 * 消息，那是排查用的诊断信息。判定收在 `forbiddenMessageOf`，与提示词页、权限页
 * 同一形状，不在这里再写一遍。
 */
function actionErrorOf(caught: unknown): string {
  return forbiddenMessageOf(caught, '你没有权限复核这条记忆')
}

/**
 * 基线正文读不到：403 是权限问题，不说成「读取失败」——同一句判定，句子按语义给。
 */
function baselineMessageOf(caught: unknown): string {
  return forbiddenMessageOf(caught, '你没有权限查看这条记忆的正文')
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
      baseline.value = memoryBodyText(payload.text)
    }
  } catch (caught) {
    if (token === baselineToken) {
      baselineError.value = baselineMessageOf(caught)
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
  // 队列要重新取了：上一轮的失败条目对应的状态已经过期，留着只会误导。
  batchFailures.value = []

  try {
    const payload = await api.get<PendingListPayload>('/memories/pending', {
      scopeUri: scopeRoot.value,
    })
    memories.value = payload.memories

    const present = new Set(payload.memories.map((memory) => memory.uri))
    checked.value = checked.value.filter((uri) => present.has(uri))

    if (selectedUri.value === null || !present.has(selectedUri.value)) {
      selectedUri.value = payload.memories[0]?.uri ?? null
    }
  } catch (caught) {
    // 队列本身读不到：403 是「没有权限看这个作用域的待复核队列」，不是「读取失败」。
    // 服务端原文带内部级别，不进界面（§11）；其它失败仍显示服务端消息。
    error.value = forbiddenMessageOf(caught, '你没有权限查看待复核队列')
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
    return actionErrorOf(caught)
  }
}

async function rejectOne(uri: string, reason: string): Promise<string | null> {
  try {
    await api.post<unknown>(memoryPath(uri, 'reject'), { reason })
    return null
  } catch (caught) {
    return actionErrorOf(caught)
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
  // 上一次的结果在这里清空：失败列表只描述「刚才那一轮」，不跨轮累积。
  batchFailures.value = []
  const succeeded: string[] = []
  const failures: BatchFailure[] = []

  for (const uri of uris) {
    const failure = action === 'approve' ? await approveOne(uri) : await rejectOne(uri, reason)
    if (failure === null) {
      succeeded.push(uri)
    } else {
      failures.push({ uri, reason: failure })
    }
  }

  busy.value = false
  dropFromQueue(succeeded)
  batchFailures.value = failures

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

// 作用域切换后复核队列是另一批记忆：重新取，并让选中项跟随新列表。
watch(scopeRoot, () => {
  selectedUri.value = null
  void load()
})
</script>

<template>
  <div class="content content--split review-page">
    <UiCallout
      v-if="batchFailures.length > 0"
      class="batch-failures"
      aria-label="批量操作失败原因"
    >
      <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
      <div class="batch-failures__body">
        <p><b>{{ batchFailures.length }} 条没有处理成功：</b></p>
        <ul class="batch-failures__list">
          <li v-for="item in batchFailures" :key="item.uri" class="batch-failures__row">
            <span class="batch-failures__name" :title="item.uri">{{ nameOf(item.uri) }}</span>
            <span class="batch-failures__reason">{{ item.reason }}</span>
          </li>
        </ul>
      </div>
      <button type="button" class="iconbtn" aria-label="关闭失败原因" @click="batchFailures = []">
        <X :size="15" :stroke-width="1.6" />
      </button>
    </UiCallout>

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
          拒绝会把所选的 {{ checked.length }} 条记忆恢复到上一次被覆盖前的值，没有可回退的版本时才删除。原因会记入服务端日志，不会保存在记忆文件里。
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

<style scoped>
/* `.content--split` 默认是横向 flex；这里改成纵向，让失败提示条与左右分栏上下排。
   移动端（≤900px）`.content--split` 回到 block，这条规则不再起作用。 */
.review-page {
  flex-direction: column;
}

.batch-failures {
  flex: none;
  margin: 14px 16px 12px;
}

.batch-failures__body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}

/* 条目多时最多占视口的 40%，其余滚动——不把左右分栏挤出屏幕。 */
.batch-failures__list {
  display: grid;
  gap: 4px;
  max-height: 40vh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.batch-failures__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  line-height: 1.45;
}

.batch-failures__name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  color: var(--label);
}

.batch-failures__reason {
  min-width: 0;
  color: var(--label-2);
  overflow-wrap: anywhere;
}
</style>
