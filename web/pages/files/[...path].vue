<script setup lang="ts">
/**
 * 文件树（架构文档 §16 的重点页）。
 *
 * 左树右详情；详情分 L0 摘要 / L1 概览 / L2 原文三档，默认 L0。
 *
 * 三档按需加载：切到哪一档才请求哪一档，已经取过的留在内存里，来回切不重复请求。
 * 目录没有 L2 正文，第三档展示它的直接子项——「读一个目录的原文」没有定义，
 * 编一段拼接文本比列目录更容易误导。
 *
 * 文档没有 L1 概览：`GET /content/overview` 对 document 恒返回 `overview: null`，
 * 前端也没有对应的合成逻辑（服务端注释里的 `skeletonOverview` 在 `web/` 里不存在）。
 * 挂一个永远空的「概览」档比不挂更糟，所以文档只保留 L0 / L2；目录的 L1 是真实
 * 的 `.overview` 摘要，照常展示。
 *
 * 右栏的摘要来源与新鲜度只展示服务端真的有的字段：单节点的生成时间、模型、
 * 版本当前没有出口，界面写「未知」而不是拿全站数字冒充单节点状态。
 *
 * ## 摘要失败不连坐正文
 *
 * `/fs/stat` 与 `/content/abstract` 对同一 URI 都是读权限，摘要取不到不代表节点
 * 读不了。两个请求各自处理结果：摘要失败只在摘要区说明，元信息与正文照常渲染；
 * 只有 stat 失败（节点不存在、读不了）才整页失败。
 */
import { AlertTriangle, Copy, FolderOpen, Info } from 'lucide-vue-next'

import {
  errorMessageOf,
  useApi,
  type AclPayload,
  type ContentReadPayload,
  type FsStatPayload,
  type HealthPayload,
  type SummaryLayerPayload,
  type TreeEntryPayload,
} from '~/composables/useApi'
import { formatBytes } from '~/composables/useTree'

useHead({ title: '文件树 · CoMem 控制台' })

type Layer = 'l0' | 'l1' | 'l2'

const URI_PREFIX = 'comem://'

const layerTabs = [
  { value: 'l0', lead: 'L0', label: '摘要' },
  { value: 'l1', lead: 'L1', label: '概览' },
  { value: 'l2', lead: 'L2', label: '原文' },
] as const

const LAYER_NOTE: Readonly<Record<Layer, string>> = {
  l0: '一句话摘要，256 字符以内。',
  l1: '目录级上下文，4000 字符以内。',
  l2: '完整正文；目录列出直接子项。',
}

const route = useRoute()
const router = useRouter()
const api = useApi()
const scopeRoot = useScopeRoot()

const segments = computed<readonly string[]>(() => {
  const raw = route.params.path
  if (Array.isArray(raw)) {
    return raw.filter((segment) => segment !== '')
  }
  return typeof raw === 'string' && raw !== '' ? [raw] : []
})

const selectedUri = computed<string | null>(() =>
  segments.value.length === 0 ? null : `${URI_PREFIX}${segments.value.join('/')}`,
)

const documentName = computed(() => segments.value.at(-1) ?? '')

const health = useState<HealthPayload | null>('comem-health', () => null)

const stat = ref<FsStatPayload['stat']>(null)
const abstractText = ref<string | null>(null)
/** 摘要请求失败：与「这个节点还没有摘要」分开，前者不是数据状态。 */
const abstractFailed = ref(false)
const overviewText = ref<string | null>(null)
const contentText = ref<string | null>(null)
const children = ref<readonly TreeEntryPayload[] | null>(null)
const degraded = ref(false)
const acl = ref<AclPayload | null>(null)
const aclError = ref<string | null>(null)
/** 权限读自哪个目录：文件本身不能设 ACL（§12.1），读父目录。 */
const aclScope = ref<string | null>(null)

/** 文件的有效权限来自父目录；等于当前节点时不显示「继承自」。 */
const aclInheritedFrom = computed(() =>
  aclScope.value !== null && aclScope.value !== selectedUri.value ? aclScope.value : null,
)

const layer = ref<Layer>('l0')
const loadedLayers = ref<ReadonlySet<Layer>>(new Set())

const loading = ref(false)
const layerLoading = ref(false)
const error = ref<string | null>(null)
const layerError = ref<string | null>(null)
const copied = ref(false)

let copiedTimer: ReturnType<typeof setTimeout> | undefined

const isDirectory = computed(() => stat.value?.kind === 'directory')

