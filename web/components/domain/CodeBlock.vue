<script setup lang="ts">
/**
 * 代码片段 + 复制按钮（接入引导页的三处片段共用）。
 *
 * 复制按钮是图标按钮，**必须带 `aria-label`**：图标本身不表意，读屏软件只念得出
 * 「按钮」。复制成功用 toast 回执，按钮短暂显示对勾——只看 toast 的话，用户移开
 * 目光再回来就不知道刚才复制的是哪一段。
 */
import { Check, Copy } from 'lucide-vue-next'

import { useToast } from '~/composables/useToast'

const props = defineProps<{
  /** 原文，按原样渲染，不做换行 / 缩进重排。 */
  readonly code: string
  /** 片段标题，例如「MCP 配置（JSON）」。 */
  readonly label: string
  /** 复制按钮的无障碍名称，例如「复制 MCP 配置」。 */
  readonly copyLabel: string
}>()

const toast = useToast()

const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
    toast.show('success', '已复制')
    copied.value = true
    if (resetTimer !== null) {
      clearTimeout(resetTimer)
    }
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 1_500)
  } catch {
    toast.show('error', '浏览器拒绝写入剪贴板，请手动选择复制。')
  }
}

onBeforeUnmount(() => {
  if (resetTimer !== null) {
    clearTimeout(resetTimer)
  }
})
</script>

<template>
  <div class="codeblock">
    <div class="codeblock__head">
      <span class="codeblock__label">{{ label }}</span>
      <span class="spacer" />
      <button type="button" class="iconbtn" :aria-label="copyLabel" @click="copy">
        <Check v-if="copied" :size="15" :stroke-width="1.6" aria-hidden="true" />
        <Copy v-else :size="15" :stroke-width="1.4" aria-hidden="true" />
      </button>
    </div>
    <pre class="doc-raw codeblock__body"><code>{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.codeblock {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.codeblock__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.codeblock__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--label-3);
  text-transform: uppercase;
}

.codeblock__body {
  margin: 0;
  max-height: 320px;
  overflow: auto;
}

.codeblock__body code {
  display: block;
}
</style>
