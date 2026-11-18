<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  errorMessageOf,
  forbiddenMessageOf,
  useApi,
  type AclCapabilities,
  type AclPayload,
  type FsStatPayload,
} from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import type { AclEffect, AclLevel, AclMode } from '~/utils/aclLabels'
import { workspaceParentUriOf } from '~/utils/workspacePath'

interface GrantEntry {
  readonly principal: string
  readonly level: AclLevel
  readonly effect: AclEffect
}

const model = defineModel<boolean>({ default: false })

const props = defineProps<{
  uri: string | null
  kind: 'file' | 'directory' | null
}>()

const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const toast = useToast()

const acl = ref<AclPayload | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const capability = ref<AclCapabilities | null>(null)

const aclUri = computed(() => {
  if (props.uri === null) {
    return null
  }
  return props.kind === 'file' ? workspaceParentUriOf(props.uri) : props.uri
})

const inherited = computed(
  () => props.kind === 'file' && aclUri.value !== null && aclUri.value !== props.uri,
)

async function load(): Promise<void> {
  const uri = aclUri.value
  if (uri === null) {
    acl.value = null
    return
  }

  loading.value = true
  error.value = null
  try {
    const stat = await api.get<FsStatPayload>('/fs/stat', { uri: props.uri ?? uri })
    capability.value = stat.capabilities ?? null
    if (capability.value?.manage === false) {
      acl.value = null
      error.value = '没有管理这个位置访问设置的权限。'
      return
    }

    const payload = await api.get<AclPayload>('/acl', { uri })
    acl.value = payload
    if (payload.capabilities !== undefined) {
      capability.value = payload.capabilities
    }
  } catch (caught) {
    acl.value = null
    error.value = forbiddenMessageOf(caught, '你没有权限查看这个位置的访问设置')
  } finally {
    loading.value = false
  }
}

async function mutate(action: () => Promise<unknown>, success: string): Promise<void> {
  if (busy.value || capability.value?.manage !== true) {
    return
  }
  busy.value = true
  error.value = null
  try {
    await action()
    await load()
    emit('changed')
    toast.show('success', success)
  } catch (caught) {
    error.value = errorMessageOf(caught)
  } finally {
    busy.value = false
  }
}

function changeMode(mode: AclMode): void {
  const uri = aclUri.value
  const current = acl.value
  if (uri === null || current === null) {
    return
  }
  void mutate(
    () => api.put('/acl', { uri, mode, entries: current.entries }),
    mode === 'restricted' ? '已改为仅本节点' : '已恢复继承父级',
  )
}

function grant(entry: GrantEntry): void {
  const uri = aclUri.value
  if (uri === null) {
    return
  }
  void mutate(
    () =>
      api.post('/acl/grant', {
        uri,
        principal: entry.principal,
        level: entry.level,
        effect: entry.effect,
      }),
    `已添加 ${entry.principal}`,
  )
}

function revoke(principal: string): void {
  const uri = aclUri.value
  if (uri === null) {
    return
  }
  void mutate(
    () => api.post('/acl/revoke', { uri, principal }),
    `已撤销 ${principal}`,
  )
}

watch(
  [model, aclUri],
  ([open]) => {
    if (open) {
      void load()
    }
  },
  { immediate: true },
)
</script>

<template>
  <UiDialog v-model="model" title="共享与访问">
    <div class="share">
      <div v-if="inherited && aclUri !== null" class="inheritance">
        <span>继承自</span>
        <span class="mono">{{ aclUri }}</span>
      </div>

      <DomainAclEditor
        :acl="acl"
        :uri="aclUri"
        :loading="loading"
        :error="error"
        :busy="busy"
        :capability="capability"
        @refresh="load"
        @change-mode="changeMode"
        @grant="grant"
        @revoke="revoke"
      />
    </div>
  </UiDialog>
</template>

<style scoped>
.share {
  display: grid;
  gap: 14px;
}

.inheritance {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--fill-2);
  color: var(--label-3);
  font-size: 12px;
}

.inheritance .mono {
  overflow: hidden;
  color: var(--label-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
