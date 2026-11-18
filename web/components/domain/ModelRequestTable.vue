<script setup lang="ts">
/**
 * 模型调用明细（`GET /telemetry/llm-calls`）。
 *
 * 表格只展示服务端契约里的调用元数据。token 与成本为 `null` 时写「未报告」，
 * 不把缺测显示成 0；`sessionId` / `requestId` 只在后端确实关联到时出现。
 */
import { Bot, ChevronDown } from 'lucide-vue-next'

import type { LlmCallPayload } from '~/composables/useApi'
import { fileRouteOf } from '~/utils/fileRoute'
import { formatDateTimeWithSeconds, formatMilliseconds, formatMonthDayTime } from '~/utils/format'
import {
  LLM_CALL_STATUS_VARIANT,
  llmCallPurposeLabel,
  llmCallStatusLabel,
} from '~/utils/modelRequestLabels'

const props = defineProps<{
  readonly items: readonly LlmCallPayload[]
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: string | null
  readonly nextCursor: string | null
}>()

const emit = defineEmits<{ more: [] }>()

const NUMBER_FORMAT = new Intl.NumberFormat('en-US')
const COST_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
})

function tokenText(value: number | null): string {
  return value === null ? '未报告' : NUMBER_FORMAT.format(value)
}

function costText(value: number | null): string {
  return value === null ? '未计算' : `$${COST_FORMAT.format(value)}`
}

function associationOf(item: LlmCallPayload): string {
  const parts: string[] = []
  if (item.sessionId !== null) {
    parts.push(`会话 ${item.sessionId}`)
  }
  if (item.requestId !== null) {
    parts.push(`请求 ${item.requestId}`)
  }
  return parts.length === 0 ? '无关联' : parts.join(' · ')
}

function failureLabel(item: LlmCallPayload): string {
  if (item.errorReason === 'timeout') return item.purpose === 'recall_compression' ? '压缩超时' : '模型超时'
  if (item.errorReason === 'cancelled') return '请求已取消'
  if (item.errorReason === 'truncated') return '输出被截断'
  if (item.errorReason === 'invalid_output') return '输出格式不符'
  if (item.errorReason?.startsWith('upstream_http_')) return `供应商 HTTP ${item.errorReason.slice(14)}`
  return item.errorCode ?? ''
}
</script>

