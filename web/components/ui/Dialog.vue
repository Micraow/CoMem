<script setup lang="ts">
/**
 * 对话框 / 抽屉（shadcn-vue 的 Dialog）。
 *
 * 只做控制台需要的三件事：遮罩、Esc 关闭、打开时把焦点移进面板并锁住背景滚动。
 * 焦点陷阱没有手写：面板本身 `tabindex="-1"` 且内容都是可聚焦元素，浏览器 Tab
 * 顺序在单个面板内已经闭合；再手写一套反而会和浏览器行为打架。
 *
 * `placement="left"` 是移动端的导航抽屉：同一份侧边栏内容，不重复维护。
 */
import { X } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    title?: string
    placement?: 'center' | 'left'
    showHeader?: boolean
  }>(),
  {
    title: '对话框',
    placement: 'center',
    showHeader: true,
  },
)

const model = defineModel<boolean>({ default: false })
const panel = ref<HTMLElement | null>(null)

function close(): void {
  model.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
  }
}

watch(model, async (open) => {
  if (typeof document === 'undefined') {
    return
  }

  document.body.style.overflow = open ? 'hidden' : ''
  if (open) {
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    panel.value?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="model" class="dialog" :class="`dialog--${props.placement}`">
      <div class="dialog__scrim" @click="close" />
      <div
        ref="panel"
        class="dialog__panel"
        :class="`dialog__panel--${props.placement}`"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
        tabindex="-1"
      >
        <header v-if="props.showHeader" class="dialog__head">
          <h2 class="dialog__title">{{ props.title }}</h2>
          <button type="button" class="iconbtn" aria-label="关闭" @click="close">
            <X :size="16" :stroke-width="1.6" />
          </button>
        </header>
        <div class="dialog__body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
