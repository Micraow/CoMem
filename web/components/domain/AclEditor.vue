<script setup lang="ts">
/**
 * 授权编辑器（权限管理页的右侧）。
 *
 * 三段：节点抬头 + 继承模式、授权列表、添加授权。下方留一个插槽给推导链
 * （`AclChain`）——链与编辑器共享同一份快照，拆成两个组件但由页面把它们放在
 * 同一张卡片里，比让编辑器自己 fetch 更容易保持「改完立即刷新」的一致性。
 *
 * **改 ACL 是不可逆操作**（§12.2 只有 manage 能改，写错就是权限泄露或自锁），
 * 模式切换、添加、撤销都要先弹确认框。确认框里写清「会发生什么」，不是只问
 * 「确定吗」。
 *
 * **`user:*` 是通配主体**：匹配所有 user 主体，`group:*` 不受支持。它和普通主体
 * 的区别必须在输入处就写出来，否则用户会以为它只匹配字面上的 `*`。
 */
import { AlertTriangle, Plus, ShieldAlert, Trash2 } from 'lucide-vue-next'

import type { AclPayload } from '~/composables/useApi'

type AclMode = 'inherit' | 'restricted'
type AclLevel = 1 | 3 | 7
type AclEffect = 'allow' | 'deny'

interface GrantEntry {
  readonly principal: string
  readonly level: AclLevel
  readonly effect: AclEffect
}

type PendingAction =
  | { readonly kind: 'mode'; readonly mode: AclMode }
  | { readonly kind: 'revoke'; readonly principal: string }
  | { readonly kind: 'grant'; readonly entry: GrantEntry }

const props = defineProps<{
  acl: AclPayload | null
  uri: string | null
  loading: boolean
  error: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  refresh: []
  'change-mode': [mode: AclMode]
  grant: [entry: GrantEntry]
  revoke: [principal: string]
}>()

const PREFIX_OPTIONS = [
  { value: 'user', label: 'user:' },
  { value: 'group', label: 'group:' },
] as const

const LEVEL_OPTIONS = [
  { value: '1', label: '读取' },
  { value: '3', label: '写入' },
  { value: '7', label: '管理' },
] as const

const EFFECT_OPTIONS = [
  { value: 'allow', label: '允许' },
  { value: 'deny', label: '拒绝' },
] as const

/** 级别与效果的中文名：界面上只出现用户能做的动作，不出现服务端枚举。 */
const LEVEL_LABEL: Readonly<Record<AclLevel, string>> = {
  1: '读取',
  3: '写入',
  7: '管理',
}

const EFFECT_LABEL: Readonly<Record<AclEffect, string>> = {
  allow: '允许',
  deny: '拒绝',
}

const LEVEL_VARIANT: Readonly<Record<AclLevel, 'gray' | 'teal' | 'blue'>> = {
  1: 'gray',
  3: 'teal',
  7: 'blue',
}

const principalKind = ref<'user' | 'group'>('user')
const principalId = ref('')
const grantLevel = ref<'1' | '3' | '7'>('1')
const grantEffect = ref<'allow' | 'deny'>('allow')
const formError = ref<string | null>(null)

const pendingAction = ref<PendingAction | null>(null)
const confirmOpen = computed({
  get: () => pendingAction.value !== null,
  set: (open: boolean) => {
    if (!open) {
      pendingAction.value = null
    }
  },
})

/**
 * 继承模式的中文标签。`inherit` / `restricted` 是服务端枚举，不直接进界面
 * （AGENTS §11）；界面上只出现「继承父级」与「仅本节点」。
 */
const MODE_LABEL: Readonly<Record<AclMode, string>> = {
  inherit: '继承父级',
  restricted: '仅本节点',
}

const isRestricted = computed(() => props.acl?.mode === 'restricted')

const modeLabel = computed(() => {
  const mode = props.acl?.mode
  return mode === undefined ? '—' : MODE_LABEL[mode]
})

const entries = computed(() => props.acl?.entries ?? [])

