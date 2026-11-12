<script setup lang="ts">
/**
 * 对话框 / 抽屉（shadcn-vue 的 Dialog）。
 *
 * 遮罩、Esc 关闭、焦点移进面板并在面板内循环、关闭时把焦点还给触发元素。
 * 没换原生 `<dialog>`：`showModal()` 把面板放进 top layer，压过 `.toast-stack`
 * 的 `z-index: 80`，对话框里触发的 toast 会被遮住且点不到关闭。
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 打开前的焦点位置，关闭时还回去。 */
let restoreFocusTo: HTMLElement | null = null

function close(): void {
  model.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
    return
  }

  const el = panel.value
  if (event.key !== 'Tab' || el === null) {
    return
  }

  const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const first = items.at(0)
  const last = items.at(-1)
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }

  // 面板自己（刚打开时）与首元素之前都回绕到末尾，末尾之后回绕到首元素。
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === el)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(model, async (open) => {
  if (typeof document === 'undefined') {
    return
  }

  document.body.style.overflow = open ? 'hidden' : ''
  if (open) {
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    panel.value?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    if (restoreFocusTo?.isConnected === true) {
      restoreFocusTo.focus()
    }
    restoreFocusTo = null
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
