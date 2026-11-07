<script setup lang="ts">
/**
 * 控制台外壳（架构文档 §16.1 的外壳规则）。
 *
 * 左侧固定侧栏 + 顶部工具栏 + 主区独立滚动。材质只给外壳（侧栏 62% / 工具栏 78%），
 * 内容卡片用发丝描边，不用材质——材质表达层级，不表达「这里是卡片」。
 *
 * 移动端（< 768px）侧栏收成抽屉：同一份 `SideNav` 放进 Dialog 的 left 形态，
 * 不复制一份导航结构。
 */
import { Menu, Moon, Sun } from 'lucide-vue-next'
import { useMediaQuery } from '@vueuse/core'

import { navLabelOf } from './SideNav.vue'

const THEME_STORAGE_KEY = 'comem-console-theme'

const isMobile = useMediaQuery('(max-width: 767px)')
const navOpen = ref(false)
const route = useRoute()
const theme = useState<'dark' | 'light'>('comem-console-theme', () => 'dark')

const currentLabel = computed(() => navLabelOf(route.path))

function applyTheme(value: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = value
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // 隐私模式下写不了 localStorage：当前会话仍然切换，下次打开回到默认深色。
  }
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
}

function readStoredTheme(): 'dark' | 'light' | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'dark' || saved === 'light' ? saved : null
  } catch {
    return null
  }
}

onMounted(() => {
  const saved = readStoredTheme()
  if (saved !== null) {
    theme.value = saved
  }
  applyTheme(theme.value)
})

watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)
</script>

<template>
  <div class="app">
    <DomainSideNav v-if="!isMobile" />
    <UiDialog v-else v-model="navOpen" placement="left" title="导航" :show-header="false">
      <DomainSideNav />
    </UiDialog>

    <div class="main">
      <header class="titlebar">
        <button
          v-if="isMobile"
          type="button"
          class="iconbtn nav-toggle"
          aria-label="打开导航"
          @click="navOpen = true"
        >
          <Menu :size="17" :stroke-width="1.5" />
        </button>

        <div class="titlebar__title">
          <span class="crumb">
            <NuxtLink to="/">控制台</NuxtLink>
            <span class="sep">/</span>
            <span class="current">{{ currentLabel }}</span>
          </span>
        </div>

        <span class="titlebar__spacer" />

        <div class="titlebar__group">
          <button
            type="button"
            class="iconbtn"
            :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'"
            @click="toggleTheme"
          >
            <Sun v-if="theme === 'dark'" :size="16" :stroke-width="1.4" />
            <Moon v-else :size="16" :stroke-width="1.4" />
          </button>
          <span class="avatar" title="user:local">LO</span>
        </div>
      </header>

      <slot />
    </div>
  </div>
</template>