const confirmTitle = computed(() => {
  switch (pendingAction.value?.kind) {
    case 'mode':
      return '切换继承模式'
    case 'grant':
      return '添加授权'
    case 'revoke':
      return '撤销授权'
    default:
      return '确认操作'
  }
})

const confirmMessage = computed(() => {
  const action = pendingAction.value
  if (action === null) {
    return ''
  }
  if (action.kind === 'mode') {
    return action.mode === 'restricted'
      ? '切换为「仅本节点」后，这个节点不再继承祖先的授权，所有主体只保留本节点的直接授权。当前沿链生效的权限会立即失效。'
      : '切换为「继承父级」后，祖先链上的授权重新生效，这个节点会继承上游的全部权限。'
  }
  if (action.kind === 'grant') {
    return `将给 ${action.entry.principal} 授予「${LEVEL_LABEL[action.entry.level]}」（${EFFECT_LABEL[action.entry.effect]}）。同一主体只能有一条授权，重复添加会覆盖原来的级别与效果。`
  }
  return `将撤销 ${action.principal} 在这个节点上的直接授权。如果上游也有授权，撤销后仍然继承上游的权限。`
})

function levelOf(value: string): AclLevel {
  return value === '7' ? 7 : value === '3' ? 3 : 1
}

function effectOf(value: string): AclEffect {
  return value === 'deny' ? 'deny' : 'allow'
}

