<script setup lang="ts">
/**
 * 设置登录密码（用户详情的「密码」页签与用户表的「设密码」入口共用一份）。
 *
 * 两个入口做的是同一件事：把明文密码提交给 `POST /admin/users/{id}/password`。
 * 表单只在这里一份——校验规则、错误落点、成功后的提示都只有一处，两个入口不会
 * 各说各的。
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
 * `details.field === 'password'`；没有这个字段的失败（网络、403）仍走 toast。
 */
import { LockKeyhole } from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { isRecord } from '~/utils/record'

const props = withDefaults(
  defineProps<{
    userId: string
    submitLabel?: string
    /** 给「设密码」小对话框用；详情页签里不需要，不传。 */
    cancelLabel?: string
  }>(),
  { submitLabel: '设置密码', cancelLabel: undefined },
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

const password = ref('')
const confirmPassword = ref('')
const passwordError = ref<string | null>(null)
const confirmError = ref<string | null>(null)
const saving = ref(false)

watch([password, confirmPassword], () => {
  passwordError.value = null
  confirmError.value = null
})

/** 只校验「非空 + 两次一致」；强度交给服务端。 */
function validate(): boolean {
  passwordError.value = null
  confirmError.value = null
  if (password.value === '') {
    passwordError.value = '请输入新密码。'
    return false
  }
  if (confirmPassword.value === '') {
    confirmError.value = '请再次输入新密码。'
    return false
  }
  if (confirmPassword.value !== password.value) {
    confirmError.value = '两次输入的密码不一致。'
    return false
  }
  return true
}

function passwordFieldErrorOf(caught: unknown): string | null {
  if (!(caught instanceof ApiClientError)) {
    return null
  }
  if (isRecord(caught.details) && caught.details['field'] === 'password') {
    return caught.message
  }
  return caught.statusCode === 400 && caught.message.includes('密码') ? caught.message : null
}

async function submit(): Promise<void> {
  if (saving.value || !validate()) {
    return
  }

  saving.value = true
  try {
    await api.post(`/admin/users/${encodeURIComponent(props.userId)}/password`, {
      password: password.value,
    })
    password.value = ''
    confirmPassword.value = ''
    toast.show('success', '密码已更新，已签发的登录凭据立即失效')
    emit('saved')
  } catch (caught) {
    const message = passwordFieldErrorOf(caught)
    if (message === null) {
      toast.show('error', errorMessageOf(caught))
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
      更新密码后，该用户已签发的登录凭据立即失效；使用 API Key 的 Agent 不受影响。
    </p>

    <div class="field">
      <label class="field__label" :for="passwordId">新密码</label>
      <UiInput
        :id="passwordId"
        v-model="password"
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
        {{ props.submitLabel }}
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
