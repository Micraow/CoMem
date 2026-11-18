<script lang="ts">
import type {
  SearchHitPayload,
} from './HitList.vue'

export type WorkspaceSearchScope = 'folder' | 'space' | 'all'
</script>

<script setup lang="ts">
import {
  AlertTriangle,
  ChevronLeft,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Plus,
  Search,
  SearchX,
  X,
} from 'lucide-vue-next'

import type { TreeEntryPayload } from '~/composables/useApi'
import type { WorkspaceCrumb } from '~/utils/workspacePath'
import { formatBytes } from '~/utils/format'
import { fsEntryDisplayName } from '~/utils/fsLabels'

const query = defineModel<string>('query', { required: true })
const searchScope = defineModel<WorkspaceSearchScope>('searchScope', { required: true })

const props = defineProps<{
  entries: readonly TreeEntryPayload[] | null
  crumbs: readonly WorkspaceCrumb[]
  currentTitle: string
  selectedUri: string | null
  loading: boolean
  error: string | null
  canGoUp: boolean
  searching: boolean
  searchHits: readonly SearchHitPayload[] | null
  searchError: string | null
  canCreate?: boolean | null
  canCreateMemory: boolean
}>()

const emit = defineEmits<{
  open: [uri: string]
  up: []
  refresh: []
  'retry-search': []
  create: [kind: 'directory' | 'file']
  'create-memory': []
}>()

const SEARCH_SCOPE_OPTIONS = [
  { value: 'folder', label: '当前文件夹' },
  { value: 'space', label: '当前空间' },
  { value: 'all', label: '所有可访问内容' },
] as const

const sortedEntries = computed<readonly TreeEntryPayload[]>(() => {
  const rows = (props.entries ?? []).filter((entry) => !entry.name.startsWith('.'))
  rows.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
  })
  return rows
})

const searchingActive = computed(() => query.value.trim() !== '')

function hitTitle(hit: SearchHitPayload): string {
  const abstract = hit.abstract?.trim() ?? ''
  if (hit.level === 'L2' && abstract !== '') {
    return abstract
  }
  const segment = hit.uri.replace(/\/+$/u, '').split('/').at(-1) ?? hit.uri
  try {
    return `${decodeURIComponent(segment)}${hit.level === 'L2' ? '' : '/'}`
  } catch {
    return `${segment}${hit.level === 'L2' ? '' : '/'}`
  }
}

