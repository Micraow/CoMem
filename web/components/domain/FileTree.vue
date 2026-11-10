<script setup lang="ts">
/**
 * 目录树（文件树页的左侧）。
 *
 * 点击行选中并同步 URL；点箭头只展开/收起，不改变选中——展开和选择是两个动作，
 * 合并成一个会让「只想看下一层」变成「跳走了」。
 *
 * **按需展开**：目录的子项在第一次展开时才拉（`GET /fs/ls`），所以首屏只有根的第
 * 一层。归档目录在第四层（`sessions/{id}/history/archive_001`），用固定深度 3 的
 * 一次性拉取永远看不到它；把深度调到 4 又会每次进页面都拉整棵树。
 *
 * 加载中用骨架屏，错误用服务端返回的中文句子（`ApiClientError.message`），
 * 空目录给空状态。
 */
import {
  AlertTriangle,
  ChevronRight,
  Circle,
  FileText,
  Folder,
  RefreshCw,
  Search,
} from 'lucide-vue-next'

import { formatBytes, useTree, type TreeNode } from '~/composables/useTree'
import { fsEntryDisplayName } from '~/utils/fsLabels'

const props = defineProps<{
  selected: string | null
}>()

const emit = defineEmits<{
  select: [uri: string]
}>()

const {
  state,
  loading,
  error,
  filter,
  rows,
  load,
  refresh,
  toggle,
  expandAncestors,
  isExpanded,
  isPending,
} = useTree()
const scopeRoot = useScopeRoot()

const SKELETON_ROWS = 8
const scrollArea = ref<HTMLElement | null>(null)

function isMetaFile(name: string): boolean {
  return name.startsWith('.')
}

function metaOf(node: TreeNode): string {
  return node.kind === 'directory' ? String(node.size) : formatBytes(node.size)
}

function activate(node: TreeNode): void {
  if (node.kind === 'directory') {
    void toggle(node.uri)
  }
  emit('select', node.uri)
}

async function revealSelection(uri: string | null): Promise<void> {
  if (uri === null) {
    return
  }
  await expandAncestors(uri)
  await nextTick()
  const candidates = scrollArea.value?.querySelectorAll<HTMLElement>('[data-uri]')
  for (const row of candidates ?? []) {
    if (row.dataset.uri === uri) {
      row.scrollIntoView({ block: 'nearest' })
      return
    }
  }
}

onMounted(() => {
  if (state.value === null && !loading.value) {
    void load()
  }
})

// 作用域切换后旧树整体失效：根变了，展开状态与筛选都没有意义。
watch(scopeRoot, () => {
  state.value = null
  filter.value = ''
  void load()
})

watch([() => props.selected, state], () => {
  void revealSelection(props.selected)
})
</script>

<template>
  <section class="split__aside" aria-label="命名空间目录树">
    <div class="aside-head">
      <span class="aside-head__title">命名空间</span>
      <span class="spacer" />
      <button
        type="button"
        class="iconbtn"
        aria-label="刷新目录树"
        :disabled="loading"
        @click="refresh"
      >
        <RefreshCw :size="15" :stroke-width="1.5" />
      </button>
    </div>

    <div class="aside-tools">
      <div class="searchfield">
        <Search :size="14" :stroke-width="1.5" aria-hidden="true" />
        <UiInput
          v-model="filter"
          type="search"
          placeholder="筛选路径"
          aria-label="筛选路径"
          variant="ghost"
        />
      </div>
    </div>

    <div ref="scrollArea" class="aside-scroll">
      <div v-if="loading && state === null" class="tree" aria-busy="true" aria-live="polite">
        <div v-for="index in SKELETON_ROWS" :key="index" class="tree-skeleton">
          <UiSkeleton :width="`${52 + (index % 4) * 11}%`" height="11px" />
        </div>
      </div>

      <div v-else-if="error !== null" class="aside-pad">
        <div class="callout callout--danger">
          <AlertTriangle :size="15" :stroke-width="1.4" />
          <div>{{ error }}</div>
        </div>
        <UiButton variant="secondary" size="sm" @click="refresh">重试</UiButton>
      </div>

      <div v-else-if="rows.length === 0" class="empty">
        <span class="empty__icon">
          <Folder :size="20" :stroke-width="1.4" />
        </span>
        <span class="empty__title">
          {{ filter.trim() === '' ? '这个命名空间还没有内容' : '已展开的路径里没有匹配项' }}
        </span>
      </div>

      <div v-else class="tree" role="tree" aria-label="命名空间目录树">
        <div
          v-for="node in rows"
          :key="node.uri"
          class="trow"
          :class="{
            'is-selected': node.uri === props.selected,
            'trow--muted': isMetaFile(node.name),
          }"
          :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
          role="treeitem"
          :aria-selected="node.uri === props.selected"
          :data-uri="node.uri"
          tabindex="0"
          :title="node.uri"
          @click="activate(node)"
          @keydown.enter.prevent="activate(node)"
          @keydown.space.prevent="activate(node)"
        >
          <button
            v-if="node.kind === 'directory'"
            type="button"
            class="trow__caret"
            :class="{ 'is-open': isExpanded(node.uri), 'is-pending': isPending(node.uri) }"
            :aria-label="isExpanded(node.uri) ? '收起目录' : '展开目录'"
            :aria-busy="isPending(node.uri)"
            @click.stop="void toggle(node.uri)"
          >
            <ChevronRight :size="13" :stroke-width="1.7" />
          </button>
          <span v-else class="trow__caret is-blank">
            <ChevronRight :size="13" :stroke-width="1.7" />
          </span>

          <span class="trow__icon">
            <Folder v-if="node.kind === 'directory'" :size="15" :stroke-width="1.4" />
            <Circle v-else-if="isMetaFile(node.name)" :size="13" :stroke-width="1.4" />
            <FileText v-else :size="15" :stroke-width="1.4" />
          </span>

          <span class="trow__name" :class="{ 'is-dir': node.kind === 'directory' }">
            {{ fsEntryDisplayName(node.kind, node.name) }}
          </span>

          <span class="trow__meta">{{ metaOf(node) }}</span>
        </div>
      </div>
    </div>

    <div class="tree-legend">
      <span><Folder :size="13" :stroke-width="1.4" aria-hidden="true" />目录</span>
      <span><FileText :size="13" :stroke-width="1.4" aria-hidden="true" />文档</span>
      <span><Circle :size="9" :stroke-width="1.4" aria-hidden="true" />元数据</span>
    </div>
  </section>
</template>
