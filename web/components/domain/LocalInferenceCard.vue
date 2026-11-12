<script setup lang="ts">
/**
 * 设置页的「本地推理服务」卡片（架构文档 §18.2）。
 *
 * 只负责展示与发事件：取数、启动、停止、填入表单都在 `settings.vue`。状态里的
 * 维度 / 设备 / 模型来自服务端 `/health`，不是界面写死的值。
 */
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-vue-next'

import {
  LOCAL_INFERENCE_RESTART_NOTE,
  inferenceMissingLabels,
  inferenceShortStatusOf,
  inferenceStatusText,
  inferenceToneOf,
  type LocalInferenceFillKind,
  type LocalInferenceStatusPayload,
} from '~/utils/settings'

const props = defineProps<{
  readonly status: LocalInferenceStatusPayload | null
  readonly loading: boolean
  readonly action: 'idle' | 'starting' | 'stopping'
  readonly error: string | null
}>()

const emit = defineEmits<{
  refresh: []
  start: []
  stop: []
  fill: [kind: LocalInferenceFillKind]
}>()

const statusText = computed(() => {
  if (props.status === null) {
    return props.loading ? '读取中' : '状态未知'
  }
  return inferenceStatusText(props.status)
})

const tone = computed<'gray' | 'green' | 'orange'>(() =>
  props.status === null ? 'gray' : inferenceToneOf(props.status),
)

const shortStatus = computed(() => {
  if (props.status === null) {
    return props.loading ? '读取中' : '状态未知'
  }
  return inferenceShortStatusOf(props.status)
})

const missingLabels = computed(() =>
  props.status === null ? [] : inferenceMissingLabels(props.status.missing),
)

/** 只有重排模型缺失时仍可启动：说清楚这次启动会少什么。 */
const partialMissing = computed(
  () =>
    props.status !== null &&
    props.status.available &&
    props.status.missing.length > 0,
)

const busy = computed(() => props.action !== 'idle' || props.loading)

const startDisabled = computed(
  () =>
    props.status === null ||
    !props.status.available ||
    props.status.running ||
    busy.value,
)

const stopDisabled = computed(
  () => props.status === null || !props.status.running || busy.value,
)
</script>

<template>
  <UiCard title="本地推理服务" panel>
    <div class="local-inference">
      <div class="local-inference__state">
        <UiBadge :variant="tone">{{ shortStatus }}</UiBadge>
        <span class="local-inference__status">{{ statusText }}</span>
      </div>

      <div class="local-inference__endpoint-row">
        <span class="caption">地址</span>
        <code class="local-inference__endpoint">{{ status?.endpoint ?? '—' }}</code>
      </div>

      <p class="local-inference__lead">
        在本机运行向量与重排服务。启动并填入表单后，在下方保存更改。
      </p>

      <UiCallout v-if="status !== null && status.running" tone="info">
        <template #icon>
          <Info :size="15" :stroke-width="1.4" aria-hidden="true" />
        </template>
        <p class="local-inference__note">{{ LOCAL_INFERENCE_RESTART_NOTE }}</p>
      </UiCallout>

      <UiCallout v-if="partialMissing" tone="warn">
        <template #icon>
          <AlertTriangle :size="15" :stroke-width="1.4" aria-hidden="true" />
        </template>
        <p class="local-inference__lead">
          缺少{{ missingLabels.join('、') }}：启动后向量可用，重排不可用。
        </p>
      </UiCallout>

      <div v-if="status !== null && !status.available" class="local-inference__missing">
        <p class="local-inference__lead">本机缺少以下组件：</p>
        <div class="local-inference__badges">
          <UiBadge v-for="label in missingLabels" :key="label" variant="orange">
            {{ label }}
          </UiBadge>
        </div>
        <DomainCodeBlock
          v-if="status.startCommand !== null"
          :code="status.startCommand"
          label="安装并启动（在仓库根目录执行）"
          copy-label="复制安装并启动命令"
        />
      </div>

      <UiErrorCallout v-if="error !== null" :message="error" />

      <div class="local-inference__actions">
        <UiButton variant="primary" size="sm" :disabled="startDisabled" @click="emit('start')">
          <Loader2
            v-if="action === 'starting'"
            :size="14"
            :stroke-width="1.5"
            class="local-inference__spin"
            aria-hidden="true"
          />
          {{ action === 'starting' ? '启动中' : '启动' }}
        </UiButton>
        <UiButton variant="secondary" size="sm" :disabled="stopDisabled" @click="emit('stop')">
          {{ action === 'stopping' ? '停止中' : '停止' }}
        </UiButton>
        <UiButton
          variant="plain"
          size="sm"
          :disabled="busy"
          :aria-label="loading ? '正在刷新状态' : '刷新本地推理服务状态'"
          @click="emit('refresh')"
        >
          <RefreshCw :size="14" :stroke-width="1.5" aria-hidden="true" />
          {{ loading ? '刷新中' : '刷新状态' }}
        </UiButton>
      </div>

      <div class="local-inference__fill">
        <p class="local-inference__lead">把地址与模型名填进下面的表单；只填表单，不会自动保存。</p>
        <div class="local-inference__fill-actions">
          <UiButton variant="secondary" size="sm" @click="emit('fill', 'embedding')">
            填入向量配置
          </UiButton>
          <UiButton variant="secondary" size="sm" @click="emit('fill', 'rerank')">
            填入重排配置
          </UiButton>
        </div>
      </div>
    </div>
  </UiCard>
</template>

<style scoped>
.local-inference {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.local-inference__state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.local-inference__status {
  font-size: 14px;
  line-height: 1.5;
  color: var(--label-2);
  word-break: break-word;
}

.local-inference__endpoint-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.local-inference__endpoint {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.4;
  color: var(--label-2);
  word-break: break-all;
}

.local-inference__lead,
.local-inference__note {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--label-2);
}

.local-inference__note {
  color: var(--label-2);
}

.local-inference__missing {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
}

.local-inference__badges,
.local-inference__actions,
.local-inference__fill-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.local-inference__fill {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  box-shadow: 0 -0.5px 0 var(--hairline);
}

.local-inference__spin {
  animation: local-inference-spin 1s linear infinite;
}

@keyframes local-inference-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .local-inference__spin {
    animation: none;
  }
}
</style>
