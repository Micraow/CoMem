<script setup lang="ts">
/**
 * 用户与组（架构文档 §16 的第五页、§12 的权限模型、§14 的 `/admin/*`）。
 *
 * ## 这一页为什么是「说明」而不是「列表」
 *
 * v1 没有用户表，也没有组成员表：主体是 `user:{uid}` / `group:{gid}` 字符串，身份由
 * 反向代理通过 `x-comem-subject` 注入，服务端不做认证。五个 `/admin/*` 端点全部返回
 * 501 `NOT_IMPLEMENTED`（`src/api/http/routes/admin.ts` 有完整理由）。
 *
 * 从 `node_permission` 反查能拼出一份「出现过的主体」，但它**不是用户目录**——只包含
 * 被显式授权过的节点，没授权过的用户与组不出现，组员关系根本推不出来。拿它冒充用户
 * 管理界面，会得到一份看起来完整、实际是权限副产物的清单。所以这里不显示任何列表，
 * 也不显示「暂时没有用户」这种假装查过的空态。
 *
 * 页面仍然正常渲染三个区块（用户 / 组 / 组成员）：布局是承诺，说明是当前状态。
 * 等用户表与组成员表落地时，只需要把每个区块的空态换成列表。
 */
import { AlertTriangle, Info, Shield, Users } from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, useApi } from '~/composables/useApi'

useHead({ title: '用户与组 · CoMem 控制台' })

/** v1 的用户与组端点的状态。`unexpected` 是「没拿到 501」——它不该发生。 */
type AdminState = 'loading' | 'not-implemented' | 'unexpected' | 'error'

const api = useApi()

const state = ref<AdminState>('loading')
const error = ref<string | null>(null)

async function load(): Promise<void> {
  state.value = 'loading'
  error.value = null

  try {
    await Promise.all([api.get('/admin/users'), api.get('/admin/groups')])
    // 两个 GET 都成功：说明用户表与组表已经落地，而控制台还没有列表视图。
    // 不拿空数组冒充「没有用户」——那会把「没实现」读成「查过了，确实是空的」。
    state.value = 'unexpected'
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.statusCode === 501) {
      state.value = 'not-implemented'
      return
    }
    error.value = errorMessageOf(caught)
    state.value = 'error'
  }
}

onMounted(load)
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader
        title="用户与组"
        description="用户列表、组列表与组成员维护。"
      >
        <template #actions>
          <UiButton variant="secondary" size="sm" :disabled="state === 'loading'" @click="load">
            重新检查
          </UiButton>
        </template>
      </DomainPageHeader>

      <div v-if="state === 'error'" class="callout callout--danger mb-24">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>{{ error }}</div>
      </div>

      <div v-else-if="state === 'loading'" class="stack-16 mb-24">
        <UiSkeleton width="46%" height="18px" />
        <UiSkeleton width="86%" height="14px" />
        <UiSkeleton width="72%" height="14px" />
      </div>

      <section v-else-if="state === 'not-implemented'" class="unavailable mb-24" aria-live="polite">
        <div class="unavailable__head">
          <Info :size="16" :stroke-width="1.4" />
          <h2 class="unavailable__title">用户与组管理尚未实现</h2>
        </div>

        <p class="unavailable__text">
          v1 是单用户部署：身份由反向代理通过 <code>x-comem-subject</code> 头注入，
          服务端不做认证。用户表与组表要等多租户支持，那是 v1 之后的事。
        </p>

        <p class="unavailable__text">
          现在能用的：ACL 页面可以给 <code>user:*</code> / <code>group:*</code> 主体授权。
        </p>

        <div class="unavailable__foot">
          <NuxtLink to="/acl" class="btn btn--primary btn--sm">去权限管理</NuxtLink>
        </div>
      </section>

      <div v-else class="callout callout--warn mb-24">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>
          <b>接口返回了未预期的结果。</b>
          用户与组端点现在应当返回 501，但这次没有。控制台还没有实现这两个列表的视图，
          在补上之前不会显示任何数据。
        </div>
      </div>

      <div class="stack-16">
        <UiCard title="用户列表">
          <template #actions>
            <span class="caption">主体 <span class="mono">user:&lt;uid&gt;</span></span>
          </template>
          <div class="section-empty">
            <span class="section-empty__icon"><Users :size="18" :stroke-width="1.4" /></span>
            <div class="section-empty__body">
              <span class="section-empty__title">没有用户目录</span>
              <span class="section-empty__text">
                身份由反向代理注入，服务端不落用户表。用户从哪来取决于代理的认证配置，
                控制台读不到。
              </span>
            </div>
          </div>
        </UiCard>

        <UiCard title="组列表">
          <template #actions>
            <span class="caption">主体 <span class="mono">group:&lt;gid&gt;</span></span>
          </template>
          <div class="section-empty">
            <span class="section-empty__icon"><Shield :size="18" :stroke-width="1.4" /></span>
            <div class="section-empty__body">
              <span class="section-empty__title">没有组表</span>
              <span class="section-empty__text">
                组只作为授权主体存在，组的有效权限来自节点上的授权条目。没有独立的组实体，
                也就没有「全部组」这一份清单。
              </span>
            </div>
          </div>
        </UiCard>

        <UiCard title="组成员">
          <template #actions>
            <span class="caption">成员关系不落库</span>
          </template>
          <div class="section-empty">
            <span class="section-empty__icon"><Info :size="18" :stroke-width="1.4" /></span>
            <div class="section-empty__body">
              <span class="section-empty__title">成员关系没有存储</span>
              <span class="section-empty__text">
                成员由身份提供方展开，「退组立即生效」靠的正是服务端不保存成员列表。
                要维护成员关系，先要有组实体。
              </span>
            </div>
          </div>
        </UiCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unavailable {
  display: grid;
  gap: 12px;
  padding: 20px 22px;
  border-radius: var(--r-panel);
  background: var(--accent-tint-2);
  box-shadow: inset 0 0 0 0.5px rgba(10, 132, 255, 0.24);
}

.unavailable__head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--accent-ink);
}

.unavailable__title {
  font-size: 17px;
  font-weight: 590;
  letter-spacing: -0.011em;
  color: var(--label);
}

.unavailable__text {
  font-size: 14px;
  line-height: 1.58;
  color: var(--label-2);
  max-width: 68ch;
}

.unavailable__text code {
  font-family: var(--mono);
  font-size: 13px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--fill-2);
  color: var(--label);
}

.unavailable__foot {
  padding-top: 4px;
}

.section-empty {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 0 4px;
}

.section-empty__icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: none;
  border-radius: var(--r-sm);
  background: var(--fill-2);
  color: var(--label-3);
}

.section-empty__body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.section-empty__title {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
  color: var(--label);
}

.section-empty__text {
  font-size: 14px;
  line-height: 1.55;
  color: var(--label-3);
  max-width: 62ch;
}
</style>
