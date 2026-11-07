<script lang="ts">
/**
 * 主导航（架构文档 §16 的七个业务页 + 概览）。
 *
 * 入口清单放在普通 `<script>` 块里导出：标题栏的面包屑要用同一份标签，
 * 两处各写一份迟早会出现「侧栏叫记忆复核、标题叫待复核」的漂移。
 */
import {
  Activity,
  ClipboardCheck,
  FolderTree,
  History,
  LayoutDashboard,
  Search,
  Shield,
  Users,
} from 'lucide-vue-next'
import type { Component } from 'vue'

export interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: Component
}

export interface NavGroup {
  readonly label: string
  readonly items: readonly NavItem[]
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '控制台',
    items: [
      { to: '/', label: '概览', icon: LayoutDashboard },
      { to: '/files', label: '文件树', icon: FolderTree },
      { to: '/search', label: '检索调试', icon: Search },
      { to: '/review', label: '记忆复核', icon: ClipboardCheck },
    ],
  },
  {
    label: '治理',
    items: [
      { to: '/acl', label: '权限管理', icon: Shield },
      { to: '/admin', label: '用户与组', icon: Users },
    ],
  },
  {
    label: '运维',
    items: [
      { to: '/sessions', label: '会话与任务', icon: History },
      { to: '/monitor', label: '监控', icon: Activity },
    ],
  },
]

/** 路径是否命中入口。根路径只做精确匹配，否则任何页面都会点亮「概览」。 */
export function isActivePath(to: string, path: string): boolean {
  if (to === '/') {
    return path === '/'
  }
  return path === to || path.startsWith(`${to}/`)
}

/** 当前路径对应的入口标签，用于标题栏面包屑。 */
export function navLabelOf(path: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isActivePath(item.to, path)) {
        return item.label
      }
    }
  }
  return '控制台'
}
</script>

<script setup lang="ts">
const scopeRoot = useScopeRoot()
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
          <component :is="item.icon" :size="17" :stroke-width="1.4" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </template>
    </nav>

    <div class="sidebar__foot">
      <div class="footstat">
        <span>命名空间</span>
        <b class="mono">{{ scopeRoot }}</b>
      </div>
    </div>
  </aside>
</template>
