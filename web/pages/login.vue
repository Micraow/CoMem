<script setup lang="ts">
/**
 * 登录页（架构文档 §16、§12.7）。
 *
 * 只在 `auth.enabled: true` 且浏览器里没有可用会话时出现；单用户模式由全局
 * 中间件直接放行，不会看到这一页。
 *
 * 登录成功用整页跳转而不是 `navigateTo`：身份状态在模块作用域里只求值一次，
 * 刷新能让插件用新会话重新引导，避免「已经登录但页面还停在登录分支」。凭据在
 * `sessionStorage` 里，整页跳转不会丢。
 */
import { AlertTriangle, LockKeyhole } from 'lucide-vue-next'

import { ConsoleIdentityError, loginConsole } from '~/composables/consoleIdentity'

useHead({ title: '登录 · CoMem 控制台' })

const route = useRoute()
const config = useRuntimeConfig()

const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

/**
 * 只接受站内绝对路径。
 *
 * `redirect` 来自 URL，不校验就是一个开放重定向：`//evil.example` 会被浏览器
 * 当成协议相对地址。`/` 开头的单个斜杠才是站内路径。
 */
function safeRedirect(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/'
  }
  return raw
}

function errorMessageOf(caught: unknown): string {
  if (caught instanceof ConsoleIdentityError) {
    return caught.message
  }
  return '无法连接 CoMem 服务，请确认后端已启动。'
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return
  }

  const name = username.value.trim()
  if (name === '') {
    error.value = '请输入用户名。'
    return
  }
  if (password.value === '') {
    error.value = '请输入密码。'
    return
  }

  submitting.value = true
  error.value = null
  try {
    await loginConsole(
      String(config.public.apiBase),
      (url, init) => fetch(url, init),
      { username: name, password: password.value },
    )
    window.location.assign(safeRedirect(route.query['redirect']))
  } catch (caught) {
    error.value = errorMessageOf(caught)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="login">
    <section class="login__card" aria-labelledby="login-title">
      <div class="login__brand">
        <span class="brand-mark" aria-hidden="true">
          <span class="strata strata--lg"><i /><i /><i /></span>
        </span>
        <span class="brand-text">
          <b>CoMem</b>
          <span>Console</span>
        </span>
      </div>

      <h1 id="login-title" class="login__title">登录</h1>
      <p class="login__lead">使用 CoMem 用户账号登录控制台。</p>

      <form class="login__form" @submit.prevent="submit">
        <label class="field">
          <span class="field__label">用户名</span>
          <UiInput
            v-model="username"
            autocomplete="username"
            aria-label="用户名"
            :disabled="submitting"
          />
        </label>

        <label class="field">
          <span class="field__label">密码</span>
          <UiInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            aria-label="密码"
            :disabled="submitting"
          />
        </label>

        <div v-if="error !== null" class="callout callout--danger" role="alert">
          <AlertTriangle :size="15" :stroke-width="1.4" />
          <div>{{ error }}</div>
        </div>

        <UiButton variant="primary" type="submit" :disabled="submitting" class="login__submit">
          <LockKeyhole :size="15" :stroke-width="1.6" />
          {{ submitting ? '正在登录…' : '登录' }}
        </UiButton>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: var(--s-6);
  background: var(--desktop);
}

.login__card {
  width: 100%;
  max-width: 380px;
  padding: 32px;
  border-radius: var(--r-panel);
  background: var(--surface);
  box-shadow: var(--shadow-pop), var(--inset-hair);
}

.login__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
}

.login__title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.16;
  letter-spacing: -0.021em;
}

.login__lead {
  margin-top: 6px;
  color: var(--label-2);
}

.login__form {
  display: grid;
  gap: var(--s-4);
  margin-top: 24px;
}

.login__submit {
  width: 100%;
  margin-top: 4px;
}

.field {
  display: grid;
  gap: 6px;
}

.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-2);
}
</style>
