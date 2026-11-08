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
 */
import { AlertTriangle, Copy, KeyRound, Plus, Trash2 } from 'lucide-vue-next'

import { errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

/** `GET /admin/users/{id}/api-keys` 的行。`lastUsedAt` 目前没有出口，有就显示。 */
interface ApiKeyPayload {
  readonly id: string
  readonly userId: string
  readonly prefix: string
  readonly name: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt?: string | null
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

const hasLastUsed = computed(() => keys.value.some((key) => key.lastUsedAt != null))

function formatTime(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) {
    return iso
  }
  return time.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

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
  try {
    await navigator.clipboard.writeText(text)
    toast.show('success', `已复制${label}`)
  } catch {
    toast.show('error', '浏览器拒绝写入剪贴板，请手动选择复制。')
  }
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

    <div v-if="error !== null" class="callout callout--danger">
      <AlertTriangle :size="15" :stroke-width="1.4" />
      <div>{{ error }}</div>
    </div>

    <div v-else-if="loading && keys.length === 0" class="skeleton-block">
      <UiSkeleton v-for="index in 4" :key="index" :width="`${72 - index * 8}%`" height="14px" />
    </div>

    <UiTable v-else-if="keys.length > 0" caption="API Key 列表">
      <thead>
        <tr>
          <th>名称</th>
          <th>前缀</th>
          <th>创建时间</th>
          <th v-if="hasLastUsed">最后使用</th>
          <th>状态</th>
          <th class="num">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="key in keys" :key="key.id">
          <td class="strong">{{ key.name }}</td>
          <td class="mono">comem_{{ key.prefix }}_…</td>
          <td>
            <time class="mono" :title="formatTime(key.createdAt)">
              {{ formatTime(key.createdAt) }}
            </time>
          </td>
          <td v-if="hasLastUsed" class="mono">
            {{ key.lastUsedAt == null ? '—' : formatTime(key.lastUsedAt) }}
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

    <div v-else class="empty">
      <span class="empty__icon">
        <KeyRound :size="20" :stroke-width="1.4" />
      </span>
      <span class="empty__title">还没有 API Key</span>
      <span class="empty__text">API Key 用来让 Agent 接入，创建后请立即保存。</span>
    </div>

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
        <div class="callout callout--info">
          <KeyRound :size="15" :stroke-width="1.4" />
          <div>完整 key 只显示这一次，关闭后只能看到前缀。</div>
        </div>
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
