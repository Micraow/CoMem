<script setup lang="ts">
/**
 * 用户详情（架构文档 §16 的用户与组页）。
 *
 * 用户表只列「谁能登录」；凭据与密码属于详情，放在抽屉里。两个 tab 都是安全相关
 * 操作：API Key 是 Agent 的接入凭据，密码是登录凭据，改密码会轮换身份版本让已
 * 签发的 session 立即失效。
 */
import { KeyRound, LockKeyhole } from 'lucide-vue-next'

import type { UserRowPayload } from '~/components/domain/UserTable.vue'
import { errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

const model = defineModel<boolean>({ default: false })
const props = defineProps<{ user: UserRowPayload | null }>()

type Tab = 'api-keys' | 'password'

const TABS = [
  { value: 'api-keys', label: 'API Key' },
  { value: 'password', label: '密码' },
] as const

const api = useApi()
const toast = useToast()

const tab = ref<Tab>('api-keys')
const password = ref('')
const settingPassword = ref(false)

const title = computed(() => (props.user === null ? '用户详情' : `用户 ${props.user.id}`))

watch(model, (open) => {
  if (open) {
    tab.value = 'api-keys'
    password.value = ''
  }
})

async function setPassword(): Promise<void> {
  const user = props.user
  if (user === null || password.value === '' || settingPassword.value) {
    return
  }

  settingPassword.value = true
  try {
    await api.post(`/admin/users/${encodeURIComponent(user.id)}/password`, {
      password: password.value,
    })
    password.value = ''
    toast.show('success', '密码已更新，已签发的登录凭据立即失效')
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    settingPassword.value = false
  }
}
</script>

<template>
  <UiDialog v-model="model" placement="left" :title="title">
    <div v-if="props.user !== null" class="stack-16">
      <div class="user-summary">
        <div class="user-summary__name">{{ props.user.displayName }}</div>
        <div class="user-summary__meta">
          <span class="mono">{{ props.user.id }}</span>
          <span v-if="props.user.email !== null && props.user.email !== ''">
            · {{ props.user.email }}
          </span>
        </div>
      </div>

      <UiTabs v-model="tab" :items="TABS" aria-label="用户详情" />

      <DomainApiKeyPanel v-if="tab === 'api-keys'" :user-id="props.user.id" />

      <form v-else class="stack-16" @submit.prevent="setPassword">
        <p class="body-sm muted">
          更新密码后，该用户已签发的登录凭据立即失效；使用 API Key 的 Agent 不受影响。
        </p>
        <label class="field">
          <span class="field__label">新密码</span>
          <UiInput
            v-model="password"
            type="password"
            autocomplete="new-password"
            aria-label="新密码"
            :disabled="settingPassword"
          />
        </label>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton
            variant="primary"
            type="submit"
            :disabled="settingPassword || password === ''"
          >
            <LockKeyhole :size="14" :stroke-width="1.5" />
            设置密码
          </UiButton>
        </div>
      </form>
    </div>
  </UiDialog>
</template>

<style scoped>
.user-summary {
  display: grid;
  gap: 2px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid var(--separator);
}

.user-summary__name {
  font-size: 17px;
  font-weight: 590;
  letter-spacing: -0.011em;
}

.user-summary__meta {
  color: var(--label-2);
  font-size: 13px;
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