/**
 * 文档没有 L1 概览（服务端恒返回 null，前端没有合成逻辑），这一档不展示。
 *
 * 只按 `stat.kind` 判断：目录的概览来自 `.abstract.md` 对应的摘要文件，是真实数据。
 */
const visibleLayerTabs = computed(() =>
  isDirectory.value ? layerTabs : layerTabs.filter((tab) => tab.value !== 'l1'),
)

async function loadHealth(): Promise<void> {
  try {
    health.value = await api.get<HealthPayload>('/health')
  } catch {
    // 新鲜度拿不到就显示「未知」：这里不是页面的主数据，没必要挡住整页。
  }
}

async function loadAcl(uri: string): Promise<void> {
  try {
    acl.value = await api.get<AclPayload>('/acl', { uri })
  } catch (caught) {
    aclError.value = errorMessageOf(caught)
  }
}

async function loadNode(uri: string): Promise<void> {
  loading.value = true
  error.value = null
  layerError.value = null
  stat.value = null
  abstractText.value = null
  abstractFailed.value = false
  overviewText.value = null
  contentText.value = null
  children.value = null
  acl.value = null
  aclError.value = null
  aclScope.value = null
  degraded.value = false
  layer.value = 'l0'
  loadedLayers.value = new Set<Layer>(['l0'])

  try {
    const statPayload = await api.get<FsStatPayload>('/fs/stat', { uri })
    stat.value = statPayload.stat

    if (statPayload.stat === null) {
      error.value = `节点不存在或已被删除：${uri}`
      return
    }

    if (health.value === null) {
      void loadHealth()
    }

    // ACL 只能设在目录上：文件的有效权限来自最近的目录祖先。
    const aclUri =
      statPayload.stat.kind === 'directory' ? uri : uri.slice(0, uri.lastIndexOf('/'))
    aclScope.value = aclUri
    void loadAcl(aclUri)

    // 摘要单独取、单独报错：失败时 `abstractFailed` 置位，`error` 保持 null。
    await loadAbstract(uri)
  } catch (caught) {
    error.value = errorMessageOf(caught)
  } finally {
    loading.value = false
  }
}

async function loadAbstract(uri: string): Promise<void> {
  try {
    const payload = await api.get<SummaryLayerPayload>('/content/abstract', { uri })
    abstractText.value = payload.abstract ?? null
    degraded.value = payload.degraded
  } catch {
    abstractFailed.value = true
  }
}

async function loadLayer(): Promise<void> {
  const uri = selectedUri.value
  if (uri === null || loadedLayers.value.has(layer.value)) {
    return
  }

  layerLoading.value = true
  layerError.value = null

  try {
    if (layer.value === 'l1') {
      const payload = await api.get<SummaryLayerPayload>('/content/overview', { uri })
      overviewText.value = payload.overview ?? null
    } else if (layer.value === 'l2') {
      if (isDirectory.value) {
        const payload = await api.get<{ uri: string; entries: readonly TreeEntryPayload[] }>(
          '/fs/ls',
          { uri },
        )
        children.value = payload.entries
      } else {
        const payload = await api.get<ContentReadPayload>('/content/read', { uri })
        contentText.value = payload.text
      }
    }

    loadedLayers.value = new Set<Layer>([...loadedLayers.value, layer.value])
  } catch (caught) {
    layerError.value = errorMessageOf(caught)
  } finally {
    layerLoading.value = false
  }
}

function selectNode(uri: string): void {
  const relative = uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri
  const encoded = relative
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  void router.push(`/files/${encoded}`)
}

async function copyUri(): Promise<void> {
  const uri = selectedUri.value
  if (uri === null) {
    return
  }
  try {
    await navigator.clipboard.writeText(uri)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    // 浏览器拒绝写剪贴板（非安全上下文）：不弹假成功提示。
    copied.value = false
  }
}

watch(
  selectedUri,
  (uri) => {
    if (uri === null) {
      return
    }
    void loadNode(uri)
  },
  { immediate: true },
)

watch(layer, () => {
  void loadLayer()
})

// 作用域切换后详情里的节点可能已经不在新根下：回文件树入口，不显示一个不属于
// 当前作用域的地址。
watch(scopeRoot, (root) => {
  const uri = selectedUri.value
  if (uri === null || uri === root || uri.startsWith(`${root}/`)) {
    return
  }
  void router.replace('/files')
})

