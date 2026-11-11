<script setup lang="ts">
/**
 * 控制台根组件。
 *
 * 身份由 `plugins/console-identity.ts` 在应用挂载前解析（`await` 的插件），所以
 * 这里读到的已经是最终状态：要么有身份，要么明确失败，要么认证打开但没有会话，
 * 要么这份安装还没有可登录账号。
 * **身份未知时不渲染任何页面**——服务端会按 401 拒绝，让页面先渲染再报错只会把
 * 「配置没生效」变成一片「请求失败」。
 *
 * 登录页与初始化页不套外壳：没有身份时连侧栏都不该出现，否则用户会以为登录后
 * 还能用那些导航。单用户模式（`auth.enabled: false`）永远不会进入这两个分支。
 */
import { consoleIdentityState } from '~/composables/consoleIdentity'

const state = consoleIdentityState()

const failureMessage = state.status === 'failed' ? state.message : null
/** 没有外壳的页面：登录页与初始化页。 */
const shellless = state.status === 'unauthenticated' || state.status === 'setup-required'
const emptyScopesSubject =
  state.status === 'ready' && state.identity.scopes.length === 0 ? state.identity.subject : null

function retry(): void {
  window.location.reload()
}
</script>

<template>
  <div v-if="failureMessage !== null" class="bootstrap" role="alert">
    <h1 class="bootstrap__title">控制台无法确定当前身份</h1>
    <p class="bootstrap__text">{{ failureMessage }}</p>
    <p class="bootstrap__text">控制台不会在没有身份的情况下发送请求。</p>
    <button type="button" class="btn btn--primary" @click="retry">重试</button>
  </div>

  <NuxtPage v-else-if="shellless" />

  <div v-else-if="state.status === 'pending'" class="bootstrap" aria-busy="true" />

  <div v-else-if="emptyScopesSubject !== null" class="bootstrap">
    <h1 class="bootstrap__title">当前主体没有可访问的命名空间</h1>
    <p class="bootstrap__text">
      当前主体是 {{ emptyScopesSubject }}，但它没有任何可读的根。请检查该主体在用户目录里的状态，
      以及根目录的权限。
    </p>
  </div>

  <NuxtLayout v-else>
    <NuxtPage />
  </NuxtLayout>
</template>

<style scoped>
.bootstrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-3);
  max-width: 56ch;
  margin: 18vh auto 0;
  padding: 0 var(--s-6);
}

.bootstrap__title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.018em;
}

.bootstrap__text {
  color: var(--label-2);
}
</style>
