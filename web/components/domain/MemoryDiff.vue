<script setup lang="ts">
/**
 * 记忆差异（记忆复核页的右侧）。
 *
 * 左右两栏：左「基线」是当前已落盘的正文，右「待生效」是复核记录里的正文。
 * 行级 diff 用 LCS 求最长公共子序列，新增行绿底、删除行红底——**这里用的是
 * diff 语义色**（与「不用红黄绿三点」无关，那条约束针对装饰性窗口控制点）。
 *
 * 两侧相同的情况确实会出现：服务端把 pending 版本直接写进了记忆文件，所以
 * 「基线」经常就是待生效版本本身。这种情况如实显示「两侧一致」，不编造差异。
 *
 * 拒绝必须填原因：服务端 `POST /memories/:uri/reject` 收 `reason` 且要求非空。
 * 服务端目前只把原因写进日志，不落盘——界面上如实说明，不假装它被保存了。
 */
import { Check, GitCompare, History, X } from 'lucide-vue-next'

import { formatMonthDayTime } from '~/utils/format'
import { memoryTypeLabelOf } from '~/utils/memoryTypeLabels'

import type { PendingMemoryPayload } from './ReviewList.vue'

const props = defineProps<{
  memory: PendingMemoryPayload | null
  /** 当前文件正文（已去掉存储层的 `## content` 标题）。 */
  baseline: string | null
  baselineLoading: boolean
  baselineError: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  approve: []
  reject: [reason: string]
}>()

type DiffKind = 'context' | 'add' | 'remove'

interface DiffRow {
  readonly kind: DiffKind
  readonly leftNo: number | null
  readonly rightNo: number | null
  readonly text: string
}

const rejectOpen = ref(false)
const rejectReason = ref('')

function contentOf(memory: PendingMemoryPayload): string {
  const value = memory.fields['content']
  return typeof value === 'string' ? value : ''
}

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

const pendingText = computed(() => (props.memory === null ? '' : contentOf(props.memory)))

const rows = computed<readonly DiffRow[]>(() =>
  diffLines(splitLines(props.baseline), splitLines(pendingText.value)),
)

const addedCount = computed(() => rows.value.filter((row) => row.kind === 'add').length)

const removedCount = computed(() => rows.value.filter((row) => row.kind === 'remove').length)

const hasDifference = computed(() => addedCount.value > 0 || removedCount.value > 0)