function hitName(hit: SearchHitPayload): string {
  const segment = hit.uri.replace(/\/+$/u, '').split('/').at(-1) ?? hit.uri
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function entryMeta(entry: TreeEntryPayload): string {
  return entry.kind === 'directory' ? String(entry.size) : formatBytes(entry.size)
}
</script>

<template>
  <section class="workspace-browser" aria-label="文件列表">
    <header class="workspace-toolbar">
      <button
        type="button"
        class="iconbtn"
        aria-label="返回上一级"
        :disabled="!props.canGoUp"
        @click="emit('up')"
      >
        <ChevronLeft :size="17" :stroke-width="1.6" />
      </button>

      <nav class="workspace-crumbs" aria-label="当前位置">
        <template v-for="(crumb, index) in props.crumbs" :key="crumb.uri">
          <span v-if="index > 0" class="workspace-crumbs__sep" aria-hidden="true">/</span>
          <button
            v-if="index < props.crumbs.length - 1"
            type="button"
            class="workspace-crumbs__link"
            @click="emit('open', crumb.uri)"
          >
            {{ crumb.label }}
          </button>
          <span v-else class="workspace-crumbs__current">{{ crumb.label }}</span>
        </template>
      </nav>

      <span class="workspace-toolbar__spacer" />
      <UiRefreshButton label="刷新文件列表" :disabled="props.loading" @click="emit('refresh')" />
    </header>

    <div class="workspace-search">
      <Search :size="15" :stroke-width="1.5" aria-hidden="true" />
      <UiInput
        v-model="query"
        type="search"
        variant="ghost"
        size="sm"
        placeholder="搜索文件与记忆"
        aria-label="搜索文件与记忆"
      />
      <button
        v-if="searchingActive"
        type="button"
        class="workspace-search__clear"
        aria-label="清除搜索"
        @click="query = ''"
      >
        <X :size="13" :stroke-width="1.7" />
      </button>
      <UiSelect
        v-model="searchScope"
        :options="SEARCH_SCOPE_OPTIONS"
        aria-label="搜索范围"
        size="sm"
      />
    </div>

    <div class="workspace-browser__heading">
      <div>
        <h1>{{ searchingActive ? '搜索' : props.currentTitle }}</h1>
        <span v-if="searchingActive && props.searchHits !== null">
          {{ props.searchHits.length }} 项
        </span>
        <span v-else-if="props.entries !== null">{{ sortedEntries.length }} 项</span>
      </div>
      <div class="workspace-browser__actions">
        <button
          v-if="props.canCreateMemory"
          type="button"
          class="iconbtn"
          aria-label="新建记忆"
          title="新建记忆"
          @click="emit('create-memory')"
        >
          <Plus :size="16" :stroke-width="1.5" />
        </button>
        <button
          type="button"
          class="iconbtn"
          aria-label="新建文件夹"
          title="新建文件夹"
          :disabled="props.canCreate === false"
          @click="emit('create', 'directory')"
        >
          <FolderPlus :size="16" :stroke-width="1.5" />
        </button>
        <button
          type="button"
          class="iconbtn"
          aria-label="新建文档"
          title="新建文档"
          :disabled="props.canCreate === false"
          @click="emit('create', 'file')"
        >
          <FilePlus2 :size="16" :stroke-width="1.5" />
        </button>
      </div>
    </div>

    <div class="workspace-browser__content" aria-live="polite">
      <UiErrorRetry
        v-if="!searchingActive && props.error !== null"
        :message="props.error"
        @retry="emit('refresh')"
      >
        <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
      </UiErrorRetry>

      <UiErrorRetry
        v-else-if="searchingActive && props.searchError !== null"
        :message="props.searchError"
        @retry="emit('retry-search')"
      >
        <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
      </UiErrorRetry>

      <div
        v-else-if="(!searchingActive && props.loading) || (searchingActive && props.searching)"
        class="workspace-list"
        aria-busy="true"
      >
        <div v-for="index in 7" :key="index" class="workspace-row workspace-row--skeleton">
          <UiSkeleton width="18px" height="18px" />
          <div>
            <UiSkeleton :width="`${38 + (index % 4) * 10}%`" height="13px" />
            <UiSkeleton width="56%" height="10px" />
          </div>
        </div>
      </div>

      <UiEmpty
        v-else-if="searchingActive && props.searchHits !== null && props.searchHits.length === 0"
        v-slot="{ size }"
        title="没有搜索结果"
      >
        <SearchX :size="size" :stroke-width="1.4" />
      </UiEmpty>

      <div
        v-else-if="searchingActive && props.searchHits !== null"
        class="workspace-list"
        role="list"
      >
        <button
          v-for="hit in props.searchHits"
          :key="`${hit.uri}#${hit.level}`"
          type="button"
          class="workspace-row"
          :class="{ 'is-selected': hit.uri === props.selectedUri }"
          @click="emit('open', hit.uri)"
        >
          <FileText :size="18" :stroke-width="1.45" class="workspace-row__icon" />
          <span class="workspace-row__body">
            <span class="workspace-row__name">{{ hitTitle(hit) }}</span>
            <span class="workspace-row__detail">{{ hitName(hit) }}</span>
          </span>
          <span class="workspace-row__badge">{{ hit.level }}</span>
        </button>
      </div>

      <UiEmpty
        v-else-if="props.entries !== null && sortedEntries.length === 0"
        v-slot="{ size }"
        title="这个文件夹是空的"
      >
        <Folder :size="size" :stroke-width="1.4" />
      </UiEmpty>

      <div v-else-if="props.entries !== null" class="workspace-list" role="list">
        <button
          v-for="entry in sortedEntries"
          :key="entry.uri"
          type="button"
          class="workspace-row"
          :class="{ 'is-selected': entry.uri === props.selectedUri }"
          @click="emit('open', entry.uri)"
        >
          <Folder
            v-if="entry.kind === 'directory'"
            :size="18"
            :stroke-width="1.45"
            class="workspace-row__icon workspace-row__icon--folder"
          />
          <FileText
            v-else
            :size="18"
            :stroke-width="1.45"
            class="workspace-row__icon"
          />
          <span class="workspace-row__body">
            <span class="workspace-row__name">
              {{ fsEntryDisplayName(entry.kind, entry.name) }}
            </span>
            <span class="workspace-row__detail">{{ entry.kind === 'directory' ? '文件夹' : '文档' }}</span>
          </span>
          <span class="workspace-row__meta">{{ entryMeta(entry) }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workspace-browser {
  display: flex;
  flex: 0 0 332px;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  border-right: 0.5px solid var(--separator);
}

.workspace-toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 56px;
  padding: 10px 14px 8px;
}

.workspace-toolbar__spacer {
  flex: 1;
}

.workspace-crumbs {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
}

.workspace-crumbs__link,
.workspace-crumbs__current {
  overflow: hidden;
  max-width: 118px;
  text-overflow: ellipsis;
  text-decoration: none;
}

.workspace-crumbs__link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--label-3);
  font: inherit;
  cursor: pointer;
}

