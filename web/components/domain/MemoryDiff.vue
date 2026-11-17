<script setup lang="ts">
/**
 * 记忆复核详情。
 *
 * 新记忆只显示待生效正文一次。更新记忆以 `supersedes` 对应正文为基线，显示
 * 真实的单栏行级差异；`baseline` 为空、正在读取或读取失败时都不会伪造上一版本。
 * 来源来自服务端给出的归档 URI，没有来源或引用数据时整块不渲染。
 */
import { Check, Link2, Loader2, Pencil, X } from 'lucide-vue-next'

import { fileRouteOf } from '~/utils/fileRoute'
import { formatMonthDayTime, formatRelativeTime } from '~/utils/format'
import { memoryTypeLabelOf, memoryTypeVariantOf } from '~/utils/memoryTypeLabels'
import {
  hasReviewContent,
  type ApproveReviewEdit,
} from '~/utils/reviewEdit'

import type { PendingMemoryPayload } from './ReviewList.vue'
import {
  memoryReviewContentOf,
  memoryReviewNarrativeOf,
  memoryReviewTitleOf,
  sourceContextLabelOf,
} from './memoryReview'

const props = defineProps<{
  memory: PendingMemoryPayload | null
  /** 更新条目的上一版本正文；新条目为 null，页面不应请求 `/content/read`。 */
  baseline: string | null
  baselineLoading: boolean
  baselineError: string | null
  busy: boolean
  actionBusy?: 'approve' | 'reject' | null
}>()

const emit = defineEmits<{
  approve: [edit?: ApproveReviewEdit]
  reject: [reason: string]
}>()

type DiffKind = 'context' | 'add' | 'remove'
type ReviewView = 'proposal' | 'baseline'

interface DiffRow {
  readonly kind: DiffKind
  readonly leftNo: number | null
  readonly rightNo: number | null
  readonly text: string
}

const rejectOpen = ref(false)
const rejectReason = ref('')
const editing = ref(false)
const draft = ref('')
const draftVersion = ref<string | null>(null)
const draftError = ref<string | null>(null)
const view = ref<ReviewView>('proposal')

function splitLines(text: string | null): readonly string[] {
  if (text === null || text === '') {
    return []
  }
  return text.replace(/\n$/, '').split('\n')
}

/**
 * 行级 diff（LCS 动态规划）。
 *
 * 记忆正文是几十行的短文本，`O(n × m)` 的表格足够，不需要 Myers 那套线性空间
 * 版本。平局时先输出删除：删改混合的行块里，先看到「原来是什么」再看到「变成
 * 什么」，比反过来好读。
 */
function diffLines(before: readonly string[], after: readonly string[]): readonly DiffRow[] {
  const width = after.length + 1
  const table: number[] = new Array<number>((before.length + 1) * width).fill(0)

  function at(row: number, column: number): number {
    return table[row * width + column] ?? 0
  }

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        before[row] === after[column]
          ? at(row + 1, column + 1) + 1
          : Math.max(at(row + 1, column), at(row, column + 1))
    }
  }

  const rows: DiffRow[] = []
  let left = 0
  let right = 0

  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      rows.push({ kind: 'context', leftNo: left + 1, rightNo: right + 1, text: before[left] ?? '' })
      left += 1
      right += 1
      continue
    }
    if (at(left + 1, right) >= at(left, right + 1)) {
      rows.push({ kind: 'remove', leftNo: left + 1, rightNo: null, text: before[left] ?? '' })
      left += 1
      continue
    }
    rows.push({ kind: 'add', leftNo: null, rightNo: right + 1, text: after[right] ?? '' })
    right += 1
  }

  while (left < before.length) {
    rows.push({ kind: 'remove', leftNo: left + 1, rightNo: null, text: before[left] ?? '' })
    left += 1
  }
  while (right < after.length) {
    rows.push({ kind: 'add', leftNo: null, rightNo: right + 1, text: after[right] ?? '' })
    right += 1
  }

  return rows
}

const narrative = computed(() =>
  props.memory === null
    ? { body: '', inferred: false, condition: null, citations: [] }
    : memoryReviewNarrativeOf(props.memory),
)

const pendingText = computed(() => narrative.value.body)
const storedText = computed(() =>
  props.memory === null ? '' : memoryReviewContentOf(props.memory),
)

