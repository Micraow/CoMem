<script setup lang="ts">
/**
 * API Key 管理（架构文档 §12.7、§14 的 `/admin/users/{id}/api-keys`）。
 *
 * 明文 key 只出现在创建响应里一次：列表只回 `prefix`，哈希永不出现在任何响应。
 * 界面因此把「创建成功」做成一个独立状态——关掉之后只剩前缀，这是服务端的
 * 契约，不是界面偷懒。
 *
 * 撤销是二次确认：一把 key 就是那个用户的完整凭据，撤销后使用它的 Agent 立刻
 * 无法接入。
 *
 * ## 为什么没有「最后使用」列
 *
 * `api_key` 表里没有使用时间列，`ApiKeyRepository` 的读方法也不返回这个字段
 * （`src/adapters/sqlite/api-key-repository.ts`）。服务端从未记录过它，不是
 * 「记了但没出口」——补一列空值只会把「从不展示」变成「永远显示 —」。
 */
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-vue-next'

import { errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { CLIPBOARD_DENIED_MESSAGE, copyToClipboard } from '~/utils/clipboard'
import { formatDateTime } from '~/utils/format'

/** `GET /admin/users/{id}/api-keys` 的行。 */
interface ApiKeyPayload {
  readonly id: string
  readonly userId: string
  readonly prefix: string
  readonly name: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
}

interface KeyListPayload {
  readonly keys: readonly ApiKeyPayload[]
}

/** `POST` 的响应：唯一一次带明文 `key`。 */
interface CreatedKeyPayload {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly key: string
}

type KeyStatus = {
  readonly label: string
  readonly variant: 'green' | 'orange' | 'red'
}

const props = defineProps<{ userId: string }>()

const api = useApi()
const toast = useToast()

const keys = ref<readonly ApiKeyPayload[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const createOpen = ref(false)
const name = ref('')
const creating = ref(false)
const created = ref<CreatedKeyPayload | null>(null)

const revokeTarget = ref<ApiKeyPayload | null>(null)
const revokeOpen = computed({
  get: () => revokeTarget.value !== null,
  set: (open: boolean) => {
    if (!open) {
      revokeTarget.value = null
    }
  },
})
const revoking = ref(false)

function statusOf(key: ApiKeyPayload): KeyStatus {
  if (key.revokedAt !== null) {
    return { label: '已撤销', variant: 'red' }
  }
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now()) {
    return { label: '已过期', variant: 'orange' }
  }
  return { label: '有效', variant: 'green' }
}

function keysPath(): string {
  return `/admin/users/${encodeURIComponent(props.userId)}/api-keys`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const payload = await api.get<KeyListPayload>(keysPath())
    keys.value = payload.keys
  } catch (caught) {
    error.value = errorMessageOf(caught)
    keys.value = []
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  name.value = ''
  created.value = null
  createOpen.value = true
}

function closeCreate(): void {
  createOpen.value = false
  created.value = null
  name.value = ''
}

async function createKey(): Promise<void> {
  const trimmed = name.value.trim()
  if (trimmed === '' || creating.value) {
    return
  }

  creating.value = true
  try {
    created.value = await api.post<CreatedKeyPayload>(keysPath(), { name: trimmed })
    await load()
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    creating.value = false
  }
}

async function copyText(text: string, label: string): Promise<void> {
  if (!(await copyToClipboard(text))) {
    toast.show('error', CLIPBOARD_DENIED_MESSAGE)
    return
  }
  toast.show('success', `已复制${label}`)
}

async function revoke(): Promise<void> {
  const target = revokeTarget.value
  if (target === null || revoking.value) {
    return
  }

  revoking.value = true
  try {
    await api.del(`/admin/api-keys/${encodeURIComponent(target.id)}`)
    toast.show('success', `已撤销 ${target.name} 的 API Key`)
    revokeTarget.value = null
    await load()
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    revoking.value = false
  }
}

watch(() => props.userId, load, { immediate: true })

// 关闭对话框就丢掉明文：它不是「列表里的一个字段」，只该在创建成功的那一屏存在。
watch(createOpen, (open) => {
  if (!open) {
    created.value = null
    name.value = ''
  }
})
</script>

<template>
  <div class="stack-16">
    <div class="rowflex">
      <span class="caption">共 {{ keys.length }} 个</span>
      <span class="spacer" />
      <UiButton variant="secondary" size="sm" @click="openCreate">
        <Plus :size="14" :stroke-width="1.8" />
        新建 API Key
      </UiButton>
    </div>

    <UiErrorCallout v-if="error !== null" :message="error" />

    <div v-else-if="loading && keys.length === 0" class="skeleton-block">
      <UiSkeleton v-for="index in 4" :key="index" :width="`${72 - index * 8}%`" height="14px" />
    </div>

    <UiTable v-else-if="keys.length > 0" caption="API Key 列表">
      <thead>
        <tr>
          <th>名称</th>
          <th>前缀</th>
          <th>创建时间</th>
          <th>状态</th>
          <th class="num">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="key in keys" :key="key.id">
          <td class="strong">{{ key.name }}</td>
          <td class="mono">comem_{{ key.prefix }}_…</td>
          <td>
            <time class="mono" :title="formatDateTime(key.createdAt)">
              {{ formatDateTime(key.createdAt) }}
            </time>
          </td>
          <td>
            <UiBadge :variant="statusOf(key).variant">{{ statusOf(key).label }}</UiBadge>
          </td>
          <td class="num">
            <UiButton
              v-if="key.revokedAt === null"
              variant="plain"
              size="sm"
              :disabled="loading || revoking"
              @click="revokeTarget = key"
            >
              <Trash2 :size="13" :stroke-width="1.5" />
              撤销
            </UiButton>
            <span v-else class="faint">—</span>
          </td>
        </tr>
      </tbody>
    </UiTable>

    <UiEmpty v-else v-slot="{ size }" title="还没有 API Key" text="API Key 用来让 Agent 接入，创建后请立即保存。">
      <KeyRound :size="size" :stroke-width="1.4" />
    </UiEmpty>

    <UiDialog
      v-model="createOpen"
      :title="created === null ? '新建 API Key' : 'API Key 已创建'"
    >
      <div v-if="created === null" class="stack-16">
        <label class="field">
          <span class="field__label">名称</span>
          <UiInput
            v-model="name"
            placeholder="例如：ci"
            aria-label="API Key 名称"
            :disabled="creating"
          />
        </label>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" :disabled="creating" @click="closeCreate">取消</UiButton>
          <UiButton
            variant="primary"
            :disabled="creating || name.trim() === ''"
            @click="createKey"
          >
            创建
          </UiButton>
        </div>
      </div>

      <div v-else class="stack-16">
        <UiCallout tone="info">
          <template #icon><KeyRound :size="15" :stroke-width="1.4" /></template>
          <div>完整 key 只显示这一次，关闭后只能看到前缀。</div>
        </UiCallout>
        <code class="key">{{ created.key }}</code>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="copyText(created.key, ' API Key')">
            <Copy :size="14" :stroke-width="1.5" />
            复制
          </UiButton>
          <UiButton variant="primary" @click="closeCreate">关闭</UiButton>
        </div>
      </div>
    </UiDialog>

    <UiDialog v-model="revokeOpen" title="撤销 API Key">
      <div class="stack-16">
        <p class="body-sm muted">
          撤销 {{ revokeTarget?.name }}（comem_{{ revokeTarget?.prefix }}_…）？使用这把 key 的
          Agent 会立即无法接入，此操作无法撤销。
        </p>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" :disabled="revoking" @click="revokeTarget = null">
            取消
          </UiButton>
          <UiButton variant="danger" :disabled="revoking" @click="revoke">撤销</UiButton>
        </div>
      </div>
    </UiDialog>
  </div>
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

.key {
  display: block;
  padding: 12px;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