<template>
  <div class="requests">
    <UiErrorCallout
      v-if="props.error !== null && props.items.length === 0"
      :message="props.error"
    />

    <div v-else-if="props.loading && props.items.length === 0" class="requests__loading" aria-busy="true">
      <UiSkeleton width="34%" height="14px" />
      <UiSkeleton width="82%" height="12px" />
      <UiSkeleton width="74%" height="12px" />
      <UiSkeleton width="88%" height="12px" />
      <UiSkeleton width="66%" height="12px" />
    </div>

    <UiEmpty
      v-else-if="props.items.length === 0"
      v-slot="{ size }"
      title="还没有模型调用记录"
      text="接口正常返回，但当前账号还没有 CoMem 模型调用记录。"
    >
      <Bot :size="size" :stroke-width="1.4" />
    </UiEmpty>

    <UiTable v-else caption="CoMem 模型调用记录">
      <thead>
        <tr>
          <th scope="col">用途</th>
          <th scope="col">模型</th>
          <th scope="col">开始时间</th>
          <th scope="col" class="num">耗时</th>
          <th scope="col" class="num">输入 token</th>
          <th scope="col" class="num">输出 token</th>
          <th scope="col" class="num">成本</th>
          <th scope="col">状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in props.items" :key="item.id">
          <td data-label="用途">
            <span class="strong">{{ llmCallPurposeLabel(item.purpose) }}</span>
          </td>
          <td data-label="模型" class="model-cell mono" :title="item.model">{{ item.model }}</td>
          <td data-label="开始时间" class="time-detail">
            <time class="time-cell" :datetime="item.startedAt" :title="formatDateTimeWithSeconds(item.startedAt)">
              {{ formatMonthDayTime(item.startedAt) }}
            </time>
            <span class="association faint" :title="associationOf(item)">
              {{ associationOf(item) }}
            </span>
            <NuxtLink v-if="item.targetUri" :to="fileRouteOf(item.targetUri)" :title="item.targetUri">
              {{ item.targetUri.split('/').at(-1) }}
            </NuxtLink>
          </td>
          <td data-label="耗时" class="num mono">{{ formatMilliseconds(item.durationMs) }}</td>
          <td data-label="输入 token" class="num mono">{{ tokenText(item.promptTokens) }}</td>
          <td data-label="输出 token" class="num mono">{{ tokenText(item.completionTokens) }}</td>
          <td data-label="成本" class="num mono">{{ costText(item.costUsd) }}</td>
          <td
            data-label="状态"
            class="status-detail"
            :class="{ 'status-detail--error': item.errorCode !== null }"
          >
            <UiBadge :variant="LLM_CALL_STATUS_VARIANT[item.status]" size="sm">
              {{ llmCallStatusLabel(item.status) }}
            </UiBadge>
            <span v-if="item.errorCode !== null" class="status-note mono" :title="item.errorCode">
              {{ failureLabel(item) }}
            </span>
            <span v-if="item.attempts > 1" class="status-note">{{ item.attempts }} 次尝试</span>
          </td>
        </tr>
      </tbody>
    </UiTable>

    <div v-if="props.items.length > 0" class="requests__foot">
      <span class="requests__count">已加载 {{ props.items.length }} 条</span>
      <UiButton
        v-if="props.nextCursor !== null"
        variant="secondary"
        size="sm"
        :disabled="props.loadingMore"
        @click="emit('more')"
      >
        <ChevronDown :size="14" :stroke-width="1.5" />
        {{ props.loadingMore ? '加载中' : '加载更早记录' }}
      </UiButton>
    </div>

    <UiErrorCallout v-if="props.error !== null && props.items.length > 0" :message="props.error" />
  </div>
</template>

<style scoped>
.requests {
  display: grid;
}

.requests__loading {
  display: grid;
  gap: 13px;
  padding: 20px;
}

.model-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--label);
}

.time-cell,
.association {
  display: block;
}

.time-cell {
  color: var(--label-2);
  white-space: nowrap;
}

.association {
  max-width: 260px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.status-note {
  display: block;
  max-width: 180px;
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--red-ink);
}

.requests__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 10px 20px;
  border-top: 0.5px solid var(--separator);
  background: var(--surface-2);
}

.requests__count {
  font-size: 13px;
  color: var(--label-3);
}

@media (max-width: 720px) {
  .requests :deep(.table-wrap) {
    overflow: visible;
  }

  .requests :deep(.table),
  .requests :deep(.table tbody) {
    display: block;
  }

  .requests :deep(.table thead) {
    display: none;
  }

  .requests :deep(.table tbody tr) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 18px;
    padding: 13px 16px;
    border-bottom: 0.5px solid var(--separator);
  }

  .requests :deep(.table tbody tr:hover) {
    background: transparent;
  }

  .requests :deep(.table tbody td) {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    padding: 0;
    border: 0;
    text-align: right;
  }

  .requests :deep(.table tbody td::before) {
    content: attr(data-label);
    flex: none;
    font-size: 13px;
    color: var(--label-3);
  }

  .requests :deep(.table tbody .time-detail) {
    grid-column: 1 / -1;
    align-items: flex-start;
    text-align: left;
  }

  .requests :deep(.table tbody .time-detail .association) {
    max-width: 210px;
    text-align: right;
  }

  .requests :deep(.table tbody .model-cell) {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
    text-align: right;
  }

  .requests :deep(.table tbody td:last-child) {
    align-items: flex-start;
  }

  .requests :deep(.table tbody .status-detail--error) {
    grid-column: 1 / -1;
  }

  .status-note {
    min-width: 0;
    margin-top: 2px;
    text-align: right;
  }
}
</style>