// 更新比较完整的存储正文；不能把展示时拆出的证据误标成删除行。
const rows = computed<readonly DiffRow[]>(() =>
  diffLines(
    splitLines(props.baseline),
    splitLines(props.memory === null ? '' : memoryReviewContentOf(props.memory)),
  ),
)

const addedCount = computed(() => rows.value.filter((row) => row.kind === 'add').length)

const removedCount = computed(() => rows.value.filter((row) => row.kind === 'remove').length)

const hasDifference = computed(() => addedCount.value > 0 || removedCount.value > 0)

/**
 * 有效期一行，三个来源值都为 null 时整行不渲染。
 *
 * `validFrom` 与 `updatedAt` 相同表示这就是最近一次写入产生的版本，「自 X 起生效」
 * 不携带额外信息，省掉。
 */
const validityText = computed<string | null>(() => {
  const memory = props.memory
  if (memory === null) {
    return null
  }

  const parts: string[] = []
  if (memory.validFrom !== null && memory.validFrom !== memory.updatedAt) {
    parts.push(`自 ${formatMonthDayTime(memory.validFrom)} 起生效`)
  }
  if (memory.validUntil !== null) {
    parts.push(`有效期截止 ${formatMonthDayTime(memory.validUntil)}`)
  }
  return parts.length === 0 ? null : parts.join('，')
})

/** 这条记忆顶替了上一版本：通过就是替换，拒绝才是回退。 */
const replacesPrevious = computed(
  () => props.memory !== null && props.memory.supersedes !== null,
)

const showDiff = computed(
  () =>
    replacesPrevious.value &&
    props.baseline !== null &&
    !props.baselineLoading &&
    props.baselineError === null,
)

const showViewSwitch = computed(
  () =>
    replacesPrevious.value &&
    props.baseline !== null &&
    !props.baselineLoading &&
    props.baselineError === null,
)

const saveDisabled = computed(
  () => props.busy || (editing.value && !hasReviewContent(draft.value)),
)

const memoryTitle = computed(() =>
  props.memory === null ? '' : memoryReviewTitleOf(props.memory),
)

function resetDraft(): void {
  editing.value = false
  draft.value = storedText.value
  draftVersion.value = null
  draftError.value = null
  view.value = 'proposal'
}

function startEditing(): void {
  if (props.memory === null || props.busy) {
    return
  }
  draft.value = storedText.value
  draftVersion.value = props.memory.updatedAt
  draftError.value = null
  editing.value = true
  view.value = 'proposal'
}

function cancelEditing(): void {
  if (props.busy) {
    return
  }
  draft.value = storedText.value
  draftVersion.value = null
  draftError.value = null
  editing.value = false
  view.value = 'proposal'
}

function approve(): void {
  if (props.busy) {
    return
  }
  if (!editing.value) {
    emit('approve')
    return
  }
  if (!hasReviewContent(draft.value)) {
    draftError.value = '正文不能为空。'
    return
  }
  if (draftVersion.value === null) {
    return
  }
  draftError.value = null
  emit('approve', {
    content: draft.value,
    expectedUpdatedAt: draftVersion.value,
  })
}

watch(
  () => props.memory?.uri ?? null,
  () => resetDraft(),
  { immediate: true },
)

watch(
  () => props.memory?.updatedAt ?? null,
  () => {
    if (!editing.value) {
      resetDraft()
    }
  },
)

function openReject(): void {
  if (props.busy) {
    return
  }
  rejectReason.value = ''
  rejectOpen.value = true
}

function confirmReject(): void {
  if (props.busy) {
    return
  }
  const reason = rejectReason.value.trim()
  if (reason === '') {
    return
  }
  rejectOpen.value = false
  emit('reject', reason)
}
</script>