.workspace-crumbs__link:hover {
  color: var(--accent-ink);
}

.workspace-crumbs__current {
  color: var(--label);
  font-weight: 600;
}

.workspace-crumbs__sep {
  padding: 0 2px;
  color: var(--label-4);
}

.workspace-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 2px 14px 12px;
  padding: 3px 4px 3px 10px;
  border-radius: 10px;
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  color: var(--label-3);
}

.workspace-search :deep(.input) {
  min-width: 0;
}

.workspace-search :deep(.select) {
  width: 104px;
  flex: none;
}

.workspace-search :deep(.select select) {
  background: transparent;
  box-shadow: none;
}

.workspace-search__clear {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--fill-3);
  color: var(--label-2);
  cursor: pointer;
}

.workspace-browser__heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 14px 10px 18px;
}

.workspace-browser__heading > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}

.workspace-browser__heading h1 {
  overflow: hidden;
  margin: 0;
  font-size: 18px;
  font-weight: 680;
  letter-spacing: -0.016em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-browser__heading span {
  color: var(--label-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.workspace-browser__actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.workspace-browser__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 22px;
}

.workspace-list {
  display: grid;
  gap: 2px;
}

.workspace-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 48px;
  padding: 7px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--label);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.workspace-row:hover {
  background: var(--fill-hover);
}

.workspace-row.is-selected {
  background: var(--accent-tint);
}

.workspace-row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.workspace-row__icon {
  color: var(--label-3);
}

.workspace-row__icon--folder {
  color: var(--accent-ink);
}

.workspace-row__body {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.workspace-row__name,
.workspace-row__detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-row__name {
  font-size: 13px;
  font-weight: 570;
}

.workspace-row__detail {
  color: var(--label-3);
  font-size: 11px;
}

.workspace-row__meta,
.workspace-row__badge {
  color: var(--label-3);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.workspace-row__badge {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--fill-2);
  color: var(--label-2);
}

.workspace-row--skeleton {
  cursor: default;
}

.workspace-row--skeleton > div {
  display: grid;
  gap: 7px;
  min-width: 0;
}

@media (max-width: 1120px) {
  .workspace-browser {
    flex-basis: 292px;
  }
}
</style>
