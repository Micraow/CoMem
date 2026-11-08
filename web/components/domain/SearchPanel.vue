<script setup lang="ts">
/**
 * 检索条件面板（检索调试页的顶部）。
 *
 * 输入时自动检索（防抖 300ms），按钮点击立即检索：两种入口共用一个 `submit`
 * 事件，页面只实现一次「发请求 + 同步 URL」。
 *
 * 防抖 300ms 的来源：用户在中文输入法里逐字输入时，每个字都会触发 `input`；
 * 300ms 是「停手了」与「还没想好」之间的经验值，短于此会打出一串必然作废的
 * 检索，长于此会让人觉得输入没反应。
 *
 * `find` / `search` 的差别靠选项标签表达（「带查询计划」），不写说明段落。
 */
import type { SearchContextType, SearchMode, SearchLevel } from './HitList.vue'

const query = defineModel<string>('query', { required: true })
const mode = defineModel<SearchMode>('mode', { required: true })
const scope = defineModel<string>('scope', { required: true })
const limit = defineModel<string>('limit', { required: true })
const level = defineModel<SearchLevel | ''>('level', { required: true })
const contextType = defineModel<SearchContextType | ''>('contextType', { required: true })

const props = defineProps<{ loading: boolean }>()

const emit = defineEmits<{ submit: [] }>()

const DEBOUNCE_MS = 300

const MODE_OPTIONS = [
  { value: 'find', label: 'find · 语义检索' },
  { value: 'search', label: 'search · 带查询计划' },
] as const

const LIMIT_OPTIONS = [
  { value: '5', label: '5 条' },
  { value: '10', label: '10 条' },
  { value: '20', label: '20 条' },
  { value: '50', label: '50 条' },
  { value: '100', label: '100 条' },
] as const

const LEVEL_OPTIONS = [
  { value: '', label: '全部层级' },
  { value: 'L0', label: 'L0 · 摘要' },
  { value: 'L1', label: 'L1 · 概览' },
  { value: 'L2', label: 'L2 · 原文' },
] as const

const CONTEXT_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'memory', label: '记忆' },
  { value: 'resource', label: '资源' },
  { value: 'skill', label: '技能' },
  { value: 'session', label: '会话' },
] as const

const canSubmit = computed(() => query.value.trim() !== '' && !props.loading)

let timer: ReturnType<typeof setTimeout> | undefined

function submitNow(): void {
  clearTimeout(timer)
  if (!canSubmit.value) {
    return
  }
  emit('submit')
}

function schedule(): void {
  clearTimeout(timer)
  if (query.value.trim() === '') {
    return
  }
  timer = setTimeout(() => {
    emit('submit')
  }, DEBOUNCE_MS)
}

watch([query, mode, scope, limit, level, contextType], schedule)

/** 键盘提交：⌘/Ctrl + Enter。多行输入里单独的 Enter 是换行。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    submitNow()
  }
}

onBeforeUnmount(() => {
  clearTimeout(timer)
})
</script>

<template>
  <form class="panel" @submit.prevent="submitNow" @keydown="onKeydown">
    <div class="panel__query">
      <UiTextarea
        v-model="query"
        aria-label="检索词"
        :rows="3"
        :disabled="props.loading"
      />
      <UiButton type="submit" variant="primary" :disabled="!canSubmit">
        {{ props.loading ? '检索中' : '检索' }}
      </UiButton>
    </div>

    <div class="panel__controls">
      <label class="field">
        <span class="field__label">模式</span>
        <UiSelect v-model="mode" :options="MODE_OPTIONS" aria-label="检索模式" />
      </label>

      <label class="field field--grow">
        <span class="field__label">范围</span>
        <UiInput
          v-model="scope"
          placeholder="留空使用当前命名空间"
          aria-label="检索范围"
          size="sm"
        />
      </label>

      <label class="field">
        <span class="field__label">条数</span>
        <UiSelect v-model="limit" :options="LIMIT_OPTIONS" aria-label="返回条数" />
      </label>

      <label class="field">
        <span class="field__label">层级</span>
        <UiSelect v-model="level" :options="LEVEL_OPTIONS" aria-label="层级筛选" />
      </label>

      <label class="field">
        <span class="field__label">类型</span>
        <UiSelect v-model="contextType" :options="CONTEXT_OPTIONS" aria-label="类型筛选" />
      </label>
    </div>
  </form>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.panel__query {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.panel__query > :first-child {
  flex: 1;
  min-width: 0;
}

.panel__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.field--grow {
  flex: 1;
  min-width: 240px;
}

.field__label {
  padding-left: 2px;
  font-size: 13px;
  color: var(--label-3);
}
</style>
