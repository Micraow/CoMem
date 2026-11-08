<script lang="ts">
/**
 * 提示词的线上形状（`GET /prompts` 与 `GET /prompts/:id`）。
 *
 * 类型放在组件里而不是公共客户端文件：`useApi.ts` 只声明跨页共用的形状，提示词
 * 只有这一页读。
 */
export interface PromptVariablePayload {
  readonly name: string
  readonly description: string
}

export interface PromptSummaryPayload {
  readonly id: string
  readonly description: string
  readonly variables: readonly PromptVariablePayload[]
  /** 是否被自定义过 */
  readonly overridden: boolean
  /** 自定义时基于的默认值已经不是仓库里的当前版本 */
  readonly stale: boolean
  readonly updatedAt: string | null
}

export interface PromptDetailPayload extends PromptSummaryPayload {
  /** 当前生效的正文 */
  readonly body: string
  /** 仓库里的默认正文，用于「恢复默认」之后对比 */
  readonly defaultBody: string
}
</script>

<script setup lang="ts">
/**
 * 提示词编辑器（架构文档 §9.2、§18）。
 *
 * 左边是骨架，右边是可编辑的正文。**模板变量以 `{{name}}` 的形式留在正文里**：
 * 编辑器不把变量展开成预览值，因为用户要改的正是「哪一截放在哪里」。
 *
 * ## 行号与换行
 *
 * 行号靠左侧一个 `pre` 栏（`aria-hidden`），滚动时同步 `scrollTop`。正文用
 * `white-space: pre`：中文段落一换行，行号就和逻辑行对不上，而保存失败的提示
 * 里给的是行号——对不上的行号比没有更糟。代价是长行要横向滚动。
 *
 * ## 为什么不在本地做校验
 *
 * 变量拼写、`{{` 未闭合、未知变量都由服务端在保存前校验（`domain/prompt.ts`），
 * 错误信息里带行号。本地再写一份必然与服务端漂移，而两份校验不一致时用户会
 * 看到「本地通过、保存失败」。
 */
import { RotateCcw, Save, Eye } from 'lucide-vue-next'

const props = defineProps<{
  detail: PromptDetailPayload | null
  loading: boolean
  error: string | null
  busy: boolean
  previewText: string | null
  previewLoading: boolean
}>()

const emit = defineEmits<{
  save: [body: string]
  reset: []
  preview: []
  'close-preview': []
}>()

const draft = ref('')
const gutter = ref<HTMLElement | null>(null)
const editor = ref<HTMLTextAreaElement | null>(null)

const previewOpen = computed({
  get: () => props.previewText !== null || props.previewLoading,
  set: (open: boolean) => {
    if (!open) {
      emit('close-preview')
    }
  },
})

const dirty = computed(() => props.detail !== null && draft.value !== props.detail.body)

/** 行号栏的文本：1 到当前行数。 */
const lineNumbers = computed(() => {
  const count = draft.value.split('\n').length
  return Array.from({ length: count }, (_, index) => String(index + 1)).join('\n')
})

watch(
  () => [props.detail?.id, props.detail?.body] as const,
  () => {
    draft.value = props.detail?.body ?? ''
  },
  { immediate: true },
)

/** 行号与正文同一个滚动位置；横向滚动只影响正文。 */
function syncScroll(event: Event): void {
  const source = event.target
  if (!(source instanceof HTMLTextAreaElement) || gutter.value === null) {
    return
  }
  gutter.value.scrollTop = source.scrollTop
}

/** 变量在模板里的写法。拼在脚本里而不是模板里：Vue 的插值语法本身就是 `{{ }}`，嵌套会解析失败。 */
function placeholderOf(name: string): string {
  return `{{${name}}}`
}

function save(): void {
  if (!dirty.value || props.busy) {
    return
  }
  emit('save', draft.value)
}
</script>