function nameOf(uri: string): string {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

function onModeToggle(restricted: boolean): void {
  const next: AclMode = restricted ? 'restricted' : 'inherit'
  if (next === props.acl?.mode) {
    return
  }
  pendingAction.value = { kind: 'mode', mode: next }
}

function requestRevoke(principal: string): void {
  pendingAction.value = { kind: 'revoke', principal }
}

function requestGrant(): void {
  const id = principalId.value.trim()
  if (id === '') {
    formError.value = '请填写主体标识。'
    return
  }
  if (id.includes(':')) {
    formError.value = '主体标识不能包含冒号，冒号只出现在前缀里。'
    return
  }
  if (principalKind.value === 'group' && id === '*') {
    formError.value = 'group:* 不受支持，通配主体只支持 user:*。'
    return
  }

  formError.value = null
  pendingAction.value = {
    kind: 'grant',
    entry: {
      principal: `${principalKind.value}:${id}`,
      level: levelOf(grantLevel.value),
      effect: effectOf(grantEffect.value),
    },
  }
}

function confirm(): void {
  const action = pendingAction.value
  if (action === null) {
    return
  }
  pendingAction.value = null

  if (action.kind === 'mode') {
    emit('change-mode', action.mode)
    return
  }
  if (action.kind === 'revoke') {
    emit('revoke', action.principal)
    return
  }
  principalId.value = ''
  emit('grant', action.entry)
}
</script>

<template>
  <div class="acl-editor">
    <div v-if="props.uri === null" class="empty">
      <span class="empty__icon">
        <ShieldAlert :size="22" :stroke-width="1.4" />
      </span>
      <span class="empty__title">还没有选择节点</span>
    </div>

    <div v-else-if="props.error !== null" class="empty">
      <span class="empty__icon">
        <ShieldAlert :size="22" :stroke-width="1.4" />
      </span>
      <span class="empty__title">{{ props.error }}</span>
    </div>

    <template v-else>
      <header class="doc-head">
        <div class="doc-head__main">
          <h1 class="doc-title">{{ nameOf(props.uri) }}/</h1>
          <div class="uri">{{ props.uri }}</div>
        </div>
        <div class="mode">
          <span class="caption">切断继承</span>
          <UiSwitch
            :model-value="isRestricted"
            :disabled="props.busy || props.loading"
            aria-label="切断继承"
            @update:model-value="onModeToggle"
          />
          <UiBadge :variant="isRestricted ? 'red' : 'outline'">
            {{ modeLabel }}
          </UiBadge>
        </div>
      </header>

      <div class="callout" :class="isRestricted ? 'callout--danger' : 'callout--info'">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>
          <b>{{ isRestricted ? '仅本节点：继承在这里切断' : '继承父级：沿祖先链累加' }}</b>
          <br>
          {{
            isRestricted
              ? '只使用本节点的直接授权，不继承上游。'
              : '本节点直接授权与祖先链的授权累加。'
          }}
        </div>
      </div>

      <section class="grantlist">
        <div class="sec-head">
          <span class="sec-label">授权列表</span>
          <span class="spacer" />
          <span class="caption">{{ entries.length }} 条直接授权</span>
        </div>

        <UiTable v-if="entries.length > 0" caption="直接授权">
          <thead>
            <tr>
              <th>主体</th>
              <th>级别</th>
              <th>效果</th>
              <th class="num">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.principal">
              <td class="mono strong">{{ entry.principal }}</td>
              <td>
                <UiBadge :variant="LEVEL_VARIANT[entry.level]">
                  {{ LEVEL_LABEL[entry.level] }}
                </UiBadge>
              </td>
              <td>
                <UiBadge :variant="entry.effect === 'deny' ? 'red' : 'green'">
                  {{ EFFECT_LABEL[entry.effect] }}
                </UiBadge>
              </td>
              <td class="num">
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.busy"
                  @click="requestRevoke(entry.principal)"
                >
                  <Trash2 :size="13" :stroke-width="1.5" />
                  撤销
                </UiButton>
              </td>
            </tr>
          </tbody>
        </UiTable>

        <div v-else class="empty empty--inline">
          <span class="empty__title">这个节点没有直接授权</span>
          <span class="empty__text">
            {{
              isRestricted ? '仅本节点且没有直接授权：所有主体都没有权限。' : '权限全部来自祖先链。'
            }}
          </span>
        </div>
      </section>

      <section class="grantbar">
        <div class="sec-head">
          <span class="sec-label">添加授权</span>
          <span class="spacer" />
          <span class="caption">只有「管理」级别能修改 ACL</span>
        </div>

        <div class="grantbar__row">
          <UiSelect v-model="principalKind" :options="PREFIX_OPTIONS" aria-label="主体前缀" />
          <UiInput
            v-model="principalId"
            class="grantbar__id"
            placeholder="用户 ID 或 *"
            aria-label="主体标识"
            size="sm"
          />
          <UiSelect v-model="grantLevel" :options="LEVEL_OPTIONS" aria-label="授权级别" />
          <UiSelect v-model="grantEffect" :options="EFFECT_OPTIONS" aria-label="授权效果" />
          <UiButton variant="secondary" size="sm" :disabled="props.busy" @click="requestGrant">
            <Plus :size="14" :stroke-width="1.8" />
            添加
          </UiButton>
        </div>

        <p class="caption grantbar__hint">user:* 匹配所有用户；同节点上的「拒绝」优先。</p>

        <p v-if="formError !== null" class="grantbar__error">{{ formError }}</p>
      </section>

      <slot />
    </template>

    <UiDialog v-model="confirmOpen" :title="confirmTitle">
      <div class="stack-16">
        <p class="body-sm muted">{{ confirmMessage }}</p>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="confirmOpen = false">取消</UiButton>
          <UiButton variant="primary" :disabled="props.busy" @click="confirm">
            确认
          </UiButton>
        </div>
      </div>
    </UiDialog>
  </div>
</template>

<style scoped>
.acl-editor {
  display: grid;
  gap: 20px;
}

.mode {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.sec-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-2);
  text-transform: uppercase;
}

.grantlist {
  display: grid;
}

.empty--inline {
  padding: 28px 16px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.grantbar {
  display: grid;
  gap: 10px;
}

.grantbar__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.grantbar__id {
  flex: 1;
  min-width: 180px;
}

.grantbar__hint,
.grantbar__error {
  margin: 0;
}

.grantbar__error {
  font-size: 13px;
  color: var(--red-ink);
}
</style>
