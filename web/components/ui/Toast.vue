<script setup lang="ts">
/**
 * 轻提示的渲染端（架构文档 §16.1 的浮层规范）。
 *
 * 右下角滑入，`role="status"` + `aria-live="polite"`：读屏器会在当前朗读结束后
 * 播报，不会打断正在输入的内容。每种语义带图标，颜色不是唯一表意手段。
 *
 * 动效只用位移与不透明度，`prefers-reduced-motion` 由 `main.css` 的全局规则
 * 统一压平，这里不重复写媒体查询。
 */
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-vue-next'

import { useToast, type ToastTone } from '~/composables/useToast'

const { toasts, dismiss } = useToast()

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
  warning: AlertTriangle,
} as const

const TONE_LABEL: Readonly<Record<ToastTone, string>> = {
  success: '成功',
  error: '错误',
  info: '提示',
  warning: '注意',
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="item in toasts" :key="item.id" class="toast" :data-tone="item.tone">
          <component :is="ICONS[item.tone]" :size="15" :stroke-width="1.6" aria-hidden="true" />
          <span class="toast__text">{{ item.message }}</span>
          <button
            type="button"
            class="toast__close"
            :aria-label="`关闭${TONE_LABEL[item.tone]}提示`"
            @click="dismiss(item.id)"
          >
            <X :size="13" :stroke-width="1.8" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 80;
  display: grid;
  gap: 10px;
  justify-items: end;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  min-height: 44px;
  padding: 10px 8px 10px 14px;
  border-radius: var(--r-card);
  background: var(--material-thick);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  box-shadow: var(--shadow-pop), var(--inset-hair);
  font-size: 14px;
  line-height: 1.45;
  color: var(--label);
}

.toast > svg {
  flex: none;
}

.toast[data-tone='success'] > svg {
  color: var(--green-ink);
}

.toast[data-tone='error'] > svg {
  color: var(--red-ink);
}

.toast[data-tone='warning'] > svg {
  color: var(--orange-ink);
}

.toast[data-tone='info'] > svg {
  color: var(--accent-ink);
}

.toast__text {
  flex: 1;
  min-width: 0;
}

.toast__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--label-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.toast__close:hover {
  background: var(--fill-hover);
  color: var(--label);
}

.toast__close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.toast-move {
  transition: transform var(--dur) var(--ease);
}
</style>