<template>
  <section class="split__main review-detail" :aria-busy="props.busy">
    <div v-if="props.memory === null" class="review-empty">
      <UiEmpty v-slot="{ size }" title="没有待复核的记忆" :size="22">
        <Check :size="size" :stroke-width="1.4" />
      </UiEmpty>
    </div>

    <template v-else>
      <div class="review-scroll">
        <div class="review-inner">
          <header class="detail-head">
            <div class="detail-meta">
              <UiBadge :variant="memoryTypeVariantOf(props.memory.memoryType)">
                {{ memoryTypeLabelOf(props.memory.memoryType) }}
              </UiBadge>
              <span>{{ replacesPrevious ? '更新' : narrative.inferred ? '推断' : '新增' }}</span>
              <span class="detail-meta__dot" aria-hidden="true">·</span>
              <time :datetime="props.memory.updatedAt" :title="props.memory.updatedAt">
                {{ formatRelativeTime(props.memory.updatedAt) }}
              </time>
              <template v-if="props.memory.sources.length > 0 && !narrative.inferred">
                <span class="detail-meta__dot" aria-hidden="true">·</span>
                <span>来源</span>
                <NuxtLink
                  v-for="source in props.memory.sources"
                  :key="source"
                  class="source-link"
                  :to="fileRouteOf(source)"
                  :title="source"
                >
                  {{ sourceContextLabelOf(source) }}
                </NuxtLink>
              </template>
            </div>
            <h1 class="detail-title">{{ memoryTitle }}</h1>
            <p v-if="validityText !== null" class="detail-validity">{{ validityText }}</p>
          </header>

          <UiCallout v-if="props.baselineError !== null" tone="warn">
            <div>上一版本没有读到：{{ props.baselineError }}</div>
          </UiCallout>

          <div v-if="narrative.inferred && narrative.condition !== null" class="inference-condition">
            <span class="inference-condition__label">适用条件</span>
            <span>{{ narrative.condition }}</span>
          </div>

          <section class="proposal" :aria-label="replacesPrevious ? '待生效改动' : '待生效记忆'">
            <div class="proposal__head">
              <span class="proposal__label">
                {{
                  editing
                    ? view === 'baseline'
                      ? '上一版本'
                      : '编辑正文'
                    : view === 'baseline'
                      ? '上一版本'
                      : showDiff && hasDifference
                        ? '版本差异'
                        : replacesPrevious
                          ? '新版本'
                          : '记忆内容'
                }}
              </span>
              <span class="spacer" />
              <div v-if="showViewSwitch" class="view-switch" role="group" aria-label="查看正文">
                <UiButton
                  variant="plain"
                  size="sm"
                  :aria-pressed="view === 'proposal'"
                  :disabled="props.busy"
                  @click="view = 'proposal'"
                >
                  {{ editing ? '草稿' : '新版本' }}
                </UiButton>
                <UiButton
                  variant="plain"
                  size="sm"
                  :aria-pressed="view === 'baseline'"
                  :disabled="props.busy"
                  @click="view = 'baseline'"
                >
                  上一版本
                </UiButton>
              </div>
              <span v-if="!editing && view === 'proposal' && showDiff" class="proposal__counts">
                <span class="proposal__add">+{{ addedCount }}</span>
                <span class="proposal__sep">/</span>
                <span class="proposal__del">−{{ removedCount }}</span>
              </span>
              <UiButton
                v-if="!editing"
                variant="plain"
                size="sm"
                :disabled="props.busy"
                @click="startEditing"
              >
                <Pencil :size="14" :stroke-width="1.6" />
                编辑
              </UiButton>
              <UiButton
                v-else
                variant="plain"
                size="sm"
                :disabled="props.busy"
                @click="cancelEditing"
              >
                取消编辑
              </UiButton>
            </div>

            <div
              v-if="replacesPrevious && props.baselineLoading"
              class="proposal__loading"
              aria-busy="true"
            >
              <UiSkeleton width="38%" height="12px" />
              <UiSkeleton width="92%" height="14px" />
              <UiSkeleton width="86%" height="14px" />
              <UiSkeleton width="64%" height="14px" />
            </div>

            <div v-else-if="view === 'baseline'" role="region" aria-label="上一版本正文">
              <pre
                v-if="props.baseline !== null && props.baseline.trim() !== ''"
                class="proposal__text"
              >{{ props.baseline }}</pre>
              <p v-else class="proposal__empty">正文为空</p>
            </div>

            <div v-else-if="editing" class="proposal__editor">
              <UiTextarea
                v-model="draft"
                aria-label="记忆正文"
                :rows="12"
                :disabled="props.busy"
                @update:model-value="draftError = null"
              />
              <p v-if="draftError !== null" class="proposal__error" role="alert">
                {{ draftError }}
              </p>
              <p v-else-if="!hasReviewContent(draft)" class="proposal__error" role="alert">
                正文不能为空。
              </p>
            </div>

            <div
              v-else-if="showDiff && hasDifference"
              class="inline-diff"
              role="region"
              aria-label="上一版本与待生效版本的差异"
            >
              <div
                v-for="(row, index) in rows"
                :key="`${index}-${row.kind}`"
                class="diff-line"
                :class="`is-${row.kind}`"
              >
                <span class="diff-line__mark" aria-hidden="true">
                  {{ row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ' }}
                </span>
                <span class="diff-line__text">{{ row.text || ' ' }}</span>
                <span class="diff-line__number" aria-hidden="true">
                  {{ row.kind === 'remove' ? row.leftNo : row.rightNo }}
                </span>
              </div>
            </div>

            <pre v-else-if="pendingText.trim() !== ''" class="proposal__text">{{ pendingText }}</pre>
            <p v-else class="proposal__empty">正文为空</p>
          </section>

          <section
            v-if="narrative.citations.length > 0"
            class="evidence"
            aria-labelledby="review-evidence-title"
          >
            <div class="evidence__head">
              <h2 id="review-evidence-title" class="evidence__title">引用</h2>
              <span class="evidence__count">{{ narrative.citations.length }}</span>
            </div>
            <div class="evidence__list">
              <blockquote
                v-for="citation in narrative.citations"
                :key="`${citation.uri}-${citation.quote}`"
                class="citation"
              >
                <p class="citation__quote">{{ citation.quote }}</p>
                <NuxtLink
                  class="citation__source"
                  :to="fileRouteOf(citation.uri)"
                  :title="citation.uri"
                >
                  <Link2 :size="13" :stroke-width="1.6" aria-hidden="true" />
                  {{ sourceContextLabelOf(citation.uri) }}
                </NuxtLink>
              </blockquote>
            </div>
          </section>
        </div>
      </div>

      <div class="review__foot">
        <span class="spacer" />
        <UiButton variant="secondary" :disabled="props.busy" @click="openReject">
          <Loader2
            v-if="props.actionBusy === 'reject'"
            :size="14"
            class="review__spin"
            aria-hidden="true"
          />
          {{ props.actionBusy === 'reject' ? '正在拒绝…' : '拒绝' }}
        </UiButton>
        <UiButton variant="primary" :disabled="saveDisabled" @click="approve">
          <Loader2
            v-if="props.actionBusy === 'approve'"
            :size="14"
            :stroke-width="1.6"
            class="review__spin"
            aria-hidden="true"
          />
          {{
            props.actionBusy === 'approve'
              ? editing
                ? '正在保存…'
                : '正在通过…'
              : editing
                ? '保存并通过'
                : replacesPrevious
                  ? '通过新版本'
                  : '通过并生效'
          }}
        </UiButton>
      </div>
    </template>

    <UiDialog
      v-model="rejectOpen"
      :title="replacesPrevious ? '拒绝这版改动' : '拒绝这条记忆'"
    >
      <div class="stack-16">
        <p class="body-sm muted">
          {{ replacesPrevious
            ? '拒绝后恢复上一版本；找不到上一版本时删除这条记忆。'
            : '拒绝后删除这条待复核记忆。' }}
        </p>
        <UiTextarea v-model="rejectReason" aria-label="拒绝原因" :rows="3" />
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" :disabled="props.busy" @click="rejectOpen = false">
            取消
          </UiButton>
          <UiButton
            variant="danger"
            :disabled="rejectReason.trim() === '' || props.busy"
            @click="confirmReject"
          >
            <X :size="14" :stroke-width="1.8" />
            确认拒绝
          </UiButton>
        </div>
      </div>
    </UiDialog>
  </section>
</template>

<style scoped>
.review-detail {
  overflow: hidden;
}

.review-empty {
  flex: 1;
  display: grid;
  align-content: center;
}

.review-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.review-inner {
  display: grid;
  gap: 24px;
  max-width: 980px;
  margin: 0 auto;
  padding: 34px 40px 48px;
}

.detail-head {
  display: grid;
  gap: 10px;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--label-3);
}

.detail-meta time {
  font-variant-numeric: tabular-nums;
}

.detail-meta__dot {
  color: var(--label-4);
}

.source-link {
  min-width: 0;
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--label-2);
  text-decoration-color: var(--separator-strong);
  text-underline-offset: 3px;
}

