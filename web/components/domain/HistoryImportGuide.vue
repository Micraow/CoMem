<script setup lang="ts">
import { Copy } from 'lucide-vue-next'

import importPrompt from '~/assets/prompts/import-history.md?raw'
import { useToast } from '~/composables/useToast'
import { CLIPBOARD_DENIED_MESSAGE, copyToClipboard } from '~/utils/clipboard'

const toast = useToast()
const showPrompt = ref(false)

async function copyPrompt(): Promise<void> {
  const copied = await copyToClipboard(importPrompt)
  if (!copied) {
    showPrompt.value = true
  }
  toast.show(copied ? 'success' : 'error', copied ? '已复制导入提示词' : CLIPBOARD_DENIED_MESSAGE)
}
</script>

<template>
  <UiCard id="import-history" title="导入历史会话" panel>
    <div class="stack-12">
      <p class="body-sm">
        把提示词交给已接入 CoMem 的 Agent，告诉它要读取哪些导出文件，或直接给它一段聊天文本。可以先试一两段，看完预览再确认导入。
      </p>
      <div class="import-actions">
        <UiButton variant="primary" size="sm" @click="copyPrompt">
          <Copy :size="14" aria-hidden="true" />
          复制导入提示词
        </UiButton>
        <UiButton
          variant="plain"
          size="sm"
          :aria-expanded="showPrompt"
          aria-controls="history-import-prompt"
          @click="showPrompt = !showPrompt"
        >
          {{ showPrompt ? '收起提示词' : '查看提示词' }}
        </UiButton>
      </div>
      <div v-show="showPrompt" id="history-import-prompt">
        <DomainCodeBlock :code="importPrompt" label="导入提示词" copy-label="复制提示词原文" />
      </div>
      <p class="body-sm">
        对话会归档到 Agent 所连接的个人空间。到 <NuxtLink to="/sessions">会话与任务</NuxtLink>
        查看导入结果，到 <NuxtLink to="/review">记忆复核</NuxtLink> 处理提炼后需要确认的记忆。
      </p>
    </div>
  </UiCard>
</template>

<style scoped>
#import-history {
  scroll-margin-top: 24px;
}

.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
