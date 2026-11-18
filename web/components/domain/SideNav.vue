<script setup lang="ts">
/**
 * 主导航（架构文档 §16 的业务页 + 末尾的「设置」）。
 *
 * 入口清单在 `utils/nav.ts`：标题栏面包屑要用同一份标签，而纯 TS 清单才能被
 * `tests/unit/web/nav.test.ts` 直接 import（测试运行器不加载 Vue 组件）。
 */
import {
  Activity,
  CircleUserRound,
  ClipboardCheck,
  FileText,
  FolderTree,
  History,
  LayoutDashboard,
  Plug,
  Search,
  Settings,
  Shield,
  Terminal,
  Users,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'

import {
  consoleIdentityState,
  consoleScopeLabel,
  subscribeConsoleIdentity,
} from '~/composables/consoleIdentity'
import { selectScopeRoot, useScopeRoot } from '~/composables/useApi'
import { isActivePath, navGroupsFor, type NavIconName } from '~/utils/nav'

const NAV_ICONS: Record<NavIconName, Component> = {
  plug: Plug,
  dashboard: LayoutDashboard,
  tree: FolderTree,
  search: Search,
  review: ClipboardCheck,
  tools: Terminal,
  shield: Shield,
  users: Users,
  prompt: FileText,
  sessions: History,
  monitor: Activity,
  settings: Settings,
  account: CircleUserRound,
}

const state = ref(consoleIdentityState())
const identity = computed(() =>
  state.value.status === 'ready' ? state.value.identity : null,
)
const scopeRoot = useScopeRoot()
const scopeOptions = computed(() =>
  (identity.value?.spaces ?? []).length > 0
    ? (identity.value?.spaces ?? []).map((space) => ({
        value: space.scope,
        label: space.displayName,
      }))
    : (identity.value?.scopes ?? []).map((scope) => ({
        value: scope,
        label: consoleScopeLabel(scope, identity.value?.subject ?? ''),
      })),
)
const hasScopeChoice = computed(() => scopeOptions.value.length > 1)
const currentScopeLabel = computed(() => {
  const currentIdentity = identity.value
  if (currentIdentity === null || scopeRoot.value === '') {
    return '暂无可访问空间'
  }
  return (
    currentIdentity.spaces?.find((space) => space.scope === scopeRoot.value)?.displayName ??
    consoleScopeLabel(scopeRoot.value, currentIdentity.subject)
  )
})
const scopeModel = computed({
  get: () => scopeRoot.value,
  set: (value: string) => {
    selectScopeRoot(value)
  },
})
const route = useRoute()
const navGroups = computed(() => navGroupsFor(identity.value?.isAdmin === true))

let unsubscribeIdentity: (() => void) | undefined
onMounted(() => {
  unsubscribeIdentity = subscribeConsoleIdentity((next) => {
    state.value = next
  })
})
onBeforeUnmount(() => {
  unsubscribeIdentity?.()
})
</script>

<template>
  <aside class="sidebar" aria-label="侧边栏">
    <div class="sidebar__brand">
      <span class="brand-mark" aria-hidden="true">
        <span class="strata strata--lg"><i /><i /><i /></span>
      </span>
      <span class="brand-text">
        <b>CoMem</b>
        <span>Console</span>
      </span>
    </div>

    <nav class="sidenav" aria-label="主导航">
      <template v-for="group in navGroups" :key="group.label">
        <div class="sidenav__label">{{ group.label }}</div>
        <NuxtLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="navitem"
          :class="{ 'is-active': isActivePath(item.to, route.path) }"
          :aria-current="isActivePath(item.to, route.path) ? 'page' : undefined"
        >
          <component :is="NAV_ICONS[item.icon]" :size="17" :stroke-width="1.4" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </template>
    </nav>

    <div class="sidebar__foot">
      <div class="space">
        <label v-if="hasScopeChoice" class="space__label" for="console-space">
          当前空间
        </label>
        <UiSelect
          v-if="hasScopeChoice"
          id="console-space"
          v-model="scopeModel"
          :options="scopeOptions"
          aria-label="当前空间"
        />
        <template v-else>
          <span class="space__label">当前空间</span>
          <b class="space__current">{{ currentScopeLabel }}</b>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.space {
  display: grid;
  gap: 6px;
}

.space__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-3);
}

.space__current {
  overflow: hidden;
  color: var(--label);
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.space :deep(.select) {
  width: 100%;
}
</style>
