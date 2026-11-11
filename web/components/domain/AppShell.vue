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
import { LogOut, Menu, Moon, Sun, ShieldAlert } from 'lucide-vue-next'
import { useMediaQuery } from '@vueuse/core'

import { consoleIdentityState, consoleScopeLabel, logoutConsole } from '~/composables/consoleIdentity'
import { selectScopeRoot, useScopeRoot } from '~/composables/useApi'
import { singleUserModeNotice } from '~/utils/consoleBanner'

import { navLabelOf } from './SideNav.vue'

const THEME_STORAGE_KEY = 'comem-console-theme'

const isMobile = useMediaQuery('(max-width: 767px)')
const navOpen = ref(false)
const route = useRoute()
const theme = useState<'dark' | 'light'>('comem-console-theme', () => 'dark')

const currentLabel = computed(() => navLabelOf(route.path))

/**
 * 头像只显示当前主体的首字母。
 *
 * 主体名是部署配置里的内部标识，不进入可见区域；没有主体时显示 `?`，不显示一个
 * 假的占位人。**取绑定主体而不是作用域**：切到组空间之后头像仍然是登录用户。
 */
const identityState = consoleIdentityState()
const identity = identityState.status === 'ready' ? identityState.identity : null
const scopeRoot = useScopeRoot()
const authEnabled = identity?.authEnabled === true

/**
 * 单用户模式横幅。
 *
 * 常驻而不是 toast：认证状态在本次页面生命周期内不会变，toast 消失之后用户又
 * 回到「不知道自己在以谁的身份操作」。文案在 `utils/consoleBanner.ts`，那里
 * 能用普通替身测「显示 / 不显示」。
 */
const singleUserNotice = singleUserModeNotice(identity)

const subjectInitial = computed(() => {
  const subject = identity?.subject ?? ''
  const id = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  const first = id.charAt(0)
  return first === '' ? '?' : first.toUpperCase()
})

const scopeOptions = computed(() =>
  (identity?.scopes ?? []).map((scope) => ({
    value: scope,
    label: consoleScopeLabel(scope, identity?.subject ?? ''),
  })),
)

/** 只有一个作用域时不显示选择器：那是没有选择的状态，不是「统一」。 */
const showScopePicker = computed(() => scopeOptions.value.length > 1)

const scopeModel = computed({
  get: () => scopeRoot.value,
  set: (value: string) => {
    selectScopeRoot(value)
  },
})

const loggingOut = ref(false)
const config = useRuntimeConfig()

async function logout(): Promise<void> {
  if (loggingOut.value) {
    return
  }
  loggingOut.value = true
  try {
    await logoutConsole(String(config.public.apiBase), (url, init) => fetch(url, init))
  } finally {
    window.location.assign('/login')
  }
}

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
      <div v-if="singleUserNotice !== null" class="mode-banner">
        <ShieldAlert :size="14" :stroke-width="1.5" aria-hidden="true" />
        <span>{{ singleUserNotice }}</span>
      </div>

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
          <UiSelect
            v-if="showScopePicker"
            v-model="scopeModel"
            :options="scopeOptions"
            size="sm"
            aria-label="作用域"
            class="scope-picker"
          />
          <button
            type="button"
            class="iconbtn"
            :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'"
            @click="toggleTheme"
          >
            <Sun v-if="theme === 'dark'" :size="16" :stroke-width="1.4" />
            <Moon v-else :size="16" :stroke-width="1.4" />
          </button>
          <button
            v-if="authEnabled"
            type="button"
            class="iconbtn"
            aria-label="退出登录"
            :disabled="loggingOut"
            @click="logout"
          >
            <LogOut :size="16" :stroke-width="1.4" />
          </button>
          <span class="avatar" aria-hidden="true">{{ subjectInitial }}</span>
        </div>
      </header>

      <slot />
    </div>
  </div>
</template>

<style scoped>
.scope-picker {
  width: 168px;
}

/* 常驻横幅：橙色提示底，不可关闭。 */
.mode-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--orange-ink);
  background: var(--orange-tint);
  border-bottom: 0.5px solid var(--separator);
}

.mode-banner > svg {
  flex: none;
}
</style>
