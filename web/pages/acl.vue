<script setup lang="ts">
/**
 * 权限管理（架构文档 §16 的第四页、§12）。
 *
 * 左树右编辑器，编辑器下方是自根向下的推导链。
 *
 * **文件不单独设 ACL**（§12.1 的 `assertDirectory`）：选中文件时编辑器显示它所在
 * 目录的规则，并在顶部说明这一点——静默换成父目录的授权，会让人以为改的是文件
 * 自己的权限。
 *
 * **逐级读 ACL。** 推导链的每一级都来自 `GET /acl`，`effective` 由服务端求值。
 * 前端只做「把 `effective[subject]` 的最大级别显示出来」，不重算 §12.2 的三条
 * 规则：owner 恒 manage、同节点 deny 优先、restricted 切断继承，任何一条抄错的
 * 结果都是「界面说能读、服务端说不能」。
 *
 * 链上有节点读不到（manage 不足）时保留这一级的错误，不跳过——跳过等于伪造
 * 「这一级没有授权」。
 */
import { AlertTriangle, ShieldX } from 'lucide-vue-next'

import {
  ApiClientError,
  DEFAULT_SUBJECT,
  errorMessageOf,
  useApi,
  type AclPayload,
  type FsStatPayload,
} from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import type { AclChainLevel } from '~/components/domain/AclChain.vue'

useHead({ title: '权限管理 · CoMem 控制台' })

type AclMode = 'inherit' | 'restricted'
type AclLevel = 1 | 3 | 7
type AclEffect = 'allow' | 'deny'

const api = useApi()
const scopeRoot = useScopeRoot()
const toast = useToast()

const selectedUri = ref<string | null>(null)
const selectedKind = ref<'file' | 'directory' | null>(null)

const acl = ref<AclPayload | null>(null)
const levels = ref<readonly AclChainLevel[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

/** 文件的有效权限来自最近的目录祖先。 */
const aclUri = computed<string | null>(() => {
  const uri = selectedUri.value
  if (uri === null) {
    return null
  }
  if (selectedKind.value === 'file') {
    return parentOf(uri)
  }
  return uri
})

function parentOf(uri: string): string {
  const index = uri.lastIndexOf('/')
  return index <= 0 ? uri : uri.slice(0, index)
}

/** 根 → 目标节点的全部目录 URI（含两端）。 */
function chainUrisOf(uri: string): readonly string[] {
  const root = scopeRoot.value.replace(/\/+$/, '')
  if (!uri.startsWith(root)) {
    return [uri]
  }

  const uris: string[] = [root]
  let current = root
  for (const segment of uri.slice(root.length).split('/')) {
    if (segment === '') {
      continue
    }
    current = `${current}/${segment}`
    uris.push(current)
  }
  return uris
}

function permissionMessageOf(caught: unknown): string {
  if (
    caught instanceof ApiClientError &&
    (caught.code === 'PERMISSION_DENIED' || caught.statusCode === 403)
  ) {
    return '你没有权限查看这个节点'
  }
  return errorMessageOf(caught)
}

async function loadChain(uri: string): Promise<void> {
  const chain: AclChainLevel[] = []
  let selected: AclPayload | null = null

  for (const chainUri of chainUrisOf(uri)) {
    try {
      const payload = await api.get<AclPayload>('/acl', { uri: chainUri })
      chain.push({ uri: chainUri, snapshot: payload, error: null })
      if (chainUri === uri) {
        selected = payload
      }
    } catch (caught) {
      chain.push({ uri: chainUri, snapshot: null, error: errorMessageOf(caught) })
      if (chainUri === uri) {
        error.value = permissionMessageOf(caught)
      }
    }
  }

  levels.value = chain
  acl.value = selected
}

async function reload(): Promise<void> {
  const uri = aclUri.value
  if (uri === null) {
    return
  }
  error.value = null
  await loadChain(uri)
}

async function selectNode(uri: string): Promise<void> {
  selectedUri.value = uri
  selectedKind.value = null
  acl.value = null
  levels.value = []
  error.value = null
  loading.value = true

  try {
    const payload = await api.get<FsStatPayload>('/fs/stat', { uri })
    if (payload.stat === null) {
      error.value = `节点不存在或已被删除：${uri}`
      return
    }
    selectedKind.value = payload.stat.kind

    const target = payload.stat.kind === 'directory' ? uri : parentOf(uri)
    await loadChain(target)
  } catch (caught) {
    error.value = permissionMessageOf(caught)
  } finally {
    loading.value = false
  }
}

async function mutate(work: () => Promise<void>, success: string): Promise<void> {
  busy.value = true
  try {
    await work()
    toast.show('success', success)
    await reload()
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    busy.value = false
  }
}

async function changeMode(mode: AclMode): Promise<void> {
  const uri = aclUri.value
  if (uri === null) {
    return
  }
  const entries = (acl.value?.entries ?? []).map((entry) => ({
    principal: entry.principal,
    level: entry.level,
    effect: entry.effect,
  }))

  await mutate(async () => {
    await api.put<unknown>('/acl', { uri, mode, entries })
  }, mode === 'restricted' ? '已切断继承' : '已恢复继承')
}

async function grant(entry: {
  readonly principal: string
  readonly level: AclLevel
  readonly effect: AclEffect
}): Promise<void> {
  const uri = aclUri.value
  if (uri === null) {
    return
  }

  await mutate(async () => {
    await api.post<unknown>('/acl/grant', {
      uri,
      principal: entry.principal,
      level: entry.level,
      effect: entry.effect,
    })
  }, `已添加 ${entry.principal}`)
}

async function revoke(principal: string): Promise<void> {
  const uri = aclUri.value
  if (uri === null) {
    return
  }

  await mutate(async () => {
    await api.post<unknown>('/acl/revoke', { uri, principal })
  }, `已撤销 ${principal}`)
}
</script>

<template>
  <div class="content content--split">
    <div class="split">
      <DomainFileTree :selected="selectedUri" @select="selectNode" />

      <section class="split__main" aria-live="polite">
        <div class="doc-pane">
          <div class="doc-pane__inner">
            <div v-if="selectedKind === 'file'" class="callout callout--info mb-16">
              <AlertTriangle :size="15" :stroke-width="1.4" />
              <div>文件本身不单独设权限，这里显示它所在目录的规则。</div>
            </div>

            <DomainAclEditor
              :acl="acl"
              :uri="aclUri"
              :loading="loading"
              :error="error"
              :busy="busy"
              @refresh="reload"
              @change-mode="changeMode"
              @grant="grant"
              @revoke="revoke"
            >
              <section v-if="acl !== null && error === null">
                <div class="sec-head">
                  <span class="sec-label">有效权限推导</span>
                  <span class="spacer" />
                  <ShieldX :size="14" :stroke-width="1.4" class="sec-icon" aria-hidden="true" />
                </div>
                <DomainAclChain :levels="levels" :subject="DEFAULT_SUBJECT" :loading="loading" />
              </section>
            </DomainAclEditor>
          </div>
        </div>
      </section>
    </div>

    <UiToast />
  </div>
</template>

<style scoped>
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

.sec-icon {
  color: var(--label-4);
}
</style>
