<script lang="ts">
/**
 * 待复核记忆的线上形状定义在 `web/composables/useApi.ts`（线上响应的单一出口）。
 *
 * 这里只做转出：差异视图（`MemoryDiff.vue`）从本组件导入这两个类型，保持那条
 * 导入不变，避免同一份响应形状出现第二份声明。
 */
import type { PendingListPayload, PendingMemoryPayload } from '~/composables/useApi'

export type { PendingListPayload, PendingMemoryPayload }
</script>

<script setup lang="ts">
/**
 * 待复核队列（记忆复核页的左侧）。
 *
 * 标题取记忆自己的身份字段，不把文件名或 URI 当内容。多选用原生 checkbox；
 * 批处理期间锁定队列操作，并在底部显示真实完成数。
 */
import { ClipboardCheck } from 'lucide-vue-next'

import { formatRelativeTime } from '~/utils/format'
import { memoryTypeLabelOf, memoryTypeVariantOf } from '~/utils/memoryTypeLabels'

import { memoryReviewNarrativeOf, memoryReviewTitleOf } from './memoryReview'

const props = defineProps<{
  memories: readonly PendingMemoryPayload[]
  loading: boolean
  error: string | null
  selectedUri: string | null
  operationBusy?: boolean
  batchProgress?: { readonly done: number; readonly total: number } | null
}>()

const operationBusy = computed(() => props.operationBusy === true)
const batchProgress = computed(() => props.batchProgress ?? null)

const checked = defineModel<readonly string[]>('checked', { required: true })

const emit = defineEmits<{
  select: [uri: string]
  refresh: []
  'batch-approve': []
  'batch-reject': []
}>()

const SKELETON_ROWS = 6

function isChecked(uri: string): boolean {
  return checked.value.includes(uri)
}

function toggle(uri: string): void {
  if (operationBusy.value) {
    return
  }
  checked.value = isChecked(uri)
    ? checked.value.filter((item) => item !== uri)
    : [...checked.value, uri]
}

const hasChecked = computed(() => checked.value.length > 0)
</script>

<template>
  <section
    class="split__aside review-queue"
    aria-label="待复核队列"
    :aria-busy="operationBusy"
  >
    <div class="aside-head">
      <span class="aside-head__title">待复核</span>
      <UiBadge :variant="props.memories.length > 0 ? 'orange' : 'gray'">
        {{ props.memories.length }}
      </UiBadge>
      <span class="spacer" />
      <slot name="actions" />
      <UiRefreshButton
        label="重新拉取待复核队列"
        :disabled="props.loading || operationBusy"
        @click="emit('refresh')"
      />
    </div>

    <div class="aside-scroll">
      <div v-if="props.loading && props.memories.length === 0" class="stack-8" aria-busy="true">
        <div v-for="index in SKELETON_ROWS" :key="index" class="rrow rrow--skeleton">
          <UiSkeleton :width="`${58 + (index % 4) * 8}%`" height="14px" />
          <UiSkeleton width="42%" height="12px" />
        </div>
      </div>

      <UiErrorRetry
        v-else-if="props.error !== null"
        :message="props.error"
        @retry="emit('refresh')"
      >
        <template #icon><ClipboardCheck :size="15" :stroke-width="1.4" /></template>
      </UiErrorRetry>

      <UiEmpty v-else-if="props.memories.length === 0" v-slot="{ size }" title="没有待复核的记忆">
        <ClipboardCheck :size="size" :stroke-width="1.4" />
      </UiEmpty>

      <ul v-else class="rrows">
        <li
          v-for="memory in props.memories"
          :key="memory.uri"
          class="rrow"
          :class="{ 'is-selected': memory.uri === props.selectedUri }"
        >
          <input
            type="checkbox"
            class="rrow__check"
            :checked="isChecked(memory.uri)"
            :disabled="operationBusy"
            :aria-label="`选择 ${memoryReviewTitleOf(memory)}`"
            @change="toggle(memory.uri)"
          >
          <button
            type="button"
            class="rrow__main"
            :title="memory.uri"
            :aria-current="memory.uri === props.selectedUri ? 'true' : undefined"
            :disabled="operationBusy"
            @click="emit('select', memory.uri)"
          >
            <span class="rrow__title">{{ memoryReviewTitleOf(memory) }}</span>
            <span class="rrow__meta">
              <UiBadge :variant="memoryTypeVariantOf(memory.memoryType)">
                {{ memoryTypeLabelOf(memory.memoryType) }}
              </UiBadge>
              <span>
                {{
                  memory.supersedes !== null
                    ? '更新'
                    : memoryReviewNarrativeOf(memory).inferred
                      ? '推断'
                      : '新增'
                }}
              </span>
              <span class="rrow__dot" aria-hidden="true">·</span>
              <time :datetime="memory.updatedAt" :title="memory.updatedAt">
                {{ formatRelativeTime(memory.updatedAt) }}
              </time>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <div v-if="hasChecked || batchProgress !== null" class="aside-foot">
      <div
        v-if="batchProgress !== null"
        class="batch-progress"
        role="status"
        aria-live="polite"
      >
        <UiProgress
          :value="batchProgress.done"
          :max="batchProgress.total"
          :label="`正在处理 ${batchProgress.done} / ${batchProgress.total}`"
        />
      </div>
      <div v-else class="rowflex">
        <UiButton
          variant="secondary"
          size="sm"
          :disabled="!hasChecked || operationBusy || props.loading"
          @click="emit('batch-reject')"
        >
          拒绝所选
        </UiButton>
        <span class="spacer" />
        <UiButton
          variant="primary"
          size="sm"
          :disabled="!hasChecked || operationBusy || props.loading"
          @click="emit('batch-approve')"
        >
          通过所选（{{ checked.length }}）
        </UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.review-queue {
  flex-basis: 348px;
  width: 348px;
  background:
    linear-gradient(180deg, var(--surface-2), transparent 180px),
    var(--bg-2);
}

.rrows {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rrow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 11px;
  border: 0.5px solid transparent;
  border-radius: var(--r-control);
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.rrow:hover {
  background: var(--fill-hover);
}

.rrow.is-selected {
  background: var(--surface);
  border-color: var(--accent-tint);
  box-shadow: var(--shadow-card), var(--inset-hair);
}

.rrow--skeleton {
  display: grid;
  gap: 9px;
  padding: 14px 12px;
}

.rrow__check {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.rrow__check:disabled {
  cursor: default;
}

.rrow__main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.rrow__main:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
  border-radius: var(--r-xs);
}

.rrow__title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 14px;
  line-height: 1.4;
  font-weight: 600;
  letter-spacing: -0.004em;
  color: var(--label);
}

.rrow__meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 12px;
  color: var(--label-3);
}

.rrow__meta time {
  font-variant-numeric: tabular-nums;
}

.rrow__dot {
  color: var(--label-4);
}

.aside-foot {
  flex: none;
  display: grid;
  gap: 10px;
  padding: 12px;
  border-top: 0.5px solid var(--separator);
  background: var(--material-thick);
}

.batch-progress {
  display: grid;
  gap: 8px;
}

@media (max-width: 900px) {
  .review-queue {
    width: auto;
    flex-basis: auto;
  }
}
</style>
