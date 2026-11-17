<script setup lang="ts">
/**
 * Hermes 捕获状态。
 *
 * 判定只使用现有 `GET /sessions` 的真实数据：Hermes 会话 ID 且已有提交时间。
 * 这只能证明消息已写入并完成归档，不能证明召回内容被模型采用。
 */
import { Inbox } from 'lucide-vue-next'

import type { SessionSummaryPayload } from '~/components/domain/SessionList.vue'
import { deriveVerification, type VerificationTone } from '~/utils/connectGuide'
import { fileRouteOf } from '~/utils/fileRoute'
import { formatDateTimeWithSeconds } from '~/utils/format'
import { completedHermesSessions } from '~/utils/monitorLive'

const props = defineProps<{
  readonly sessions: readonly SessionSummaryPayload[] | null
  readonly loading: boolean
  readonly error: string | null
  readonly currentSubject: string | null
}>()

const TONE_LABEL = {
  ok: '已归档',
  warn: '尚未收到',
  fail: '检查失败',
  idle: '等待检查',
} satisfies Record<VerificationTone, string>

const TONE_VARIANT = {
  ok: 'green',
  warn: 'orange',
  fail: 'red',
  idle: 'gray',
} as const satisfies Record<VerificationTone, 'green' | 'orange' | 'red' | 'gray'>

const hermesSessions = computed(() => completedHermesSessions(props.sessions))

const check = computed(() => {
  if (props.loading && props.sessions === null) {
    return {
      tone: 'idle' as const,
      detail: '正在检查最近的 Hermes 会话。',
    }
  }
  const result = deriveVerification({
    health: null,
    healthError: null,
    sessions: hermesSessions.value,
    sessionsError: props.error,
    currentSubject: props.currentSubject,
  })
  return result.checks.find((candidate) => candidate.key === 'sessions') ?? {
    tone: 'fail' as const,
    detail: '没有取到 Hermes 会话状态。',
  }
})

const archivedSessions = computed(() =>
  [...(hermesSessions.value ?? [])].sort(
      (left, right) =>
        Date.parse(right.lastCommitAt ?? '') - Date.parse(left.lastCommitAt ?? ''),
    ),
)
const latestArchived = computed(() => archivedSessions.value[0] ?? null)

const detail = computed(() =>
  check.value.tone === 'warn' && hermesSessions.value !== null
    ? '当前账号个人空间还没有已归档的 Hermes 会话。'
    : check.value.tone === 'ok'
      ? `当前账号个人空间有 ${String(archivedSessions.value.length)} 个已归档的 Hermes 会话。`
    : check.value.detail,
)
</script>

<template>
  <section class="capture" aria-labelledby="hermes-capture-title">
    <span class="capture__icon" aria-hidden="true">
      <Inbox :size="20" :stroke-width="1.4" />
    </span>
    <div class="capture__body">
      <div class="capture__head">
        <h3 id="hermes-capture-title" class="capture__title">Hermes 捕获</h3>
        <UiBadge :variant="TONE_VARIANT[check.tone]" size="sm">{{ TONE_LABEL[check.tone] }}</UiBadge>
        <span class="capture__account">
          当前网页登录
          <span class="mono">{{ props.currentSubject ?? '未识别' }}</span>
        </span>
      </div>
      <p class="capture__detail">{{ detail }}</p>
      <p v-if="latestArchived !== null" class="capture__latest">
        <span>
          最近归档
          <time :datetime="latestArchived.lastCommitAt ?? undefined">
            {{ formatDateTimeWithSeconds(latestArchived.lastCommitAt ?? '') }}
          </time>
        </span>
        <NuxtLink :to="fileRouteOf(latestArchived.uri)">打开会话</NuxtLink>
      </p>
    </div>
    <NuxtLink to="/connect?host=hermes" class="capture__link">检查接入</NuxtLink>
  </section>
</template>

<style scoped>
.capture {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 16px 18px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.capture__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 12px;
  background: var(--accent-tint);
  color: var(--accent-ink);
}

.capture__body {
  flex: 1;
  min-width: 0;
}

.capture__head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.capture__account {
  font-size: 13px;
  color: var(--label-3);
}

.capture__title {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
}

.capture__detail {
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--label-3);
}

.capture__latest {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 13px;
  color: var(--label-3);
}

.capture__latest a {
  font-weight: 500;
}

.capture__link {
  flex: none;
  font-size: 13px;
  font-weight: 500;
}
</style>
