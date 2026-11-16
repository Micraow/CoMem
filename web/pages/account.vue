<script setup lang="ts">
/**
 * 我的账户：当前会话的身份、自助改密码与个人 API Key。
 *
 * 系统角色来自 `GET /auth/me` 的 `isAdmin`，身份引导阶段已经取到并放进
 * `ConsoleIdentity`。页面不根据页面是否 403、配置文件名或用户名猜测角色。
 *
 * 节点级授权仍在权限管理中查看；这里只保留一个入口，不重复解释权限模型。
 */
import { ArrowRight, Layers3, ShieldCheck } from 'lucide-vue-next'

import { clearConsoleSession } from '~/composables/consoleAuth'
import {
  consoleIdentityState,
  setConsoleIdentityUnauthenticated,
} from '~/composables/consoleIdentity'

useHead({ title: '我的账户 · CoMem 控制台' })

const state = consoleIdentityState()
const identity = state.status === 'ready' ? state.identity : null

const currentUserId = computed(() => {
  const subject = identity?.subject ?? ''
  return subject.startsWith('user:') ? subject.slice('user:'.length) : ''
})

const subjectInitial = computed(() => {
  const first = currentUserId.value.charAt(0)
  return first === '' ? '?' : first.toUpperCase()
})

const isAdmin = computed(() => identity?.isAdmin === true)
const roleLabel = computed(() => (isAdmin.value ? '系统管理员' : '普通用户'))

const passwordChanged = ref(false)

function onPasswordChanged(): void {
  passwordChanged.value = true
  clearConsoleSession()
  setConsoleIdentityUnauthenticated()
}

function relogin(): void {
  window.location.assign('/login?redirect=%2Faccount')
}
</script>

<template>
  <div class="content">
    <div class="page account-page">
      <template v-if="passwordChanged">
        <DomainPageHeader title="密码已更新" />
        <UiCard panel>
          <div class="changed">
            <span class="changed__icon" aria-hidden="true">
              <ShieldCheck :size="24" :stroke-width="1.5" />
            </span>
            <div class="changed__copy">
              <h2>请使用新密码重新登录</h2>
              <p>当前登录会话已经失效。API Key 不受影响。</p>
            </div>
            <UiButton variant="primary" @click="relogin">
              重新登录
              <ArrowRight :size="15" :stroke-width="1.7" />
            </UiButton>
          </div>
        </UiCard>
      </template>

      <template v-else>
        <DomainPageHeader title="我的账户">
          <template v-if="isAdmin" #actions>
            <NuxtLink to="/admin" class="header-link">
              用户与组
              <ArrowRight :size="14" :stroke-width="1.6" />
            </NuxtLink>
          </template>
        </DomainPageHeader>

        <section class="identity-card" aria-labelledby="account-identity-title">
          <div class="identity-card__avatar" aria-hidden="true">{{ subjectInitial }}</div>
          <div class="identity-card__copy">
            <h2 id="account-identity-title" class="identity-card__name">{{ currentUserId || '当前账户' }}</h2>
            <UiBadge :variant="isAdmin ? 'green' : 'gray'">{{ roleLabel }}</UiBadge>
          </div>
        </section>

        <div class="account-grid">
          <UiCard title="登录密码" panel>
            <DomainUserPasswordForm
              v-if="currentUserId !== ''"
              mode="self"
              :user-id="currentUserId"
              @saved="onPasswordChanged"
            />
          </UiCard>

          <UiCard title="API Keys" panel>
            <DomainApiKeyPanel v-if="currentUserId !== ''" :user-id="currentUserId" />
          </UiCard>
        </div>

        <section class="permissions-card" aria-labelledby="account-permissions-title">
          <span class="permissions-card__icon" aria-hidden="true">
            <Layers3 :size="20" :stroke-width="1.45" />
          </span>
          <div>
            <h2 id="account-permissions-title">数据权限</h2>
          </div>
          <NuxtLink to="/acl" class="permissions-card__link">
            查看节点权限
            <ArrowRight :size="15" :stroke-width="1.6" />
          </NuxtLink>
        </section>
      </template>

      <UiToast />
    </div>
  </div>
</template>

<style scoped>
.account-page {
  max-width: 1060px;
}

.header-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair), var(--inset-top);
  color: var(--label);
  font-size: 14px;
  font-weight: 580;
}

.header-link:hover {
  background: var(--fill-3);
  text-decoration: none;
}

.identity-card {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 20px;
  overflow: hidden;
  padding: 26px 28px;
  border-radius: var(--r-panel);
  background:
    radial-gradient(520px 220px at -8% -40%, var(--accent-tint-2), transparent 70%),
    linear-gradient(135deg, var(--surface-2), var(--surface));
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.identity-card::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(120deg, rgba(255, 255, 255, 0.05), transparent 36%);
}

.identity-card__avatar {
  position: relative;
  z-index: 1;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 17px;
  background: var(--accent-fill);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 0.5px 0 rgba(255, 255, 255, 0.34);
  color: #fff;
  font-size: 22px;
  font-weight: 680;
}

.identity-card__copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.identity-card__name {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.account-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.88fr) minmax(0, 1.12fr);
  gap: 20px;
  align-items: start;
  margin-top: 20px;
}

.account-grid > :deep(.card) {
  min-width: 0;
}

.permissions-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  padding: 22px 24px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair), var(--shadow-card);
}

.permissions-card__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  background: var(--purple-tint);
  color: var(--purple-ink);
}

.permissions-card h2 {
  font-size: 17px;
  font-weight: 620;
  letter-spacing: -0.011em;
}

.permissions-card__link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: var(--r-control);
  color: var(--accent-ink);
  font-size: 14px;
  font-weight: 590;
  white-space: nowrap;
}

.permissions-card__link:hover {
  background: var(--accent-tint-2);
  text-decoration: none;
}

.changed {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
}

.changed__icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  background: var(--green-tint);
  color: var(--green-ink);
}

.changed__copy {
  display: grid;
  gap: 5px;
}

.changed__copy h2 {
  font-size: 20px;
  font-weight: 630;
  letter-spacing: -0.016em;
}

.changed__copy p {
  color: var(--label-2);
  font-size: 14px;
}

@media (max-width: 900px) {
  .account-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .permissions-card,
  .changed {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .permissions-card__link,
  .changed :deep(.btn) {
    grid-column: 2;
    justify-self: start;
  }
}

@media (max-width: 600px) {
  .identity-card {
    grid-template-columns: auto minmax(0, 1fr);
    padding: 22px;
  }

  .permissions-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .permissions-card__link {
    grid-column: 1;
  }
}
</style>