onBeforeUnmount(() => {
  clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="content content--split">
    <div class="split">
      <DomainFileTree :selected="selectedUri" @select="selectNode" />

      <section class="split__main" aria-live="polite">
        <div v-if="selectedUri === null" class="empty">
          <span class="empty__icon">
            <FolderOpen :size="22" :stroke-width="1.4" />
          </span>
          <span class="empty__title">还没有选择文件</span>
        </div>

        <div v-else class="doc-pane">
          <div class="doc-pane__inner">
            <div class="crumb mb-12">
              <NuxtLink to="/">comem://</NuxtLink>
              <span class="current">{{ segments.join('/') }}</span>
            </div>

            <div class="doc-head">
              <div class="doc-head__main">
                <h1 class="doc-title">
                  {{ isDirectory ? `${documentName}/` : documentName }}
                </h1>
                <div class="uri">{{ selectedUri }}</div>
              </div>
              <UiButton variant="secondary" size="sm" @click="copyUri">
                <Copy :size="14" :stroke-width="1.4" />
                {{ copied ? '已复制' : '复制 URI' }}
              </UiButton>
            </div>

            <div class="doc-pills mb-20">
              <UiBadge variant="gray">{{ isDirectory ? '目录' : '文档' }}</UiBadge>
              <UiBadge v-if="degraded" variant="orange">摘要降级</UiBadge>
            </div>

            <div v-if="error !== null" class="callout callout--danger">
              <AlertTriangle :size="15" :stroke-width="1.4" />
              <div>{{ error }}</div>
            </div>

            <div v-else class="detail-grid">
              <div>
                <UiTabs v-model="layer" :items="visibleLayerTabs" aria-label="披露层级" />

                <div class="layer-note">
                  <Info :size="15" :stroke-width="1.4" />
                  <span>{{ LAYER_NOTE[layer] }}</span>
                </div>

                <div v-if="layerError !== null" class="callout callout--danger">
                  <AlertTriangle :size="15" :stroke-width="1.4" />
                  <div>{{ layerError }}</div>
                </div>

                <div v-else-if="loading || layerLoading" class="skeleton-block" aria-busy="true">
                  <UiSkeleton width="42%" height="14px" />
                  <UiSkeleton width="94%" height="18px" />
                  <UiSkeleton width="88%" height="18px" />
                  <UiSkeleton width="64%" height="18px" />
                </div>

                <template v-else-if="layer === 'l0'">
                  <div v-if="abstractText !== null" class="abstract">
                    <div class="abstract__meta">
                      <span class="leveltag" data-level="0">
                        <span class="strata"><i /><i /><i /></span>
                        <b>L0</b>
                      </span>
                      <span>摘要</span>
                      <span class="faint">·</span>
                      <span>{{ degraded ? '规则生成' : '模型生成' }}</span>
                    </div>
                    <p class="abstract__quote">{{ abstractText }}</p>
                    <div class="abstract__foot">
                      <span>{{ abstractText.length }} 字符</span>
                    </div>
                  </div>
                  <div v-else-if="abstractFailed" class="empty">
                    <span class="empty__title">摘要没有取到</span>
                  </div>
                  <div v-else class="empty">
                    <span class="empty__title">还没有摘要</span>
                  </div>
                </template>

                <template v-else-if="layer === 'l1'">
                  <pre v-if="overviewText !== null" class="doc-raw">{{ overviewText }}</pre>
                  <div v-else class="empty">
                    <span class="empty__title">还没有概览</span>
                  </div>
                </template>

                <template v-else>
                  <template v-if="isDirectory">
                    <UiTable v-if="children !== null && children.length > 0" caption="目录直接子项">
                      <thead>
                        <tr>
                          <th>名称</th>
                          <th>类型</th>
                          <th class="num">大小</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="child in children" :key="child.uri">
                          <td class="mono strong">
                            {{ child.kind === 'directory' ? `${child.name}/` : child.name }}
                          </td>
                          <td>{{ child.kind === 'directory' ? '目录' : '文档' }}</td>
                          <td class="num mono">
                            {{ child.kind === 'directory' ? child.size : formatBytes(child.size) }}
                          </td>
                        </tr>
                      </tbody>
                    </UiTable>
                    <div v-else class="empty">
                      <span class="empty__title">这个目录是空的</span>
                    </div>
                  </template>

                  <template v-else>
                    <pre v-if="contentText !== null && contentText !== ''" class="doc-raw">{{ contentText }}</pre>
                    <div v-else class="empty">
                      <span class="empty__title">这个文件是空的</span>
                    </div>
                  </template>
                </template>
              </div>

              <DomainSummaryPanel
                :stat="stat"
                :abstract="abstractText"
                :degraded="degraded"
                :freshness="health?.summary ?? null"
                :acl="acl"
                :acl-error="aclError"
                :acl-inherited-from="aclInheritedFrom"
                :loading="loading"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
