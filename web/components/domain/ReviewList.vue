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
 * 每行三件事：名字（URI 末段）、类型、相对时间。URI 全量放在 `title` 里，
 * 列表宽度放不下完整 URI，但鼠标停一下要能看到。
 *
 * 多选用原生 checkbox + `accent-color`：自绘复选框要自己补「半选」态与键盘
 * 行为，收益为零。批量操作放在列表底部，勾选后才有意义。
 */
import { ClipboardCheck, RefreshCw } from 'lucide-vue-next'

const props = defineProps<{
  memories: readonly PendingMemoryPayload[]
  loading: boolean
  error: string | null
  selectedUri: string | null
}>()

const checked = defineModel<readonly string[]>('checked', { required: true })

const emit = defineEmits<{
  select: [uri: string]
  refresh: []
  'batch-approve': []
  'batch-reject': []
}>()

const SKELETON_ROWS = 6

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/** 来源是归档 URI：列表里只留末段目录名，完整 URI 放在 `title` 里。 */
function sourceNamesOf(sources: readonly string[]): string {
  return sources.map(nameOf).join('、')
}

function relativeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const elapsed = Date.now() - date.getTime()
  if (elapsed < MINUTE_MS) {
    return '刚刚'
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} 小时前`
  }
  if (elapsed < 7 * DAY_MS) {
    return `${Math.floor(elapsed / DAY_MS)} 天前`
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function typeVariantOf(memoryType: string): 'blue' | 'purple' | 'gray' {
  if (memoryType === 'experiences') {
    return 'blue'
  }
  if (memoryType === 'rules') {
    return 'purple'
  }
  return 'gray'
}

function isChecked(uri: string): boolean {
  return checked.value.includes(uri)
}

function toggle(uri: string): void {
  checked.value = isChecked(uri)
    ? checked.value.filter((item) => item !== uri)
    : [...checked.value, uri]
}

const hasChecked = computed(() => checked.value.length > 0)
</script>

<template>
  <section class="split__aside" aria-label="待复核队列">
    <div class="aside-head">
      <span class="aside-head__title">待复核</span>
      <UiBadge :variant="props.memories.length > 0 ? 'orange' : 'gray'">
        {{ props.memories.length }}
      </UiBadge>
      <span class="spacer" />
      <button
        type="button"
        class="iconbtn"
        aria-label="重新拉取待复核队列"
        :disabled="props.loading"
        @click="emit('refresh')"
      >
        <RefreshCw :size="15" :stroke-width="1.5" />
      </button>
    </div>

    <div class="aside-scroll">
      <div v-if="props.loading && props.memories.length === 0" class="stack-8" aria-busy="true">
        <div v-for="index in SKELETON_ROWS" :key="index" class="rrow rrow--skeleton">
          <UiSkeleton :width="`${46 + (index % 4) * 12}%`" height="12px" />
          <UiSkeleton width="58%" height="11px" />
        </div>
      </div>

      <div v-else-if="props.error !== null" class="aside-pad">
        <div class="callout callout--danger">
          <ClipboardCheck :size="15" :stroke-width="1.4" />
          <div>{{ props.error }}</div>
        </div>
        <UiButton variant="secondary" size="sm" @click="emit('refresh')">重试</UiButton>
      </div>

      <div v-else-if="props.memories.length === 0" class="empty">
        <span class="empty__icon">
          <ClipboardCheck :size="20" :stroke-width="1.4" />
        </span>
        <span class="empty__title">没有待复核的记忆</span>
      </div>

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
            :aria-label="`选择 ${nameOf(memory.uri)}`"
            @change="toggle(memory.uri)"
          >
          <button
            type="button"
            class="rrow__main"
            :title="memory.uri"
            :aria-current="memory.uri === props.selectedUri ? 'true' : undefined"
            @click="emit('select', memory.uri)"
          >
            <span class="rrow__top">
              <UiBadge :variant="typeVariantOf(memory.memoryType)">{{ memory.memoryType }}</UiBadge>
              <span class="rrow__name">{{ nameOf(memory.uri) }}</span>
            </span>
            <span
              v-if="memory.sources.length > 0"
              class="rrow__sources"
              :title="memory.sources.join('\n')"
            >
              来源 {{ sourceNamesOf(memory.sources) }}
            </span>
            <span class="rrow__meta">
              <span>{{ relativeTime(memory.updatedAt) }}</span>
              <span class="rrow__dot" aria-hidden="true">·</span>
              <span>待复核</span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <div class="aside-foot">
      <div class="rowflex">
        <UiButton variant="secondary" size="sm" :disabled="!hasChecked" @click="emit('batch-reject')">
          拒绝所选
        </UiButton>
        <span class="spacer" />
        <UiButton variant="primary" size="sm" :disabled="!hasChecked" @click="emit('batch-approve')">
          通过所选（{{ checked.length }}）
        </UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rrows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rrow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 8px;
  border-radius: var(--r-control);
  transition: background var(--dur-fast) var(--ease);
}

.rrow:hover {
  background: var(--fill-hover);
}

.rrow.is-selected {
  background: var(--accent-tint-2);
}

.rrow--skeleton {
  display: grid;
  gap: 7px;
  padding: 12px 10px;
}

.rrow__check {
  flex: none;
  width: 15px;
  height: 15px;
  margin: 3px 0 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.rrow__main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 5px;
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

.rrow__top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.rrow__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 590;
  color: var(--label);
}

.rrow__sources {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--label-3);
}

.rrow__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--label-3);
}

.rrow__dot {
  color: var(--label-4);
}

.aside-foot {
  flex: none;
  padding: 10px 12px 12px;
  border-top: 0.5px solid var(--separator);
}
</style>
