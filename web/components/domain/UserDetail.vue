<script setup lang="ts">
/**
 * 用户详情（架构文档 §16 的用户与组页）。
 *
 * 用户表只列「谁能登录」；凭据属于详情，放在抽屉里。两个 tab 都是安全相关操作：
 * API Key 是 Agent 的接入凭据，密码是登录凭据，改密码会轮换身份版本让已签发的
 * session 立即失效。
 *
 * ## 密码表单不在这里写第二套
 *
 * 「密码」页签与用户表行内的「设密码」是同一个动作，表单由
 * `UserPasswordForm.vue` 提供。改密码成功后抛 `password-saved`，让父页面刷新
 * 列表里的密码状态徽章。
 */
import type { UserRowPayload } from '~/components/domain/UserTable.vue'

const model = defineModel<boolean>({ default: false })
const props = defineProps<{ user: UserRowPayload | null }>()

const emit = defineEmits<{
  'password-saved': []
}>()

type Tab = 'api-keys' | 'password'

const TABS = [
  { value: 'api-keys', label: 'API Key' },
  { value: 'password', label: '密码' },
] as const

const tab = ref<Tab>('api-keys')

const title = computed(() => (props.user === null ? '用户详情' : `用户 ${props.user.id}`))

watch(model, (open) => {
  if (open) {
    tab.value = 'api-keys'
  }
})
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

      <DomainUserPasswordForm
        v-else
        :user-id="props.user.id"
        @saved="emit('password-saved')"
      />
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
</style>
