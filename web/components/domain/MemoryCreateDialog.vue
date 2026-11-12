<script setup lang="ts">
/**
 * 新建记忆（概览空状态与文件树工具栏共用一份）。
 *
 * 只收三个输入：记忆类型、标题/主题、正文。**路径不由这里算**：提交后服务端按记忆
 * 类型的 `filename` 模板渲染路径，响应里带最终 URI；控制台只负责跳过去。所以这个
 * 组件里没有任何 `memories/...` 的字符串拼接，也没有按类型分支的字段名。
 *
 * 标题的作用随类型不同（`rules` 要「场景/规则」两段），这类规则同样在服务端。填错
 * 时 400 的原文挂在标题字段旁——服务端点名了缺什么，翻译成「标题不合规」只会让人再
 * 猜一次。判定依据是 `details.field`；没有这个字段的失败（网络、403）挂在对话框里。
 *
 * 同类型同标题再次提交是更新（服务端的字段级合并），响应里的 `created` 区分两种
 * 情况。`experiences` / `rules` 写入后是 `pending`，不进检索结果，提示语要说明它
 * 在复核队列里。
 */
import { Plus } from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { MEMORY_TYPES, memoryTypeLabelOf, type MemoryType } from '~/utils/memoryTypeLabels'
import type { NodeStatus } from '~/utils/nodeStatus'
import { isRecord } from '~/utils/record'

/** `POST /memories` 的响应（`src/api/http/routes/memories-create.ts`）。 */
interface CreateMemoryPayload {
  readonly uri: string
  readonly memoryType: string
  readonly created: boolean
  readonly status: NodeStatus | null
}

const model = defineModel<boolean>({ default: false })

const emit = defineEmits<{
  /** 创建成功；`uri` 是服务端算出的最终地址，父组件据此跳转。 */
  created: [uri: string]
}>()

const api = useApi()
const toast = useToast()
const scopeRoot = useScopeRoot()

/** 类型清单与中文名来自 `utils/memoryTypeLabels.ts`，这里不另写一份。 */
const typeOptions = MEMORY_TYPES.map((type) => ({ value: type, label: memoryTypeLabelOf(type) }))

const typeId = useId()
const titleId = useId()
const contentId = useId()

const memoryType = ref<MemoryType>('preferences')
const title = ref('')
const content = ref('')
const titleError = ref<string | null>(null)
const contentError = ref<string | null>(null)
const formError = ref<string | null>(null)
const saving = ref(false)

const canSubmit = computed(
  () => title.value.trim() !== '' && content.value.trim() !== '' && !saving.value,
)

function reset(): void {
  memoryType.value = 'preferences'
  title.value = ''
  content.value = ''
  titleError.value = null
  contentError.value = null
  formError.value = null
  saving.value = false
}

/** 改了标题或正文就清掉上一轮的错误：它描述的是旧输入。 */
watch([title, content], () => {
  titleError.value = null
  contentError.value = null
  formError.value = null
})

// 关闭后清空：下次打开是一个新表单，不留上一条的内容。
watch(model, (open) => {
  if (!open) {
    reset()
  }
})

function failureOf(caught: unknown): { readonly field: string | null; readonly message: string } {
  const message = errorMessageOf(caught)
  if (caught instanceof ApiClientError && isRecord(caught.details)) {
    const field = caught.details['field']
    if (typeof field === 'string') {
      return { field, message }
    }
  }
  return { field: null, message }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    return
  }

  saving.value = true
  try {
    const payload = await api.post<CreateMemoryPayload>('/memories', {
      scope: scopeRoot.value,
      memoryType: memoryType.value,
      title: title.value.trim(),
      content: content.value,
    })

    const pending = payload.status === 'pending'
    if (payload.created) {
      toast.show('success', pending ? '已新建记忆，等待复核' : '已新建记忆')
    } else {
      toast.show('success', pending ? '已更新同名记忆，等待复核' : '已更新同名记忆')
    }

    emit('created', payload.uri)
    model.value = false
  } catch (caught) {
    const failure = failureOf(caught)
    if (failure.field === 'title') {
      titleError.value = failure.message
    } else if (failure.field === 'content') {
      contentError.value = failure.message
    } else {
      formError.value = failure.message
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDialog v-model="model" title="新建记忆">
    <form class="stack-16" novalidate @submit.prevent="submit">
      <UiErrorCallout v-if="formError !== null" :message="formError" />

      <div class="field">
        <label class="field__label" :for="typeId">记忆类型</label>
        <UiSelect
          :id="typeId"
          v-model="memoryType"
          :options="typeOptions"
          aria-label="记忆类型"
          :disabled="saving"
        />
      </div>

      <div class="field">
        <label class="field__label" :for="titleId">标题/主题</label>
        <UiInput
          :id="titleId"
          v-model="title"
          placeholder="例如：代码风格"
          :disabled="saving"
          :aria-describedby="titleError === null ? undefined : `${titleId}-error`"
        />
        <span
          v-if="titleError !== null"
          :id="`${titleId}-error`"
          class="field__error"
          role="alert"
        >
          {{ titleError }}
        </span>
      </div>

      <div class="field">
        <label class="field__label" :for="contentId">内容</label>
        <UiTextarea
          :id="contentId"
          v-model="content"
          :rows="6"
          placeholder="写下要记住的内容"
          :disabled="saving"
          :aria-describedby="contentError === null ? undefined : `${contentId}-error`"
        />
        <span
          v-if="contentError !== null"
          :id="`${contentId}-error`"
          class="field__error"
          role="alert"
        >
          {{ contentError }}
        </span>
      </div>

      <div class="rowflex">
        <span class="spacer" />
        <UiButton variant="secondary" :disabled="saving" @click="model = false">取消</UiButton>
        <UiButton variant="primary" type="submit" :disabled="!canSubmit">
          <Plus :size="14" :stroke-width="1.8" />
          保存
        </UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.field {
  display: grid;
  gap: 6px;
}

.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-2);
}

.field__error {
  font-size: 13px;
  line-height: 1.45;
  color: var(--red-ink);
  word-break: break-word;
}
</style>
