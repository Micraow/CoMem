<script setup lang="ts">
/**
 * 首次初始化页（架构文档 §16 的控制台身份引导、§12.7 的认证开关）。
 *
 * 只在服务端说「还没有任何用户设置过密码」时出现（`GET /bootstrap` 的
 * `needsSetup: true`），由全局中间件把其它路径重定向过来。这一页不套外壳，也不
 * 借助身份状态发请求：它调用的两个端点都是匿名的，此时控制台还没有身份。
 *
 * 创建成功后是否还要重启由服务端回答（`restartRequired`）。为 true 说明认证
 * 开关没有打开，账号建了也登不进去——控制台既不能改 `config.yaml`，也不能替
 * 用户重启进程，所以这里给出完整的配置片段和重启命令，不假装初始化已经完成。
 *
 * ## 初始化令牌可以留空
 *
 * 建账号要么从回环地址发起，要么带服务端启动日志里的一次性令牌。控制台分不清
 * 自己是不是回环地址，所以令牌输入框一直显示、不做必填校验：本地 `pnpm dev`
 * 不带也能过。服务端说令牌不对（`INVALID_SETUP_TOKEN`）或这次请求不是本机发出的
 * （`NOT_LOOPBACK`）时，把焦点移到令牌输入框，提示从日志里复制。
 */
import { AlertTriangle, UserPlus } from 'lucide-vue-next'

import {
  ConsoleBootstrapError,
  SETUP_RESTART_COMMAND,
  bootstrapErrorNotice,
  createBootstrapAdmin,
  setupAdminConfigSnippet,
  validateSetupForm,
  type BootstrapAdminResult,
  type SetupFormErrors,
} from '~/composables/consoleBootstrap'
import { consoleIdentityState } from '~/composables/consoleIdentity'

useHead({ title: '初始化 · CoMem 控制台' })

/** 令牌输入框的 id。错误时靠它把焦点移过去。 */
const TOKEN_INPUT_ID = 'setup-token'

const config = useRuntimeConfig()
const state = consoleIdentityState()
const bootstrap = state.status === 'setup-required' ? state.bootstrap : null

/** 默认用户名取服务端绑定主体去掉 `user:` 前缀（`user:local` → `local`）。 */
function defaultUserId(boundSubject: string): string {
  return boundSubject.startsWith('user:') ? boundSubject.slice('user:'.length) : boundSubject
}

const userId = ref(bootstrap === null ? '' : defaultUserId(bootstrap.boundSubject))
const displayName = ref('')
const setupToken = ref('')
const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const errors = ref<SetupFormErrors>({})
const formError = ref<string | null>(null)
const tokenError = ref<string | null>(null)
const created = ref<BootstrapAdminResult | null>(null)

/** 服务端说需要令牌时显示输入框。响应里没有令牌本身，它在启动日志里。 */
const showSetupToken = bootstrap === null || bootstrap.setupTokenRequired

const configSnippet = computed(() =>
  created.value === null ? '' : setupAdminConfigSnippet(created.value.userId),
)

function errorMessageOf(caught: unknown): string {
  if (caught instanceof ConsoleBootstrapError) {
    return bootstrapErrorNotice(caught.code, caught.message)
  }
  return '无法连接 CoMem 服务，请确认后端已启动。'
}

/** 把焦点移到令牌输入框，光标停在末尾方便直接粘贴。 */
function focusTokenField(): void {
  const input = document.getElementById(TOKEN_INPUT_ID)
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return
  }

  const next = validateSetupForm({
    userId: userId.value,
    password: password.value,
    confirmPassword: confirmPassword.value,
  })
  errors.value = next
  formError.value = null
  tokenError.value = null
  if (Object.keys(next).length > 0) {
    return
  }

  submitting.value = true
  try {
    const result = await createBootstrapAdmin(
      String(config.public.apiBase),
      (url, init) => fetch(url, init),
      {
        userId: userId.value.trim(),
        displayName: displayName.value,
        password: password.value,
        setupToken: setupToken.value,
      },
    )
    if (result.restartRequired) {
      created.value = result
      return
    }
    // 认证本来就开着，账号建好即可登录。整页跳转让插件用新状态重新引导。
    window.location.assign('/login?created=1')
  } catch (caught) {
    // 初始化已经完成（另一个标签页抢先建好了账号）：状态过期了，整页重新引导。
    if (caught instanceof ConsoleBootstrapError && caught.code === 'BOOTSTRAP_CLOSED') {
      window.location.assign('/login')
      return
    }
    // 令牌不对 / 不是本机请求：提示放在令牌字段旁，并把焦点移过去。
    if (
      caught instanceof ConsoleBootstrapError &&
      (caught.code === 'INVALID_SETUP_TOKEN' || caught.code === 'NOT_LOOPBACK')
    ) {
      tokenError.value = errorMessageOf(caught)
      focusTokenField()
      return
    }
    formError.value = errorMessageOf(caught)
  } finally {
    submitting.value = false
  }
}

