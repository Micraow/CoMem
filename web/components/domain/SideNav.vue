<script setup lang="ts">
/**
 * 主导航（架构文档 §16 的十个业务页）。
 *
 * 入口清单在 `utils/nav.ts`：标题栏面包屑要用同一份标签，而纯 TS 清单才能被
 * `tests/unit/web/nav.test.ts` 直接 import（测试运行器不加载 Vue 组件）。
 */
import {
  Activity,
  ClipboardCheck,
  FileText,
  FolderTree,
  History,
  LayoutDashboard,
  Plug,
  Search,
  Shield,
  Terminal,
  Users,
} from 'lucide-vue-next'
import type { Component } from 'vue'

import { consoleIdentityState, consoleScopeLabel } from '~/composables/consoleIdentity'
import { useScopeRoot } from '~/composables/useApi'
import { NAV_GROUPS, isActivePath, type NavIconName } from '~/utils/nav'

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
}

const state = consoleIdentityState()
const identity = state.status === 'ready' ? state.identity : null
const scopeRoot = useScopeRoot()
const scopeLabel = computed(() =>
  identity === null ? '—' : consoleScopeLabel(scopeRoot.value, identity.subject),
)
const route = useRoute()
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
      <template v-for="group in NAV_GROUPS" :key="group.label">
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
      <div class="footstat">
        <span>命名空间</span>
        <b>{{ scopeLabel }}</b>
      </div>
    </div>
  </aside>
</template>
