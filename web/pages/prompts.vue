<script setup lang="ts">
/**
 * 提示词（架构文档 §9.2、§18）。
 *
 * 内置提示词的静态骨架在仓库的 `prompts/*.md` 里，这里改的是数据库覆盖：保存之后
 * 下一次模型调用就使用新正文，不需要重启，也不需要碰代码。恢复默认删掉覆盖行。
 *
 * ## 为什么分两组
 *
 * 「已自定义」与「使用默认」分开，一眼就能看出哪些提示词被改过、哪些还跟着仓库走。
 * 覆盖基于旧版本默认值时，「已自定义」的条目上会多一个「默认值已更新」标记——那
 * 是唯一能回答「我的修改是不是落后了」的证据。
 *
 * ## 未保存的修改不拦
 *
 * 切换提示词会丢掉草稿。加一个「确定放弃修改吗」的确认框需要额外的状态机，而这一
 * 页的草稿通常只有几十秒的工作量；保存失败的提示已经足够让用户知道没保存上。
 */
import { FileText } from 'lucide-vue-next'

import { errorMessageOf, forbiddenMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import type {
  PromptDetailPayload,
  PromptSummaryPayload,
} from '~/components/domain/PromptEditor.vue'

useHead({ title: '提示词 · CoMem 控制台' })

interface PromptListPayload {
  readonly prompts: readonly PromptSummaryPayload[]
}

interface PreviewPayload {
  readonly text: string
}

const api = useApi()
const toast = useToast()

const prompts = ref<readonly PromptSummaryPayload[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const selectedId = ref<string | null>(null)
const detail = ref<PromptDetailPayload | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)

const busy = ref(false)
const previewText = ref<string | null>(null)
const previewLoading = ref(false)

const overridden = computed(() => prompts.value.filter((prompt) => prompt.overridden))
const usingDefault = computed(() => prompts.value.filter((prompt) => !prompt.overridden))

/** 详情请求的序号：切换选中时丢弃迟到的响应，否则会显示上一条的正文。 */
let detailToken = 0

function pathOf(id: string, suffix = ''): string {
  return `/prompts/${encodeURIComponent(id)}${suffix}`
}

async function loadDetail(id: string | null): Promise<void> {
  detailToken += 1
  const token = detailToken
  detail.value = null
  detailError.value = null

  if (id === null) {
    detailLoading.value = false
    return
  }

  detailLoading.value = true
  try {
    const payload = await api.get<PromptDetailPayload>(pathOf(id))
    if (token === detailToken) {
      detail.value = payload
    }
  } catch (caught) {
    if (token === detailToken) {
      detailError.value = errorMessageOf(caught)
    }
  } finally {
    if (token === detailToken) {
      detailLoading.value = false
    }
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null

  try {
    const payload = await api.get<PromptListPayload>('/prompts')
    prompts.value = payload.prompts

    const present = new Set(payload.prompts.map((prompt) => prompt.id))
    const next =
      selectedId.value !== null && present.has(selectedId.value)
        ? selectedId.value
        : (payload.prompts[0]?.id ?? null)
    selectedId.value = next
    await loadDetail(next)
  } catch (caught) {
    error.value = errorMessageOf(caught)
    prompts.value = []
    selectedId.value = null
    detail.value = null
  } finally {
    loading.value = false
  }
}

/** 列表要跟着保存 / 重置变，但正文已经由响应带回来，不需要再取一次详情。 */
async function refreshList(): Promise<void> {
  const payload = await api.get<PromptListPayload>('/prompts')
  prompts.value = payload.prompts
}

function select(id: string): void {
  if (id === selectedId.value) {
    return
  }
  selectedId.value = id
  previewText.value = null
  void loadDetail(id)
}

/**
 * 改提示词只给系统管理员（`auth.adminUserIds`，普通用户 403）。403 的服务端原文
 * 里写着配置项名，进界面只会让用户去搜文档（§11）；这里与用户与组页一致，只说
 * 「需要管理员权限」。判定在 `forbiddenMessageOf` 里，与权限页、复核页同一份。
 * 其它失败仍显示服务端消息——那是排查用的诊断信息。
 */
async function save(body: string): Promise<void> {
  const id = selectedId.value
  if (id === null || busy.value) {
    return
  }

  busy.value = true
  try {
    detail.value = await api.put<PromptDetailPayload>(pathOf(id), { body })
    await refreshList()
    toast.show('success', '已保存')
  } catch (caught) {
    toast.show('error', forbiddenMessageOf(caught, '需要管理员权限'))
  } finally {
    busy.value = false
  }
}

async function reset(): Promise<void> {
  const id = selectedId.value
  if (id === null || busy.value) {
    return
  }

  busy.value = true
  try {
    detail.value = await api.del<PromptDetailPayload>(pathOf(id))
    await refreshList()
    toast.show('success', '已恢复默认')
  } catch (caught) {
    toast.show('error', forbiddenMessageOf(caught, '需要管理员权限'))
  } finally {
    busy.value = false
  }
}

async function preview(): Promise<void> {
  const id = selectedId.value
  if (id === null || previewLoading.value) {
    return
  }

  // 先打开对话框再取：慢请求期间界面要有反馈，否则点了「预览」像没反应。
  previewText.value = ''
  previewLoading.value = true
  try {
    const payload = await api.post<PreviewPayload>(pathOf(id, '/preview'))
    previewText.value = payload.text
  } catch (caught) {
    previewText.value = null
    toast.show('error', forbiddenMessageOf(caught, '需要管理员权限'))
  } finally {
    previewLoading.value = false
  }
}

function closePreview(): void {
  previewText.value = null
  previewLoading.value = false
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="content content--split">
    <div class="split">
      <section class="split__aside" aria-label="提示词列表">
        <div class="aside-head">
          <span class="aside-head__title">提示词</span>
          <UiBadge :variant="overridden.length > 0 ? 'blue' : 'gray'">
            {{ overridden.length }}
          </UiBadge>
          <span class="spacer" />
          <UiRefreshButton label="重新拉取提示词" :disabled="loading" @click="load" />
        </div>

        <div class="aside-scroll">
          <div v-if="loading && prompts.length === 0" class="aside-pad stack-8" aria-busy="true">
            <div v-for="index in 6" :key="index" class="srow srow--skeleton">
              <UiSkeleton :width="`${44 + (index % 4) * 12}%`" height="12px" />
              <UiSkeleton width="60%" height="11px" />
            </div>
          </div>

          <UiErrorRetry v-else-if="error !== null" :message="error" @retry="load">
            <template #icon><FileText :size="15" :stroke-width="1.4" /></template>
          </UiErrorRetry>

          <template v-else>
            <div class="group-label">已自定义</div>
            <p v-if="overridden.length === 0" class="group-empty">还没有自定义提示词</p>
            <ul v-else class="srows">
              <li v-for="prompt in overridden" :key="prompt.id">
                <button
                  type="button"
                  class="srow"
                  :class="{ 'is-selected': prompt.id === selectedId }"
                  :aria-current="prompt.id === selectedId ? 'true' : undefined"
                  @click="select(prompt.id)"
                >
                  <span class="srow__name">{{ prompt.description }}</span>
                  <span v-if="prompt.stale" class="srow__flag">默认值已更新</span>
                </button>
              </li>
            </ul>

            <div class="group-label">使用默认</div>
            <ul class="srows">
              <li v-for="prompt in usingDefault" :key="prompt.id">
                <button
                  type="button"
                  class="srow"
                  :class="{ 'is-selected': prompt.id === selectedId }"
                  :aria-current="prompt.id === selectedId ? 'true' : undefined"
                  @click="select(prompt.id)"
                >
                  <span class="srow__name">{{ prompt.description }}</span>
                </button>
              </li>
            </ul>
          </template>
        </div>
      </section>

      <DomainPromptEditor
        :detail="detail"
        :loading="detailLoading"
        :error="detailError"
        :busy="busy"
        :preview-text="previewText"
        :preview-loading="previewLoading"
        @save="save"
        @reset="reset"
        @preview="preview"
        @close-preview="closePreview"
      />
    </div>

    <UiToast />
  </div>
</template>

<style scoped>
.group-label {
  padding: 14px 12px 6px;
  font-size: 13px;
  font-weight: 590;
  color: var(--label-3);
}

.group-empty {
  margin: 0;
  padding: 4px 12px 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--label-3);
}

.srows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 4px;
  list-style: none;
}

.srow {
  width: 100%;
  display: grid;
  gap: 4px;
  padding: 9px 8px;
  border: 0;
  border-radius: var(--r-control);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}

.srow:hover {
  background: var(--fill-hover);
}

.srow.is-selected {
  background: var(--accent-tint-2);
}

.srow--skeleton {
  display: grid;
  gap: 7px;
  padding: 12px 10px;
  cursor: default;
}

.srow__name {
  font-size: 14px;
  font-weight: 590;
  color: var(--label);
}

.srow__flag {
  font-size: 13px;
  color: var(--orange-ink);
}
</style>