.source-link:hover {
  color: var(--accent-ink);
}

.source-link:focus-visible {
  outline: none;
  border-radius: 2px;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.detail-title {
  max-width: 30ch;
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.022em;
  color: var(--label);
  text-wrap: balance;
  overflow-wrap: anywhere;
}

.detail-validity {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.inference-condition {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 2px 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--label-2);
}

.inference-condition__label {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--label-3);
}

.proposal {
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.proposal__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 45px;
  padding: 8px 20px;
  border-bottom: 0.5px solid var(--separator);
}

.proposal__label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-2);
  text-transform: uppercase;
}

.proposal__counts {
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.proposal__add {
  color: var(--green-ink);
}

.proposal__sep {
  color: var(--label-4);
}

.proposal__del {
  color: var(--red-ink);
}

.view-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-control);
  background: var(--fill-2);
}

.view-switch .btn[aria-pressed='true'] {
  background: var(--surface);
  color: var(--label);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.proposal__text {
  max-width: 76ch;
  margin: 0;
  padding: 26px 28px 30px;
  overflow: visible;
  font-family: inherit;
  font-size: 16px;
  line-height: 1.75;
  color: var(--label);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.proposal__empty {
  margin: 0;
  padding: 28px;
  font-size: 14px;
  color: var(--label-3);
}

.proposal__editor {
  display: grid;
  gap: 10px;
  padding: 22px 28px 28px;
}

.proposal__editor :deep(textarea) {
  min-height: 280px;
  font-size: 15px;
  line-height: 1.7;
}

.proposal__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--red-ink);
}

