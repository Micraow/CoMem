<script setup lang="ts">
/**
 * 设置登录密码（用户详情的「密码」页签与用户表的「设密码」入口共用一份）。
 *
 * 管理员给其他用户重设密码走 `POST /admin/users/{id}/password`；当前登录用户
 * 修改自己的密码走 `POST /auth/password`，必须先验证当前密码。表单只在这里
 * 一份，校验规则与错误落点不会在两个入口漂移。
 *
 * ## 两次输入都要有
 *
 * 密码输入框不回显，手滑的代价是「这个账号登不进」。确认密码是本地校验，服务端
 * 只收到一个 `password`。
 *
 * ## 口令强度不抄到前端
 *
 * 长度与字符集规则只在服务端（`assertPasswordPolicy`）。400 的原文挂在密码字段旁：
 * 它点名了缺什么，翻译成「密码不合规」只会让人再猜一次。判定依据是服务端
 * `details.field === 'currentPassword' | 'password'`；其它失败（网络、403）仍走
 * toast。
 */
import { LockKeyhole } from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { isRecord } from '~/utils/record'

const props = withDefaults(
  defineProps<{
    userId: string
    /** `self` 走自助端点并校验当前密码；`delegated` 由管理员为其他账号重设。 */
    mode?: 'delegated' | 'self'
    submitLabel?: string
    /** 给「设密码」小对话框用；详情页签里不需要，不传。 */
    cancelLabel?: string
  }>(),
  { mode: 'delegated', submitLabel: undefined, cancelLabel: undefined },
)

const emit = defineEmits<{
  saved: []
  cancel: []
}>()

const api = useApi()
const toast = useToast()

/** 同一页可能同时挂两个实例（详情抽屉 + 小对话框），`useId` 保证 label 不串。 */
const passwordId = useId()
const confirmId = useId()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const currentPasswordError = ref<string | null>(null)
const passwordError = ref<string | null>(null)
const confirmError = ref<string | null>(null)
const saving = ref(false)

const effectiveSubmitLabel = computed(
  () => props.submitLabel ?? (props.mode === 'self' ? '更新密码' : '设置密码'),
)

watch([currentPassword, newPassword, confirmPassword], () => {
  currentPasswordError.value = null
  passwordError.value = null
  confirmError.value = null
})

/** 只校验「非空 + 两次一致」；强度交给服务端。 */
function validate(): boolean {
  currentPasswordError.value = null
  passwordError.value = null
  confirmError.value = null
  if (props.mode === 'self' && currentPassword.value === '') {
    currentPasswordError.value = '请输入当前密码。'
    return false
  }
  if (newPassword.value === '') {
    passwordError.value = '请输入新密码。'
    return false
  }
  if (confirmPassword.value === '') {
    confirmError.value = '请再次输入新密码。'
    return false
  }
  if (confirmPassword.value !== newPassword.value) {
    confirmError.value = '两次输入的密码不一致。'
    return false
  }
  return true
}

function passwordFieldErrorOf(caught: unknown): string | null {
  if (!(caught instanceof ApiClientError)) {
    return null
  }
  if (isRecord(caught.details)) {
    if (caught.details['field'] === 'currentPassword') {
      return caught.message
    }
    if (caught.details['field'] === 'password') {
      return caught.message
    }
  }
  return caught.statusCode === 400 && caught.message.includes('密码') ? caught.message : null
}

async function submit(): Promise<void> {
  if (saving.value || !validate()) {
    return
  }

  saving.value = true
  try {
    if (props.mode === 'self') {
      await api.post('/auth/password', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      })
    } else {
      await api.post(`/admin/users/${encodeURIComponent(props.userId)}/password`, {
        password: newPassword.value,
      })
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    if (props.mode === 'delegated') {
      toast.show('success', '密码已更新，已签发的登录凭据立即失效')
    }
    emit('saved')
  } catch (caught) {
    const message = passwordFieldErrorOf(caught)
    if (message === null) {
      toast.show('error', errorMessageOf(caught))
    } else if (
      caught instanceof ApiClientError &&
      isRecord(caught.details) &&
      caught.details['field'] === 'currentPassword'
    ) {
      currentPasswordError.value = message
    } else {
      passwordError.value = message
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="stack-16" novalidate @submit.prevent="submit">
    <p class="body-sm muted">
      {{
        props.mode === 'self'
          ? '更新后当前会话失效，需要重新登录；API Key 不受影响。'
          : '更新后的旧登录会话失效；API Key 不受影响。'
      }}
    </p>

    <div v-if="props.mode === 'self'" class="field">
      <label class="field__label" :for="`${passwordId}-current`">当前密码</label>
      <UiInput
        :id="`${passwordId}-current`"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        :disabled="saving"
        :aria-describedby="
          currentPasswordError === null ? undefined : `${passwordId}-current-error`
        "
      />
      <span
        v-if="currentPasswordError !== null"
        :id="`${passwordId}-current-error`"
        class="field__error"
        role="alert"
      >
        {{ currentPasswordError }}
      </span>
    </div>

    <div class="field">
      <label class="field__label" :for="passwordId">新密码</label>
      <UiInput
        :id="passwordId"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        :disabled="saving"
        :aria-describedby="passwordError === null ? undefined : `${passwordId}-error`"
      />
      <span
        v-if="passwordError !== null"
        :id="`${passwordId}-error`"
        class="field__error"
        role="alert"
      >
        {{ passwordError }}
      </span>
    </div>

    <div class="field">
      <label class="field__label" :for="confirmId">确认新密码</label>
      <UiInput
        :id="confirmId"
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        :disabled="saving"
        :aria-describedby="confirmError === null ? undefined : `${confirmId}-error`"
      />
      <span
        v-if="confirmError !== null"
        :id="`${confirmId}-error`"
        class="field__error"
        role="alert"
      >
        {{ confirmError }}
      </span>
    </div>

    <div class="rowflex">
      <span class="spacer" />
      <UiButton
        v-if="props.cancelLabel !== undefined"
        variant="secondary"
        :disabled="saving"
        @click="emit('cancel')"
      >
        {{ props.cancelLabel }}
      </UiButton>
      <UiButton variant="primary" type="submit" :disabled="saving">
        <LockKeyhole :size="14" :stroke-width="1.5" />
        {{ effectiveSubmitLabel }}
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.field {
  display: grid;
  gap: 6px;
}

.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-2);
}

.field__error {
  font-size: 13px;
  line-height: 1.45;
  color: var(--red-ink);
  word-break: break-word;
}
</style>