/**
 * 有效期一行，三个来源值都为 null 时整行不渲染。
 *
 * 有效期是「截止到哪一刻」，相对时间（「3 天后」）会随打开页面的时刻变化，复核者
 * 需要的是一个可以直接和记忆内容里的日期对比的值；服务端给的是 UTC 串，这里只做
 * 本地化，不改时刻。
 *
 * `validFrom` 与 `updatedAt` 相同表示这就是最近一次写入产生的版本，「自 X 起生效」
 * 不携带额外信息，省掉。两个时间串都由同一个序列化函数产出（ISO 8601 UTC 毫秒），
 * 同形态下直接比串即可。
 *
 * 放在详情头部而不是左侧队列行：队列行的 `rrow__meta` 已经有「相对更新时间 · 待复核」，
 * 再塞两个时间会变成三个时间挤在一行，读不出哪个是哪个。
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

function openReject(): void {
  rejectReason.value = ''
  rejectOpen.value = true
}

function confirmReject(): void {
  const reason = rejectReason.value.trim()
  if (reason === '') {
    return
  }
  rejectOpen.value = false
  emit('reject', reason)
}

function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}
</script>

<template>
  <section class="split__main" aria-live="polite">
    <div v-if="props.memory === null" class="empty">
      <span class="empty__icon">
        <Check :size="22" :stroke-width="1.4" />
      </span>
      <span class="empty__title">复核队列已清空</span>
    </div>

    <template v-else>
      <div class="doc-pane">
        <div class="doc-pane__inner stack-20">
          <header class="doc-head">
            <div class="doc-head__main">
              <h1 class="doc-title">{{ nameOf(props.memory.uri) }}</h1>
              <div class="uri">{{ props.memory.uri }}</div>
              <div v-if="validityText !== null" class="doc-meta">{{ validityText }}</div>
            </div>
            <div class="rowflex">
              <UiBadge variant="orange">待复核</UiBadge>
              <UiBadge variant="gray">{{ memoryTypeLabelOf(props.memory.memoryType) }}</UiBadge>
            </div>
          </header>

          <div v-if="replacesPrevious" class="callout callout--warn">
            <History :size="15" :stroke-width="1.4" />
            <div>通过后会替换掉上一版本，拒绝则恢复到覆盖前的值。</div>
          </div>

          <div v-if="props.baselineError !== null" class="callout callout--warn">
            <GitCompare :size="15" :stroke-width="1.4" />
            <div>
              读不到当前文件正文：{{ props.baselineError }}。下面只显示待生效内容。
            </div>
          </div>

          <section>
            <div class="sec-head">
              <span class="sec-label">基线 / 待生效</span>
              <span class="spacer" />
              <span class="diff-count mono">
                <span class="diff-count__add">+{{ addedCount }}</span>
                <span class="diff-count__sep">/</span>
                <span class="diff-count__del">−{{ removedCount }}</span>
              </span>
            </div>

            <div v-if="props.baselineLoading" class="skeleton-block" aria-busy="true">
              <UiSkeleton width="38%" height="12px" />
              <UiSkeleton width="92%" height="14px" />
              <UiSkeleton width="86%" height="14px" />
              <UiSkeleton width="64%" height="14px" />
            </div>

            <div v-else class="diff">
              <div class="diff__labels">
                <span />
                <span>基线 · 当前内容</span>
                <span />
                <span>待生效 · 复核内容</span>
              </div>

              <div v-if="rows.length === 0" class="diff__empty">
                两侧都没有正文。
              </div>

              <template v-else>
                <p v-if="!hasDifference" class="diff__same">
                  两侧内容一致。
                </p>

                <div class="dgrid">
                  <div
                    v-for="(row, index) in rows"
                    :key="`${index}-${row.kind}`"
                    class="drow"
                    :class="`is-${row.kind}`"
                  >
                    <span class="dn">{{ row.leftNo ?? '' }}</span>
                    <span class="dt">{{ row.kind === 'add' ? '' : row.text || ' ' }}</span>
                    <span class="dn">{{ row.rightNo ?? '' }}</span>
                    <span class="dt">{{ row.kind === 'remove' ? '' : row.text || ' ' }}</span>
                  </div>
                </div>
              </template>
            </div>
          </section>
        </div>
      </div>

      <div class="review__foot">
        <span class="caption">通过后进入检索；拒绝会回到上一次的值，没有可回退的版本时才删除。</span>
        <span class="spacer" />
        <UiButton variant="secondary" :disabled="props.busy" @click="openReject">拒绝</UiButton>
        <UiButton variant="primary" :disabled="props.busy" @click="emit('approve')">通过</UiButton>
      </div>
    </template>

    <UiDialog v-model="rejectOpen" title="拒绝这条记忆">
      <div class="stack-16">
        <p class="body-sm muted">
          拒绝会把这条记忆恢复到上一次被覆盖前的值，没有可回退的版本时才删除。原因会记入服务端日志，不会保存在记忆文件里。
        </p>
        <UiTextarea v-model="rejectReason" aria-label="拒绝原因" :rows="3" />
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="rejectOpen = false">取消</UiButton>
          <UiButton variant="danger" :disabled="rejectReason.trim() === ''" @click="confirmReject">
            <X :size="14" :stroke-width="1.8" />
            确认拒绝
          </UiButton>
        </div>
      </div>
    </UiDialog>
  </section>
</template>

<style scoped>
.doc-meta {
  font-size: 13px;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.sec-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-2);
  text-transform: uppercase;
}

.diff-count {
  font-size: 13px;
}

.diff-count__add {
  color: var(--green-ink);
}

.diff-count__sep {
  color: var(--label-4);
}

.diff-count__del {
  color: var(--red-ink);
}

.diff {
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.diff__labels {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px minmax(0, 1fr);
  border-bottom: 0.5px solid var(--separator);
  font-size: 13px;
  color: var(--label-3);
}

.diff__labels > span {
  padding: 9px 12px;
}

.diff__labels > span:nth-child(3) {
  border-left: 0.5px solid var(--separator);
}

.diff__same {
  margin: 0;
  padding: 14px 16px;
  font-size: 14px;
  color: var(--label-2);
  border-bottom: 0.5px solid var(--separator);
}

.diff__empty {
  padding: 36px 16px;
  text-align: center;
  font-size: 14px;
  color: var(--label-3);
}

.dgrid {
  max-height: 52vh;
  overflow: auto;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
}

.drow {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px minmax(0, 1fr);
}

.dn {
  padding: 1px 10px;
  text-align: right;
  color: var(--label-4);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.dt {
  padding: 1px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--label-2);
}

.drow > .dn:nth-child(3),
.drow > .dt:nth-child(4) {
  border-left: 0.5px solid var(--separator);
}

.drow.is-context .dt {
  color: var(--label-2);
}

.drow.is-remove > .dn:nth-child(1),
.drow.is-remove > .dt:nth-child(2) {
  background: var(--red-tint);
}

.drow.is-remove > .dt:nth-child(2) {
  color: var(--label);
}

.drow.is-add > .dn:nth-child(3),
.drow.is-add > .dt:nth-child(4) {
  background: var(--green-tint);
}

.drow.is-add > .dt:nth-child(4) {
  color: var(--label);
}

.review__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 32px;
  background: var(--material-thick);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  box-shadow: var(--shadow-sheet), var(--inset-top);
}

@media (max-width: 900px) {
  .review__foot {
    padding: 12px 16px;
  }
}
</style>
