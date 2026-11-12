<script lang="ts">
/**
 * 记忆健康度（架构文档 §17.5、§17.9 的 `/health`）。
 *
 * 四张指标卡 + 一条降级比例。四个数字分别回答「库有多大」「积压多少」「待复核多少」
 * 「摘要降级多少」，都是运维每周会看一眼的量。
 *
 * ## 待复核的数字从哪来
 *
 * 直接读 `GET /health` 的 `memory.pendingReview` 与 `memory.oldestPendingAgeSeconds`。
 * 不要改成从 `GET /memories/pending` 数条数或取第一条的 `updatedAt`：那个端点不
 * 排序、先截断 100 条，「第一条」不是「最老一条」，数量也只是下限。
 *
 * ## 降级比例的分母
 *
 * 分母是「降级目录 + 待刷新目录」，即**摘要工作有问题的目录**。服务端没有暴露
 * 目录总数，用索引节点数当分母会把文件算进去，比例会系统性偏低——那个数字看起来
 * 更像「一切正常」，比不显示更糟。
 */

/** 秒 → 人类可读的时长。只在本组件用，超过一天就回落到天。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes} 分钟`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`
  }
  return `${Math.floor(hours / 24)} 天`
}
</script>

<script setup lang="ts">
import type { HealthPayload } from '~/composables/useApi'
import { hasSummaryFailure, isRuleSummary } from '~/utils/healthLabels'

const props = defineProps<{
  health: HealthPayload | null
  loading: boolean
}>()

interface StatCard {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly sub: string | null
}

/**
 * 规则摘要不是故障。`summary.degraded` 是生成器选择，规则生成器产出的摘要恒带
 * `degraded`，所以这个模式下 `degradedDirs` 只能叫「规则摘要目录数」。
 */
const summary = computed(() => props.health?.summary ?? null)
const ruleSummary = computed(() => summary.value !== null && isRuleSummary({ summary: summary.value }))
const summaryFailed = computed(
  () => summary.value !== null && hasSummaryFailure({ summary: summary.value }),
)

const stats = computed<readonly StatCard[]>(() => {
  const health = props.health
  const memory = health?.memory ?? null
  return [
    {
      key: 'nodes',
      label: '索引节点数',
      value: health === null ? '—' : String(health.index.totalNodes),
      sub: health === null ? null : `服务版本 ${health.version}`,
    },
    {
      key: 'queue',
      label: '待处理任务',
      value: health === null ? '—' : String(health.queue.pending),
      sub: health === null ? null : `处理中 ${health.queue.processing}`,
    },
    {
      key: 'review',
      label: '待复核记忆',
      value: memory === null ? '—' : String(memory.pendingReview),
      sub:
        memory?.oldestPendingAgeSeconds == null
          ? null
          : `最老一条 ${formatDuration(memory.oldestPendingAgeSeconds)}前`,
    },
    {
      key: 'degraded',
      label: ruleSummary.value ? '规则摘要目录数' : '摘要降级目录数',
      value: health === null ? '—' : String(health.summary.degradedDirs),
      sub: health === null ? null : `待刷新 ${health.summary.pendingDirs}`,
    },
  ]
})

/** 摘要工作有问题的目录数：降级 + 待刷新。 */
const attentionDirs = computed(() => {
  const value = summary.value
  return value === null ? 0 : value.degradedDirs + value.pendingDirs
})

const degradedPercent = computed<number>(() =>
  attentionDirs.value === 0 ? 0 : Math.round(((summary.value?.degradedDirs ?? 0) / attentionDirs.value) * 100),
)
</script>

<template>
  <div class="health">
    <div class="stats">
      <div v-for="stat in stats" :key="stat.key" class="stat">
        <UiSkeleton v-if="props.loading && props.health === null" width="56px" height="26px" />
        <span v-else class="stat__v">{{ stat.value }}</span>
        <span class="stat__k">{{ stat.label }}</span>
        <span v-if="stat.sub !== null" class="stat__sub">{{ stat.sub }}</span>
      </div>
    </div>

    <div v-if="summary !== null" class="health__gauge">
      <template v-if="ruleSummary">
        <div class="health__state">
          <UiBadge variant="gray">规则摘要（正常）</UiBadge>
        </div>
        <p class="health__note">
          当前使用规则摘要，属于正常；配置模型后可恢复模型摘要。
          <template v-if="summary.degradedDirs > 0">
            已生成规则摘要的目录 {{ summary.degradedDirs }} 个。
          </template>
          <template v-if="summary.pendingDirs > 0">
            另有 {{ summary.pendingDirs }} 个目录待刷新。
          </template>
        </p>
      </template>
      <template v-else>
        <UiProgress
          v-if="summaryFailed"
          :value="summary.degradedDirs"
          :max="Math.max(attentionDirs, 1)"
          label="模型摘要失败后退回规则摘要的目录比例"
        />
        <p class="health__note">
          <template v-if="summaryFailed">
            {{ summary.degradedDirs }} 个目录的模型摘要失败，已退回规则摘要；
            {{ summary.pendingDirs }} 个目录待刷新，合计 {{ attentionDirs }} 个目录（{{ degradedPercent }}% 已降级）。
          </template>
          <template v-else-if="summary.pendingDirs > 0">
            没有失败的摘要；{{ summary.pendingDirs }} 个目录待刷新。
          </template>
          <template v-else>
            摘要生成正常：没有降级目录，也没有待刷新的目录。
          </template>
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.health {
  display: grid;
  gap: 18px;
}

.stat__sub {
  font-size: 13px;
  line-height: 1.35;
  color: var(--label-4);
  letter-spacing: 0;
}

.health__gauge {
  display: grid;
  gap: 10px;
  padding: 16px 18px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.health__state {
  display: flex;
  align-items: center;
  gap: 8px;
}

.health__note {
  font-size: 13px;
  line-height: 1.5;
  color: var(--label-3);
  max-width: 74ch;
}
</style>