function goLogin(): void {
  window.location.assign('/login')
}
</script>

<template>
  <main class="setup">
    <section class="setup__card" aria-labelledby="setup-title">
      <div class="setup__brand">
        <span class="brand-mark" aria-hidden="true">
          <span class="strata strata--lg"><i /><i /><i /></span>
        </span>
        <span class="brand-text">
          <b>CoMem</b>
          <span>Console</span>
        </span>
      </div>

      <h1 id="setup-title" class="setup__title">初始化 CoMem</h1>
      <p class="setup__lead">这是首次启动，需要创建一个管理员账号。</p>

      <section v-if="created !== null" class="setup__next" aria-labelledby="setup-next-title">
        <h2 id="setup-next-title" class="setup__next-title">管理员账号已创建</h2>
        <p class="setup__text">
          还需要在配置里启用多用户登录，这个账号才能登录。把下面几行加到
          <code>config.yaml</code>：
        </p>
        <pre class="setup__code">{{ configSnippet }}</pre>
        <p class="setup__text">然后重启 CoMem 服务：</p>
        <pre class="setup__code">{{ SETUP_RESTART_COMMAND }}</pre>
        <p class="setup__text">重启后用这个用户名和密码登录。</p>
        <UiButton variant="primary" class="setup__submit" @click="goLogin">去登录</UiButton>
      </section>

      <form v-else class="setup__form" novalidate @submit.prevent="submit">
        <div class="field">
          <label class="field__label" for="setup-user-id">用户名</label>
          <UiInput
            id="setup-user-id"
            v-model="userId"
            autocomplete="username"
            :disabled="submitting"
          />
          <span class="field__hint">小写字母或数字开头，最长 64 个字符。</span>
          <span v-if="errors.userId !== undefined" class="field__error" role="alert">
            {{ errors.userId }}
          </span>
        </div>

        <div class="field">
          <label class="field__label" for="setup-display-name">显示名（可选）</label>
          <UiInput
            id="setup-display-name"
            v-model="displayName"
            autocomplete="nickname"
            :disabled="submitting"
          />
        </div>

        <div v-if="showSetupToken" class="field">
          <label class="field__label" :for="TOKEN_INPUT_ID">初始化令牌</label>
          <UiInput
            :id="TOKEN_INPUT_ID"
            v-model="setupToken"
            autocomplete="off"
            :disabled="submitting"
          />
          <span class="field__hint">
            在 CoMem 服务端启动日志里找以「初始化令牌：」开头的那一行。本机访问可以留空。
          </span>
          <span v-if="tokenError !== null" class="field__error" role="alert">{{ tokenError }}</span>
        </div>

        <div class="field">
          <label class="field__label" for="setup-password">密码</label>
          <UiInput
            id="setup-password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :disabled="submitting"
          />
          <span v-if="errors.password !== undefined" class="field__error" role="alert">
            {{ errors.password }}
          </span>
        </div>

        <div class="field">
          <label class="field__label" for="setup-password-confirm">确认密码</label>
          <UiInput
            id="setup-password-confirm"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :disabled="submitting"
          />
          <span v-if="errors.confirmPassword !== undefined" class="field__error" role="alert">
            {{ errors.confirmPassword }}
          </span>
        </div>

        <div v-if="formError !== null" class="callout callout--danger" role="alert">
          <AlertTriangle :size="15" :stroke-width="1.4" />
          <div>{{ formError }}</div>
        </div>

        <UiButton variant="primary" type="submit" :disabled="submitting" class="setup__submit">
          <UserPlus :size="15" :stroke-width="1.6" />
          {{ submitting ? '正在创建…' : '创建管理员账号' }}
        </UiButton>
      </form>
    </section>
  </main>
</template>

<style scoped>
.setup {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: var(--s-6);
  background: var(--desktop);
}

.setup__card {
  width: 100%;
  max-width: 440px;
  padding: 32px;
  border-radius: var(--r-panel);
  background: var(--surface);
  box-shadow: var(--shadow-pop), var(--inset-hair);
}

.setup__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
}

.setup__title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.16;
  letter-spacing: -0.021em;
}

.setup__lead {
  margin-top: 6px;
  color: var(--label-2);
}

.setup__form {
  display: grid;
  gap: var(--s-4);
  margin-top: 24px;
}

.setup__next {
  display: grid;
  gap: var(--s-3);
  margin-top: 24px;
}

.setup__next-title {
  font-size: 17px;
  font-weight: 590;
  letter-spacing: -0.011em;
}

.setup__text {
  color: var(--label-2);
  font-size: 14px;
  line-height: 1.52;
}

.setup__code {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-control);
  background: var(--surface-2);
  box-shadow: var(--inset-hair);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
  overflow-x: auto;
  /* 一键全选，复制配置片段不用拖鼠标。 */
  user-select: all;
}

.setup__submit {
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

.field__hint {
  font-size: 13px;
  color: var(--label-3);
}

.field__error {
  font-size: 13px;
  color: var(--red-ink);
}
</style>
