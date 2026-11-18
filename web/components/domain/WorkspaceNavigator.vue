<script setup lang="ts">
import {
  CircleUserRound,
  Database,
  FileText,
  Folder,
  History,
  UsersRound,
} from 'lucide-vue-next'
import type { Component } from 'vue'

import type { TreeEntryPayload } from '~/composables/useApi'
import { fsEntryDisplayName } from '~/utils/fsLabels'

export interface WorkspaceScopeOption {
  readonly uri: string
  readonly label: string
  readonly kind: 'personal' | 'group'
}

export interface WorkspaceSharedFolder {
  readonly uri: string
  readonly label: string
}

const props = defineProps<{
  scopes: readonly WorkspaceScopeOption[]
  sharedFolders: readonly WorkspaceSharedFolder[]
  scopeRoot: string
  rootEntries: readonly TreeEntryPayload[] | null
  currentUri: string
  loading: boolean
}>()

const emit = defineEmits<{
  'select-space': [uri: string]
  open: [uri: string]
  'open-shared': [uri: string]
}>()

const rootDirectories = computed(() =>
  (props.rootEntries ?? []).filter(
    (entry) => entry.kind === 'directory' && !entry.name.startsWith('.'),
  ),
)

const ROOT_ICONS: Readonly<Record<string, Component>> = {
  memories: Database,
  resources: FileText,
  sessions: History,
  projects: Folder,
}

function rootIcon(name: string): Component {
  return ROOT_ICONS[name.toLowerCase()] ?? Folder
}

function isCurrent(uri: string): boolean {
  const current = props.currentUri.replace(/\/+$/u, '')
  return current === uri || current.startsWith(`${uri}/`)
}
</script>

<template>
  <aside class="workspace-nav" aria-label="文件位置">
    <header class="workspace-nav__head">
      <span>位置</span>
    </header>

    <div class="workspace-nav__scroll">
      <section class="workspace-nav__section" aria-label="空间">
        <div class="workspace-nav__label">空间</div>
        <button
          v-for="scope in props.scopes"
          :key="scope.uri"
          type="button"
          class="workspace-place"
          :class="{ 'is-active': scope.uri === props.scopeRoot }"
          @click="emit('select-space', scope.uri)"
        >
          <UsersRound v-if="scope.kind === 'group'" :size="16" :stroke-width="1.5" />
          <CircleUserRound v-else :size="16" :stroke-width="1.5" />
          <span>{{ scope.label }}</span>
        </button>
      </section>

      <section
        v-if="props.sharedFolders.length > 0"
        class="workspace-nav__section"
        aria-label="与我共享"
      >
        <div class="workspace-nav__label">与我共享</div>
        <button
          v-for="folder in props.sharedFolders"
          :key="folder.uri"
          type="button"
          class="workspace-place"
          :class="{ 'is-active': isCurrent(folder.uri) }"
          @click="emit('open-shared', folder.uri)"
        >
          <Folder :size="16" :stroke-width="1.5" />
          <span>{{ folder.label }}</span>
        </button>
      </section>

      <section class="workspace-nav__section" aria-label="常用位置">
        <div class="workspace-nav__label">常用位置</div>
        <div v-if="props.loading && props.rootEntries === null" class="workspace-nav__loading">
          <UiSkeleton v-for="index in 4" :key="index" :width="`${62 + index * 7}%`" height="12px" />
        </div>
        <template v-else>
          <button
            v-for="entry in rootDirectories"
            :key="entry.uri"
            type="button"
            class="workspace-place"
            :class="{ 'is-active': isCurrent(entry.uri) }"
            @click="emit('open', entry.uri)"
          >
            <component :is="rootIcon(entry.name)" :size="16" :stroke-width="1.5" />
            <span>{{ fsEntryDisplayName(entry.kind, entry.name) }}</span>
          </button>
        </template>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.workspace-nav {
  display: flex;
  flex: 0 0 214px;
  flex-direction: column;
  min-height: 0;
  background: color-mix(in srgb, var(--bg-2) 92%, transparent);
  border-right: 0.5px solid var(--separator);
}

.workspace-nav__head {
  flex: none;
  padding: 18px 16px 10px;
  color: var(--label-2);
  font-size: 13px;
  font-weight: 650;
}

.workspace-nav__scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 22px;
}

.workspace-nav__section {
  display: grid;
  gap: 2px;
  padding: 8px 0;
}

.workspace-nav__section + .workspace-nav__section {
  margin-top: 8px;
  padding-top: 16px;
  border-top: 0.5px solid var(--separator);
}

.workspace-nav__label {
  padding: 0 10px 6px;
  color: var(--label-3);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.workspace-nav__loading {
  display: grid;
  gap: 12px;
  padding: 9px 10px;
}

.workspace-place {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 34px;
  padding: 6px 9px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--label-2);
  font: inherit;
  font-size: 13px;
  font-weight: 520;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.workspace-place svg {
  flex: none;
  color: var(--label-3);
}

.workspace-place span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-place:hover {
  background: var(--fill-hover);
  color: var(--label);
}

.workspace-place.is-active {
  background: var(--accent-tint);
  color: var(--label);
}

.workspace-place.is-active svg {
  color: var(--accent-ink);
}

.workspace-place:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

@media (max-width: 1120px) {
  .workspace-nav {
    flex-basis: 188px;
  }
}
</style>
