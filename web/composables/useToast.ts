/**
 * 轻提示（Toast）的状态与生命周期。
 *
 * 提示是**一次性的操作回执**，不是通知中心：同时最多 3 条，3 秒后自动消失，
 * 新的挤掉最旧的。超出这个量的信息应该由页面本身承载（列表、状态标记），
 * 而不是堆在角上。
 *
 * 状态放在 `useState` 里跨组件共享：`Toast.vue` 负责渲染，页面只调用 `show`。
 * 定时器放在模块作用域：它只按 id 清理，和组件实例无关，组件卸载后迟到的
 * 回调也只是把一条已经不存在的提示再删一次。
 */

import type { Ref } from 'vue'

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  readonly id: number
  readonly tone: ToastTone
  readonly message: string
}

/** 同屏上限。3 条：再多就会遮住右下角的操作区。 */
const MAX_VISIBLE = 3

/** 自动消失时间。3 秒：读得完一句 20 字以内的提示，又不至于打断下一步操作。 */
const DURATION_MS = 3_000

let nextId = 0

const timers = new Map<number, ReturnType<typeof setTimeout>>()

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

export interface UseToast {
  readonly toasts: Ref<readonly ToastItem[]>
  /** 推一条提示，返回它的 id（取消时用）。 */
  show(tone: ToastTone, message: string): number
  dismiss(id: number): void
}

export function useToast(): UseToast {
  const toasts = useState<readonly ToastItem[]>('comem-toasts', () => [] as readonly ToastItem[])

  function dismiss(id: number): void {
    clearTimer(id)
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }

  function show(tone: ToastTone, message: string): number {
    nextId += 1
    const id = nextId
    const queue: ToastItem[] = [...toasts.value, { id, tone, message }]

    while (queue.length > MAX_VISIBLE) {
      const dropped = queue.shift()
      if (dropped !== undefined) {
        clearTimer(dropped.id)
      }
    }

    toasts.value = queue
    timers.set(
      id,
      setTimeout(() => {
        dismiss(id)
      }, DURATION_MS),
    )
    return id
  }

  return { toasts, show, dismiss }
}