.proposal__loading {
  display: grid;
  gap: 12px;
  padding: 26px 28px 32px;
}

.inline-diff {
  padding: 10px 0;
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.6;
}

.diff-line {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 44px;
  min-height: 23px;
}

.diff-line__mark,
.diff-line__number {
  padding-top: 2px;
  color: var(--label-4);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.diff-line__mark {
  text-align: center;
}

.diff-line__number {
  padding-right: 12px;
  text-align: right;
}

.diff-line__text {
  padding: 2px 12px;
  color: var(--label-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diff-line.is-remove {
  background: var(--red-tint);
}

.diff-line.is-remove .diff-line__mark,
.diff-line.is-remove .diff-line__text {
  color: var(--red-ink);
}

.diff-line.is-add {
  background: var(--green-tint);
}

.diff-line.is-add .diff-line__mark,
.diff-line.is-add .diff-line__text {
  color: var(--green-ink);
}

.diff-line.is-add .diff-line__text,
.diff-line.is-remove .diff-line__text {
  color: var(--label);
}

.evidence {
  display: grid;
  gap: 12px;
}

.evidence__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.evidence__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-2);
  text-transform: uppercase;
}

.evidence__count {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--label-3);
}

.evidence__list {
  display: grid;
  gap: 10px;
}

.citation {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 16px 18px;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--r-control) var(--r-control) 0;
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.citation__quote {
  margin: 0;
  font-size: 15px;
  line-height: 1.65;
  color: var(--label);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.citation__source {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  justify-self: start;
  font-size: 13px;
  color: var(--label-3);
  text-decoration: none;
}

.citation__source:hover {
  color: var(--accent-ink);
}

.citation__source:focus-visible {
  outline: none;
  border-radius: 2px;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.review__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  padding: 12px 32px;
  background: var(--material-thick);
  border-top: 0.5px solid var(--separator);
}

.review__spin {
  animation: review-spin 0.9s linear infinite;
}

@keyframes review-spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .review__spin {
    animation: none;
  }
}

@media (max-width: 900px) {
  .review-inner {
    padding: 24px 16px 32px;
  }

  .detail-title {
    font-size: 24px;
  }

  .proposal__text {
    padding: 22px 20px 26px;
  }

  .review__foot {
    padding: 12px 16px;
  }
}
</style>