<template>
  <section class="split__main" aria-label="提示词编辑器">
    <div v-if="props.loading" class="doc-pane stack-12" aria-busy="true">
      <UiSkeleton width="38%" height="18px" />
      <UiSkeleton width="100%" height="320px" />
    </div>

    <div v-else-if="props.error !== null" class="doc-pane stack-12">
      <div class="callout callout--danger">
        <div>{{ props.error }}</div>
      </div>
    </div>

    <div v-else-if="props.detail === null" class="empty">
      <span class="empty__title">还没有自定义提示词</span>
      <span class="empty__text">从左侧选一条，修改之后保存；保存的内容会覆盖仓库里的默认值。</span>
    </div>

    <template v-else>
      <header class="editor-head">
        <div class="editor-head__main">
          <h2 class="headline">{{ props.detail.description }}</h2>
          <div class="editor-head__meta">
            <UiBadge :variant="props.detail.overridden ? 'blue' : 'gray'">
              {{ props.detail.overridden ? '已自定义' : '使用默认' }}
            </UiBadge>
            <UiBadge v-if="props.detail.stale" variant="orange">默认值已更新</UiBadge>
          </div>
        </div>
        <div class="rowflex">
          <UiButton
            variant="secondary"
            :disabled="!props.detail.overridden || props.busy"
            @click="emit('reset')"
          >
            <RotateCcw :size="14" :stroke-width="1.8" />
            恢复默认
          </UiButton>
          <UiButton variant="secondary" :disabled="props.busy || props.previewLoading" @click="emit('preview')">
            <Eye :size="14" :stroke-width="1.8" />
            预览
          </UiButton>
          <UiButton variant="primary" :disabled="!dirty || props.busy" @click="save">
            <Save :size="14" :stroke-width="1.8" />
            保存
          </UiButton>
        </div>
      </header>

      <div class="editor-vars">
        <span class="editor-vars__label">可用变量</span>
        <ul class="varlist">
          <li v-for="variable in props.detail.variables" :key="variable.name" class="varlist__item">
            <code class="mono">{{ placeholderOf(variable.name) }}</code>
            <span>{{ variable.description }}</span>
          </li>
        </ul>
      </div>

      <div class="editor-grid">
        <pre ref="gutter" class="editor-gutter mono" aria-hidden="true">{{ lineNumbers }}</pre>
        <textarea
          ref="editor"
          v-model="draft"
          class="editor-input mono"
          spellcheck="false"
          :aria-label="`编辑提示词：${props.detail.description}`"
          @scroll="syncScroll"
        />
      </div>

      <UiDialog v-model="previewOpen" title="渲染结果">
        <p v-if="props.previewLoading" class="body-sm muted">正在渲染…</p>
        <pre v-else class="preview mono">{{ props.previewText }}</pre>
      </UiDialog>
    </template>
  </section>
</template>

<style scoped>
.editor-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px 32px 14px;
  border-bottom: 0.5px solid var(--separator);
}

.editor-head__main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}

.editor-head__meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-vars {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 32px;
  border-bottom: 0.5px solid var(--separator);
  background: var(--bg-2);
}

.editor-vars__label {
  flex: none;
  font-size: 13px;
  color: var(--label-3);
}

.varlist {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.varlist__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  color: var(--label-3);
}

.varlist__item code {
  font-size: 12px;
  color: var(--label-2);
}

.editor-grid {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.editor-gutter,
.editor-input {
  margin: 0;
  padding: 14px 0;
  border: 0;
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
}

.editor-gutter {
  flex: none;
  width: 48px;
  overflow: hidden;
  padding-right: 12px;
  text-align: right;
  color: var(--label-4);
  user-select: none;
  border-right: 0.5px solid var(--separator);
}

.editor-input {
  flex: 1;
  min-width: 0;
  padding-left: 16px;
  padding-right: 16px;
  overflow: auto;
  background: transparent;
  color: var(--label);
  white-space: pre;
  resize: none;
  font-family: var(--mono);
}

.editor-input:focus {
  outline: none;
}

.preview {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  color: var(--label-2);
}
</style>
