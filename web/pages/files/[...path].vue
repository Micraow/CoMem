<script setup lang="ts">
/**
 * 文件树（架构文档 §16 的重点页）。
 *
 * 三栏工作区：空间与根目录、当前目录列表、节点详情。详情分 L0 摘要 /
 * L1 概览 / L2 原文三档，默认 L0。
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
 * ## 记忆节点显示检索资格
 *
 * `memories/` 下的文件另外取一次 `GET /memories/{uri}`：记忆类型、状态、有效期与
 * 「能否被检索」。后者由状态推导——检索只返回 `active` 节点，`pending` 与
 * `archived` 在 `find` / `search` / `glob` 里都被过滤掉。这份元数据与摘要、关联边
 * 各自独立失败，取不到只影响「记忆」区块。
 *
 * ## 摘要失败不连坐正文
 *
 * `/fs/stat` 与 `/content/abstract` 对同一 URI 都是读权限，摘要取不到不代表节点
 * 读不了。两个请求各自处理结果：摘要失败只在摘要区说明，元信息与正文照常渲染；
 * 只有 stat 失败（节点不存在、读不了）才整页失败。
 */
import {
  AlertTriangle,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Shield,
  Trash2,
} from 'lucide-vue-next'
import { useDebounceFn } from '@vueuse/core'

import {
  errorMessageOf,
  forbiddenMessageOf,
  selectScopeRoot,
  useApi,
  type AclCapabilities,
  type AclPayload,
  type ContentReadPayload,
  type FsListPayload,
  type FsStatPayload,
  type HealthPayload,
  type MemoryLinkPayload,
  type MemoryLinksPayload,
  type MemoryMetaPayload,
  type SummaryLayerPayload,
  type TreeEntryPayload,
} from '~/composables/useApi'
import {
  consoleIdentityState,
  consoleScopeLabel,
  refreshConsoleIdentity,
  subscribeConsoleIdentity,
} from '~/composables/consoleIdentity'
import { useToast } from '~/composables/useToast'
import type {
  WorkspaceSearchScope,
} from '~/components/domain/WorkspaceBrowser.vue'
import type {
  WorkspaceActionMode,
} from '~/components/domain/WorkspaceActionDialog.vue'
import type {
  SearchFindPayload,
  SearchHitPayload,
} from '~/components/domain/HitList.vue'
import { copyToClipboard } from '~/utils/clipboard'
import { fileRouteOf } from '~/utils/fileRoute'
import { formatBytes } from '~/utils/format'
import { fsEntryDisplayName, fsEntryKindLabel, type FsEntryKind } from '~/utils/fsLabels'
import {
  LEVEL_OF_TAB,
  LEVEL_TABS,
  LEVEL_TAB_LABEL,
  type LevelTab,
} from '~/utils/levelLabels'
import { isMemoryUri, linkRowsOf, type LinkRow } from '~/utils/memoryLinks'
import {
  archiveMessagesDirectoryOf,
  summarySourceLabelOf,
  type SummarySource,
} from '~/utils/summarySource'
import {
  workspaceBreadcrumbs,
  workspaceChildUri,
  workspaceContainingRootOf,
  workspaceCopyNameOf,
  workspaceNameOf,
  workspaceParentUriOf,
} from '~/utils/workspacePath'

useHead({ title: '文件树 · CoMem 控制台' })

const URI_PREFIX = 'comem://'

/** 三档页签由 `utils/levelLabels.ts` 的清单生成：少一档或加一档都是编译错误。 */
const layerTabs = LEVEL_TABS.map((tab) => ({
  value: tab,
  lead: LEVEL_OF_TAB[tab],
  label: LEVEL_TAB_LABEL[tab],
}))

const route = useRoute()
const router = useRouter()
const api = useApi()
const toast = useToast()
const scopeRoot = useScopeRoot()
const identityState = ref(consoleIdentityState())
const identity = computed(() =>
  identityState.value.status === 'ready' ? identityState.value.identity : null,
)
const unsubscribeIdentity = subscribeConsoleIdentity((next) => {
  identityState.value = next
})

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
const scopeOptions = computed(() =>
  (identity.value?.spaces ?? []).length > 0
    ? (identity.value?.spaces ?? []).map((space) => ({
        uri: space.scope,
        label: space.displayName,
        kind: space.kind,
      }))
    : (identity.value?.scopes ?? []).map((scope) => ({
        uri: scope,
        label: consoleScopeLabel(scope, identity.value?.subject ?? ''),
        kind: scope.startsWith(`${URI_PREFIX}group/`)
          ? ('group' as const)
          : ('personal' as const),
      })),
)
const currentScopeLabel = computed(() => {
  const currentIdentity = identity.value
  if (currentIdentity === null || scopeRoot.value === '') {
    return '当前空间'
  }
  return (
    currentIdentity.spaces?.find((space) => space.scope === scopeRoot.value)?.displayName ??
    consoleScopeLabel(scopeRoot.value, currentIdentity.subject)
  )
})
const sharedFolders = computed(() =>
  (identity.value?.sharedFolders ?? []).map((folder) => ({
    uri: folder.uri,
    label: folder.displayName,
  })),
)
const selectedNavigationRoot = computed(() =>
  selectedUri.value === null
    ? null
    : workspaceContainingRootOf(
        selectedUri.value,
        [...scopeOptions.value, ...sharedFolders.value].map((place) => place.uri),
      ),
)
const navigationRootUri = computed(() => selectedNavigationRoot.value ?? scopeRoot.value)
const navigationRootLabel = computed(() => {
  const root = navigationRootUri.value
  return (
    [...scopeOptions.value, ...sharedFolders.value].find((place) => place.uri === root)?.label ??
    currentScopeLabel.value
  )
})

const health = useState<HealthPayload | null>('comem-health', () => null)

const stat = ref<FsStatPayload['stat']>(null)
const selectedKindHint = ref<FsEntryKind | null>(null)
const nodeCapabilities = ref<AclCapabilities | null>(null)
const browserEntries = ref<readonly TreeEntryPayload[] | null>(null)
const browserCapabilities = ref<AclCapabilities | null>(null)
const rootEntries = ref<readonly TreeEntryPayload[] | null>(null)
const browserLoading = ref(false)
const browserError = ref<string | null>(null)
const rootEntriesLoading = ref(false)
const searchQuery = ref('')
const searchScope = ref<WorkspaceSearchScope>('folder')
const searchHits = ref<readonly SearchHitPayload[] | null>(null)
const searching = ref(false)
const searchError = ref<string | null>(null)
let browserRequest = 0
let rootEntriesRequest = 0
let searchRequest = 0
let nodeRequest = 0
let layerRequest = 0
/** 节点还没取到（加载中 / 不存在）时为 null，不冒充「文档」。 */
const entryKind = computed<FsEntryKind | null>(() => stat.value?.kind ?? null)
const documentTitle = computed(() => {
  if (selectedUri.value === null) {
    return currentScopeLabel.value
  }
  const name = segments.value.at(-1) ?? ''
  const kind = entryKind.value
  return kind === null ? name : fsEntryDisplayName(kind, name)
})
const entryKindLabel = computed(() => {
  const kind = entryKind.value
  return kind === null ? null : fsEntryKindLabel(kind)
})
const abstractText = ref<string | null>(null)
const abstractSource = ref<SummarySource | null>(null)
/** 摘要请求失败：与「这个节点还没有摘要」分开，前者不是数据状态。 */
const abstractFailed = ref(false)
/** 已同时经路径、目录 stat 和目录摘要确认的会话归档目录。 */
const archiveSummaryUri = ref<string | null>(null)
const overviewText = ref<string | null>(null)
const contentText = ref<string | null>(null)
const children = ref<readonly TreeEntryPayload[] | null>(null)
const degraded = ref(false)
const acl = ref<AclPayload | null>(null)
const aclError = ref<string | null>(null)
/** 权限读自哪个目录：文件本身不能设 ACL（§12.1），读父目录。 */
const aclScope = ref<string | null>(null)

/**
 * 中央列表跟随目录；选中文件时仍显示文件的父目录。
 * 详情在没有路由选择时展示当前空间根，因此 `/files` 也能直接进入可用工作区。
 */
const currentDirectoryUri = computed(() => {
  if (selectedUri.value === null) {
    return scopeRoot.value
  }
  const kind = entryKind.value ?? selectedKindHint.value
  if (kind === 'file') {
    return workspaceParentUriOf(selectedUri.value) ?? scopeRoot.value
  }
  if (kind === 'directory') {
    return selectedUri.value
  }
  // 直接打开一个不在已知空间里的共享目录时，先等 `/fs/stat` 确认类型。
  // 这里若猜父目录，会对无权访问的祖先发一次 `GET /fs/ls`，在控制台留下
  // 一个与最终结果无关的 403；文件随后仍会通过 `entryKind` 切到真实父目录。
  return ''
})

const detailUri = computed(() => selectedUri.value ?? scopeRoot.value)
const isSpaceRoot = computed(() => scopeOptions.value.some(({ uri }) => uri === detailUri.value))
const canCopySelected = computed(() =>
  nodeCapabilities.value?.read === true &&
  currentDirectoryUri.value === workspaceParentUriOf(detailUri.value) &&
  browserCapabilities.value?.write === true,
)
const currentDirectoryTitle = computed(() =>
  currentDirectoryUri.value === navigationRootUri.value
    ? navigationRootLabel.value
    : workspaceNameOf(currentDirectoryUri.value),
)
const rootFolders = computed(() =>
  (rootEntries.value ?? []).filter((entry) => entry.kind === 'directory'),
)
const crumbs = computed(() =>
  workspaceBreadcrumbs(
    navigationRootUri.value,
    currentDirectoryUri.value,
    navigationRootLabel.value,
  ),
)
const canGoUp = computed(() => {
  const current = currentDirectoryUri.value.replace(/\/+$/u, '')
  const root = navigationRootUri.value.replace(/\/+$/u, '')
  return current !== root && current.startsWith(`${root}/`)
})

/**
 * 关联边（仅 `memories/` 下的节点）。
 *
 * 两个方向分开存、共用一条错误：取反向边失败时正向边仍然要显示，但失败本身要
 * 看得出来——静默空区块会让人把「读不到」当成「没有关联」。
 */
const memoryLinks = ref<readonly MemoryLinkPayload[]>([])
const memoryBacklinks = ref<readonly MemoryLinkPayload[]>([])
const linksError = ref<string | null>(null)

/**
 * 记忆元数据（仅 `memories/` 下的文件）。
 *
 * 与摘要、关联边一样的独立失败域：取不到只影响右栏的「记忆」区块，正文与权限
 * 照常显示。`null` 表示还没取到或这个节点不是可解析的记忆，界面按「未知」处理。
 */
const memoryMeta = ref<MemoryMetaPayload | null>(null)
const memoryMetaError = ref<string | null>(null)

/** 文件的有效权限来自父目录；等于当前节点时不显示「继承自」。 */
const aclInheritedFrom = computed(() =>
  aclScope.value !== null && aclScope.value !== detailUri.value ? aclScope.value : null,
)

const layer = ref<LevelTab>('l0')
const loadedLayers = ref<ReadonlySet<LevelTab>>(new Set())

const loading = ref(false)
const layerLoading = ref(false)
const error = ref<string | null>(null)
const layerError = ref<string | null>(null)
const copied = ref(false)
const actionOpen = ref(false)
const actionMode = ref<WorkspaceActionMode>('directory')
const actionInitial = ref('')
const actionBusy = ref(false)
const actionError = ref<string | null>(null)
const deleteOpen = ref(false)
const deleteBusy = ref(false)
const deleteError = ref<string | null>(null)
const shareOpen = ref(false)
const editorOpen = ref(false)
const createMemoryOpen = ref(false)

let copiedTimer: ReturnType<typeof setTimeout> | undefined

const isDirectory = computed(() => entryKind.value === 'directory')

/**
 * 文档没有 L1 概览（服务端恒返回 null，前端没有合成逻辑），这一档不展示。
 *
 * 只按 `stat.kind` 判断：目录的概览来自 `.abstract.md` 对应的摘要文件，是真实数据。
 */
const visibleLayerTabs = computed(() =>
  isDirectory.value ? layerTabs : layerTabs.filter((tab) => tab.value !== 'l1'),
)
const abstractSourceLabel = computed(() => summarySourceLabelOf(abstractSource.value))

/**
 * 只有 `memories/` 下的节点有关联边（判据见 `~/utils/memoryLinks`）：普通文件
 * 不请求，也不显示一个「不适用」的空区块。
 */
const isMemoryNode = computed(() => isMemoryUri(detailUri.value))

/**
 * 右栏「记忆」区块的显示条件：`memories/` 下的**文件**。
 *
 * 目录（例如 `memories/rules`）也是记忆路径，但没有一条记忆的元数据；给它一个
 * 「未知」区块只会让人以为状态读不出来。
 */
const memoryMetaEnabled = computed(() => isMemoryNode.value && entryKind.value === 'file')

const outgoingRows = computed<readonly LinkRow[]>(() => linkRowsOf(memoryLinks.value, 'links'))
const backlinkRows = computed<readonly LinkRow[]>(() =>
  linkRowsOf(memoryBacklinks.value, 'backlinks'),
)

async function loadHealth(): Promise<void> {
  try {
    health.value = await api.get<HealthPayload>('/health')
  } catch {
    // 新鲜度拿不到就显示「未知」：这里不是页面的主数据，没必要挡住整页。
  }
}

async function refreshWorkspaceIdentity(): Promise<void> {
  const config = useRuntimeConfig()
  try {
    const next = await refreshConsoleIdentity(
      String(config.public.apiBase),
      (url, init) => fetch(url, init),
    )
    if (next.status !== 'ready') {
      return
    }
    const firstScope = next.identity.scopes[0]
    if (firstScope !== undefined && !next.identity.scopes.includes(scopeRoot.value)) {
      selectScopeRoot(firstScope)
      await router.replace('/files')
    }
  } catch {
    // 保留进入页面前的可用空间；一次刷新失败不应把已打开的文件工作区清空。
  }
}

async function loadAcl(uri: string, request: number): Promise<void> {
  try {
    const payload = await api.get<AclPayload>('/acl', { uri })
    if (request === nodeRequest && aclScope.value === uri) {
      acl.value = payload
    }
  } catch (caught) {
    if (request === nodeRequest && aclScope.value === uri) {
      aclError.value = errorMessageOf(caught)
    }
  }
}

async function loadDirectory(uri: string): Promise<void> {
  const request = ++browserRequest
  browserLoading.value = true
  browserError.value = null

  try {
    const payload = await api.get<FsListPayload>('/fs/ls', { uri })
    if (request !== browserRequest || currentDirectoryUri.value !== uri) {
      return
    }
    browserEntries.value = payload.entries
    browserCapabilities.value = payload.capabilities ?? null
    if (uri.replace(/\/+$/u, '') === scopeRoot.value.replace(/\/+$/u, '')) {
      rootEntries.value = payload.entries
    }
  } catch (caught) {
    if (request !== browserRequest || currentDirectoryUri.value !== uri) {
      return
    }
    browserEntries.value = null
    browserCapabilities.value = null
    browserError.value = errorMessageOf(caught)
  } finally {
    if (request === browserRequest) {
      browserLoading.value = false
    }
  }
}

async function loadRootEntries(): Promise<void> {
  const root = scopeRoot.value
  if (root === '') {
    return
  }
  const request = ++rootEntriesRequest
  rootEntriesLoading.value = true
  try {
    const payload = await api.get<FsListPayload>('/fs/ls', { uri: root })
    if (request === rootEntriesRequest && scopeRoot.value === root) {
      rootEntries.value = payload.entries
    }
  } catch {
    // The main listing reports errors when navigating to the space root.
  } finally {
    if (request === rootEntriesRequest) {
      rootEntriesLoading.value = false
    }
  }
}

async function refreshWorkspace(): Promise<void> {
  const directory = currentDirectoryUri.value
  await Promise.all([
    directory === '' ? Promise.resolve() : loadDirectory(directory),
    loadRootEntries(),
    refreshWorkspaceIdentity(),
  ])
  await loadNode(detailUri.value)
}

async function runWorkspaceSearch(): Promise<void> {
  const query = searchQuery.value.trim()
  const request = ++searchRequest
  if (query === '') {
    searchHits.value = null
    searchError.value = null
    searching.value = false
    return
  }

  searching.value = true
  searchError.value = null
  try {
    const scopes =
      searchScope.value === 'folder'
        ? [currentDirectoryUri.value]
        : searchScope.value === 'space'
          ? [navigationRootUri.value]
          : undefined
    const body: {
      query: string
      limit: number
      scopes?: readonly string[]
    } = { query, limit: 30 }
    if (scopes !== undefined) {
      body.scopes = scopes
    }
    const payload = await api.post<SearchFindPayload>('/search/find', body)
    if (request === searchRequest) {
      searchHits.value = payload.hits
    }
  } catch (caught) {
    if (request === searchRequest) {
      searchHits.value = null
      searchError.value = errorMessageOf(caught)
    }
  } finally {
    if (request === searchRequest) {
      searching.value = false
    }
  }
}

const scheduleWorkspaceSearch = useDebounceFn(() => {
  void runWorkspaceSearch()
}, 300)

function openUri(uri: string): void {
  void router.push(fileRouteOf(uri))
}

async function showCreatedMemory(uri: string): Promise<void> {
  await loadDirectory(currentDirectoryUri.value)
  openUri(uri)
}

function openSharedFolder(uri: string): void {
  selectedKindHint.value = 'directory'
  openUri(uri)
}

function goUp(): void {
  const parent = workspaceParentUriOf(currentDirectoryUri.value)
  if (parent === null) {
    return
  }
  if (parent.replace(/\/+$/u, '') === navigationRootUri.value.replace(/\/+$/u, '')) {
    if (navigationRootUri.value !== scopeRoot.value) {
      openUri(navigationRootUri.value)
    } else {
      void router.push('/files')
    }
    return
  }
  openUri(parent)
}

function changeScope(scope: string): void {
  if (scope === scopeRoot.value) {
    void router.push('/files')
    return
  }
  selectScopeRoot(scope)
  void router.replace('/files')
}

/**
 * 关联边两个方向一起取。
 *
 * 与摘要/正文完全独立的失败域：这里失败只置 `linksError`，不碰 `error` /
 * `abstractFailed` / `layerError`。两个请求各自结算，一条成功一条失败时成功的
 * 那半仍然显示，同时把失败说出来。
 */
async function loadLinks(uri: string, request: number): Promise<void> {
  memoryLinks.value = []
  memoryBacklinks.value = []
  linksError.value = null

  if (!isMemoryUri(uri)) {
    return
  }

  const path = `/memories/${encodeURIComponent(uri)}/links`
  const [outgoing, incoming] = await Promise.allSettled([
    api.get<MemoryLinksPayload>(path, { direction: 'links' }),
    api.get<MemoryLinksPayload>(path, { direction: 'backlinks' }),
  ])

  // 切换节点后迟到的响应属于上一个节点，丢弃。
  if (request !== nodeRequest || detailUri.value !== uri) {
    return
  }

  if (outgoing.status === 'fulfilled') {
    memoryLinks.value = outgoing.value.links
  }
  if (incoming.status === 'fulfilled') {
    memoryBacklinks.value = incoming.value.links
  }
  const failure =
    outgoing.status === 'rejected'
      ? outgoing
      : incoming.status === 'rejected'
        ? incoming
        : null
  if (failure !== null) {
    linksError.value = errorMessageOf(failure.reason)
  }
}

/**
 * 单条记忆的元数据。
 *
 * 路径形状与关联边相同：URI 作为路径参数，逐段 `encodeURIComponent`（`comem://`
 * 里的 `:` 与 `/` 不编码会被 Fastify 当成多段路径）。权限与正文同一档。
 *
 * 403 换成用户能读懂的那句；其它失败保留服务端消息，那是排查依据。切换节点后
 * 迟到的响应属于上一个节点，直接丢弃。
 */
async function loadMemoryMeta(uri: string, request: number): Promise<void> {
  try {
    const payload = await api.get<MemoryMetaPayload>(`/memories/${encodeURIComponent(uri)}`)
    if (request === nodeRequest && detailUri.value === uri) {
      memoryMeta.value = payload
    }
  } catch (caught) {
    if (request === nodeRequest && detailUri.value === uri) {
      memoryMetaError.value = forbiddenMessageOf(caught, '你没有权限查看这条记忆的状态')
    }
  }
}

async function loadNode(uri: string): Promise<void> {
  const request = ++nodeRequest
  layerRequest += 1
  loading.value = true
  error.value = null
  layerError.value = null
  stat.value = null
  nodeCapabilities.value = null
  abstractText.value = null
  abstractSource.value = null
  abstractFailed.value = false
  archiveSummaryUri.value = null
  overviewText.value = null
  contentText.value = null
  children.value = null
  acl.value = null
  aclError.value = null
  aclScope.value = null
  memoryLinks.value = []
  memoryBacklinks.value = []
  linksError.value = null
  memoryMeta.value = null
  memoryMetaError.value = null
  degraded.value = false
  layer.value = 'l0'
  loadedLayers.value = new Set<LevelTab>(['l0'])
  layerLoading.value = false

  try {
    const statPayload = await api.get<FsStatPayload>('/fs/stat', { uri })
    if (request !== nodeRequest || detailUri.value !== uri) {
      return
    }
    stat.value = statPayload.stat
    selectedKindHint.value = statPayload.stat?.kind ?? null
    nodeCapabilities.value = statPayload.capabilities ?? null

    if (statPayload.stat === null) {
      error.value = `节点不存在或已被删除：${uri}`
      return
    }

    if (health.value === null) {
      void loadHealth()
    }

    // 记忆元数据也是独立请求：失败只影响右栏的「记忆」区块。
    if (statPayload.stat.kind === 'file' && isMemoryUri(uri)) {
      void loadMemoryMeta(uri, request)
    }

    // ACL 只能设在目录上：文件的有效权限来自最近的目录祖先。
    const aclUri =
      statPayload.stat.kind === 'directory' ? uri : uri.slice(0, uri.lastIndexOf('/'))
    aclScope.value = aclUri
    if (nodeCapabilities.value?.manage === false) {
      aclError.value = '没有查看这个位置访问设置的权限。'
    } else {
      void loadAcl(aclUri, request)
    }

    // 关联边也是独立请求：失败只影响关联区块。
    void loadLinks(uri, request)

    // 摘要单独取、单独报错：失败时 `abstractFailed` 置位，`error` 保持 null。
    await loadAbstract(uri, request)
  } catch (caught) {
    if (request === nodeRequest && detailUri.value === uri) {
      error.value = errorMessageOf(caught)
    }
  } finally {
    if (request === nodeRequest && detailUri.value === uri) {
      loading.value = false
    }
  }
}

async function loadAbstract(uri: string, request: number): Promise<void> {
  try {
    const payload = await api.get<SummaryLayerPayload>('/content/abstract', { uri })
    if (request !== nodeRequest || detailUri.value !== uri) {
      return
    }
    abstractText.value = payload.abstract ?? null
    abstractSource.value = payload.source ?? null
    degraded.value = payload.degraded
    if (abstractText.value === null && payload.source === 'index') {
      await loadArchiveSummary(uri, request)
    }
  } catch {
    if (request === nodeRequest && detailUri.value === uri) {
      abstractFailed.value = true
    }
  }
}

/** 只用目录自身的真实状态确认归档入口，路径形状不能单独作为证据。 */
async function loadArchiveSummary(uri: string, request: number): Promise<void> {
  const directory = archiveMessagesDirectoryOf(uri)
  if (directory === null) {
    return
  }

  try {
    const [statPayload, summaryPayload] = await Promise.all([
      api.get<FsStatPayload>('/fs/stat', { uri: directory }),
      api.get<SummaryLayerPayload>('/content/abstract', { uri: directory }),
    ])
    if (
      request === nodeRequest &&
      detailUri.value === uri &&
      statPayload.stat?.kind === 'directory' &&
      summaryPayload.source === 'summary' &&
      summaryPayload.abstract !== null &&
      summaryPayload.abstract !== undefined &&
      summaryPayload.abstract.trim() !== ''
    ) {
      archiveSummaryUri.value = directory
    }
  } catch {
    // 这是可选的下一步入口；无法确认时保持普通空态，不把猜测写成事实。
  }
}

async function loadLayer(): Promise<void> {
  const uri = detailUri.value
  const targetLayer = layer.value
  const request = ++layerRequest
  layerError.value = null
  if (loadedLayers.value.has(targetLayer)) {
    layerLoading.value = false
    return
  }

  layerLoading.value = true

  try {
    let nextOverview: string | null | undefined
    let nextChildren: readonly TreeEntryPayload[] | undefined
    let nextContent: string | undefined

    if (targetLayer === 'l1') {
      const payload = await api.get<SummaryLayerPayload>('/content/overview', { uri })
      nextOverview = payload.overview ?? null
    } else if (targetLayer === 'l2') {
      if (isDirectory.value) {
        const payload = await api.get<{ uri: string; entries: readonly TreeEntryPayload[] }>(
          '/fs/ls',
          { uri },
        )
        nextChildren = payload.entries
      } else {
        const payload = await api.get<ContentReadPayload>('/content/read', { uri })
        nextContent = payload.text
      }
    }

    if (
      request !== layerRequest ||
      detailUri.value !== uri ||
      layer.value !== targetLayer
    ) {
      return
    }
    if (nextOverview !== undefined) {
      overviewText.value = nextOverview
    }
    if (nextChildren !== undefined) {
      children.value = nextChildren
    }
    if (nextContent !== undefined) {
      contentText.value = nextContent
    }
    loadedLayers.value = new Set<LevelTab>([...loadedLayers.value, targetLayer])
  } catch (caught) {
    if (
      request === layerRequest &&
      detailUri.value === uri &&
      layer.value === targetLayer
    ) {
      layerError.value = errorMessageOf(caught)
    }
  } finally {
    if (
      request === layerRequest &&
      detailUri.value === uri &&
      layer.value === targetLayer
    ) {
      layerLoading.value = false
    }
  }
}

function kindHintFor(uri: string): FsEntryKind | null {
  const candidates = [
    ...(browserEntries.value ?? []),
    ...(rootEntries.value ?? []),
    ...(children.value ?? []),
  ]
  return candidates.find((entry) => entry.uri.replace(/\/+$/u, '') === uri.replace(/\/+$/u, ''))?.kind ?? null
}

function selectNode(uri: string): void {
  selectedKindHint.value = kindHintFor(uri)
  void router.push(
    uri.replace(/\/+$/u, '') === scopeRoot.value.replace(/\/+$/u, '')
      ? '/files'
      : fileRouteOf(uri),
  )
}

async function copyUri(): Promise<void> {
  const uri = detailUri.value
  if (!(await copyToClipboard(uri))) {
    // 浏览器拒绝写剪贴板（非安全上下文）：不弹假成功提示。
    copied.value = false
    return
  }
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
  }, 1600)
}

function openCreate(kind: 'directory' | 'file'): void {
  actionMode.value = kind
  actionInitial.value = ''
  actionError.value = null
  actionOpen.value = true
}

function openRename(): void {
  if (selectedUri.value === null) {
    return
  }
  actionMode.value = 'rename'
  actionInitial.value = workspaceNameOf(selectedUri.value)
  actionError.value = null
  actionOpen.value = true
}

function openCopy(): void {
  if (selectedUri.value === null || entryKind.value === null) {
    return
  }
  actionMode.value = 'copy'
  actionInitial.value = workspaceCopyNameOf(
    workspaceNameOf(selectedUri.value),
    entryKind.value === 'directory',
  )
  actionError.value = null
  actionOpen.value = true
}

async function submitWorkspaceAction(name: string): Promise<void> {
  if (actionBusy.value) {
    return
  }

  const mode = actionMode.value
  const sourceUri = selectedUri.value
  const parent =
    mode === 'directory' || mode === 'file'
      ? currentDirectoryUri.value
      : sourceUri === null
        ? null
        : workspaceParentUriOf(sourceUri)
  const target = parent === null ? null : workspaceChildUri(parent, name)
  if (parent === null || target === null) {
    actionError.value = '名称不能为空，也不能包含斜杠。'
    return
  }

  actionBusy.value = true
  actionError.value = null
  try {
    if (mode === 'directory') {
      await api.post('/fs/mkdir', { uri: target })
      toast.show('success', '文件夹已创建')
    } else if (mode === 'file') {
      await api.post('/content/write', {
        uri: target,
        content: '',
        mode: 'create',
      })
      toast.show('success', '文档已创建')
    } else {
      if (sourceUri === null) {
        throw new Error('没有选中要处理的节点。')
      }
      await api.post(mode === 'rename' ? '/fs/mv' : '/fs/cp', {
        from: sourceUri,
        to: target,
      })
      toast.show('success', mode === 'rename' ? '已重命名' : '副本已创建')
    }

    actionOpen.value = false
    await loadDirectory(parent)
    openUri(target)
  } catch (caught) {
    actionError.value = errorMessageOf(caught)
  } finally {
    actionBusy.value = false
  }
}

function openDelete(): void {
  if (selectedUri.value === null) {
    return
  }
  deleteError.value = null
  deleteOpen.value = true
}

async function deleteSelected(): Promise<void> {
  const uri = selectedUri.value
  if (uri === null || deleteBusy.value) {
    return
  }

  const parent = workspaceParentUriOf(uri) ?? scopeRoot.value
  deleteBusy.value = true
  deleteError.value = null
  try {
    await api.del('/fs', { uri })
    deleteOpen.value = false
    toast.show('success', '已删除')
    await router.replace(
      parent.replace(/\/+$/u, '') === scopeRoot.value.replace(/\/+$/u, '')
        ? '/files'
        : fileRouteOf(parent),
    )
    await loadDirectory(parent)
  } catch (caught) {
    deleteError.value = errorMessageOf(caught)
  } finally {
    deleteBusy.value = false
  }
}

watch(
  detailUri,
  (uri) => {
    actionOpen.value = false
    deleteOpen.value = false
    shareOpen.value = false
    editorOpen.value = false
    if (selectedKindHint.value === null) {
      selectedKindHint.value = kindHintFor(uri)
    }
    void loadNode(uri)
  },
  { immediate: true },
)

watch(layer, () => {
  void loadLayer()
})

watch(
  currentDirectoryUri,
  (uri) => {
    browserEntries.value = null
    browserCapabilities.value = null
    if (uri !== '') {
      void loadDirectory(uri)
    }
  },
  { immediate: true },
)

watch(searchQuery, () => {
  searchRequest += 1
  searchHits.value = null
  if (searchQuery.value.trim() === '') {
    void runWorkspaceSearch()
    return
  }
  searching.value = true
  scheduleWorkspaceSearch()
})

watch([searchScope, currentDirectoryUri, navigationRootUri], () => {
  if (searchQuery.value.trim() !== '') {
    searchRequest += 1
    searchHits.value = null
    searching.value = true
    scheduleWorkspaceSearch()
  }
})

// 作用域切换后详情里的节点可能已经不在新根下：回文件树入口，不显示一个不属于
// 当前作用域的地址。
watch(scopeRoot, (root) => {
  const uri = selectedUri.value
  selectedKindHint.value = null
  browserEntries.value = null
  rootEntries.value = null
  stat.value = null
  if (uri !== null && uri !== root && !uri.startsWith(`${root}/`)) {
    void router.replace('/files')
  }
  void loadDirectory(root)
  void loadRootEntries()
})

onMounted(() => {
  if (rootEntries.value === null) {
    void loadRootEntries()
  }
  void refreshWorkspaceIdentity()
})

onBeforeUnmount(() => {
  clearTimeout(copiedTimer)
  scheduleWorkspaceSearch.cancel()
  unsubscribeIdentity()
})
</script>

<template>
  <div class="workspace">
    <DomainWorkspaceNavigator
      :scopes="scopeOptions"
      :shared-folders="sharedFolders"
      :scope-root="scopeRoot"
      :root-entries="rootEntries"
      :current-uri="currentDirectoryUri"
      :loading="browserLoading || rootEntriesLoading"
      @select-space="changeScope"
      @open="selectNode"
      @open-shared="openSharedFolder"
    />

    <DomainWorkspaceBrowser
      v-model:query="searchQuery"
      v-model:search-scope="searchScope"
      :entries="browserEntries"
      :crumbs="crumbs"
      :current-title="currentDirectoryTitle"
      :selected-uri="selectedUri"
      :loading="browserLoading"
      :error="browserError"
      :can-go-up="canGoUp"
      :searching="searching"
      :search-hits="searchHits"
      :search-error="searchError"
      :can-create="browserCapabilities?.write === true"
      :can-create-memory="
        browserCapabilities?.write === true &&
        currentDirectoryUri === `${scopeRoot}/memories`
      "
      @open="selectNode"
      @up="goUp"
      @refresh="refreshWorkspace"
      @retry-search="runWorkspaceSearch"
      @create="openCreate"
      @create-memory="createMemoryOpen = true"
    />

    <main class="workspace-detail" aria-live="polite">
      <section v-if="selectedUri === null" class="workspace-home">
        <div class="workspace-home__hero">
          <span class="workspace-home__icon">
            <FolderOpen :size="28" :stroke-width="1.35" />
          </span>
          <div>
            <h1>{{ currentScopeLabel }}</h1>
            <p>{{ rootFolders.length }} 个位置</p>
          </div>
          <span class="workspace-home__spacer" />
          <button type="button" class="iconbtn" aria-label="复制空间地址" @click="copyUri">
            <Copy :size="16" :stroke-width="1.45" />
          </button>
          <button
            v-if="entryKind === 'directory'"
            type="button"
            class="iconbtn"
            aria-label="共享空间"
            :disabled="nodeCapabilities?.manage !== true"
            @click="shareOpen = true"
          >
            <Shield :size="16" :stroke-width="1.45" />
          </button>
        </div>

        <div v-if="rootFolders.length > 0" class="workspace-home__grid">
          <NuxtLink
            v-for="folder in rootFolders"
            :key="folder.uri"
            :to="fileRouteOf(folder.uri)"
            class="workspace-home__folder"
          >
            <Folder :size="22" :stroke-width="1.4" />
            <span>{{ fsEntryDisplayName(folder.kind, folder.name) }}</span>
          </NuxtLink>
        </div>
        <UiEmpty v-else-if="!browserLoading" v-slot="{ size }" title="空间里还没有内容">
          <FolderOpen :size="size" :stroke-width="1.4" />
        </UiEmpty>
      </section>

      <div v-else class="doc-pane workspace-detail__doc">
        <div class="doc-pane__inner">
          <header class="workspace-detail__head">
            <div class="doc-head__main">
              <h1 class="doc-title">{{ documentTitle }}</h1>
              <div class="uri">{{ detailUri }}</div>
            </div>
            <div class="workspace-detail__actions">
              <button
                v-if="entryKind === 'file'"
                type="button"
                class="detail-action"
                :disabled="nodeCapabilities?.write !== true"
                @click="editorOpen = true"
              >
                <Pencil :size="14" :stroke-width="1.5" />
                编辑
              </button>
              <button
                v-if="!isSpaceRoot"
                type="button"
                class="detail-action"
                :disabled="nodeCapabilities?.manage !== true"
                @click="openRename"
              >
                <Pencil :size="14" :stroke-width="1.5" />
                重命名
              </button>
              <button
                v-if="entryKind === 'file'"
                type="button"
                class="detail-action"
                :disabled="!canCopySelected"
                @click="openCopy"
              >
                <Copy :size="14" :stroke-width="1.5" />
                副本
              </button>
              <button
                type="button"
                class="detail-action"
                :disabled="nodeCapabilities?.manage !== true"
                @click="shareOpen = true"
              >
                <Shield :size="14" :stroke-width="1.5" />
                共享
              </button>
              <button
                v-if="!isSpaceRoot"
                type="button"
                class="detail-action detail-action--danger"
                :disabled="nodeCapabilities?.manage !== true"
                @click="openDelete"
              >
                <Trash2 :size="14" :stroke-width="1.5" />
                删除
              </button>
            </div>
          </header>

          <div class="doc-pills mb-20">
            <UiBadge v-if="entryKindLabel !== null" variant="gray">{{ entryKindLabel }}</UiBadge>
            <UiBadge v-if="degraded" variant="orange">摘要降级</UiBadge>
            <button type="button" class="detail-uri-action" @click="copyUri">
              {{ copied ? '已复制地址' : '复制地址' }}
            </button>
          </div>

          <UiErrorCallout v-if="error !== null" :message="error" />

          <div v-else class="detail-grid">
            <div>
              <UiTabs v-model="layer" :items="visibleLayerTabs" aria-label="披露层级" />

              <UiErrorCallout v-if="layerError !== null" class="mt-16" :message="layerError" />

              <div v-else-if="loading || layerLoading" class="skeleton-block mt-16" aria-busy="true">
                <UiSkeleton width="42%" height="14px" />
                <UiSkeleton width="94%" height="18px" />
                <UiSkeleton width="88%" height="18px" />
                <UiSkeleton width="64%" height="18px" />
              </div>

              <template v-else-if="layer === 'l0'">
                <div v-if="abstractText !== null" class="abstract mt-16">
                  <div class="abstract__meta">
                    <span class="leveltag" data-level="0">
                      <span class="strata"><i /><i /><i /></span>
                      <b>L0</b>
                    </span>
                    <span>摘要</span>
                    <template v-if="abstractSourceLabel !== null">
                      <span class="faint">·</span>
                      <span>{{ abstractSourceLabel }}</span>
                    </template>
                  </div>
                  <p class="abstract__quote">{{ abstractText }}</p>
                  <div class="abstract__foot">
                    <span>{{ abstractText.length }} 字符</span>
                  </div>
                </div>
                <UiEmpty v-else-if="abstractFailed" class="mt-16" title="摘要没有取到" />
                <UiEmpty v-else class="mt-16" title="还没有摘要">
                  <template #extra>
                    <div class="summary-empty-actions">
                      <NuxtLink
                        v-if="archiveSummaryUri !== null"
                        :to="fileRouteOf(archiveSummaryUri)"
                        class="btn btn--secondary btn--sm"
                      >
                        查看归档摘要
                      </NuxtLink>
                      <UiButton
                        v-if="!isDirectory"
                        variant="secondary"
                        size="sm"
                        @click="layer = 'l2'"
                      >
                        打开原文
                      </UiButton>
                    </div>
                  </template>
                </UiEmpty>
              </template>

              <template v-else-if="layer === 'l1'">
                <pre v-if="overviewText !== null" class="doc-raw mt-16">{{ overviewText }}</pre>
                <UiEmpty v-else class="mt-16" title="还没有概览" />
              </template>

              <template v-else>
                <template v-if="isDirectory">
                  <div v-if="children !== null && children.length > 0" class="directory-list mt-16">
                    <button
                      v-for="child in children"
                      :key="child.uri"
                      type="button"
                      class="directory-row"
                      @click="selectNode(child.uri)"
                    >
                      <Folder
                        v-if="child.kind === 'directory'"
                        :size="16"
                        :stroke-width="1.45"
                      />
                      <FileText v-else :size="16" :stroke-width="1.45" />
                      <span>{{ fsEntryDisplayName(child.kind, child.name) }}</span>
                      <span>{{ child.kind === 'directory' ? child.size : formatBytes(child.size) }}</span>
                    </button>
                  </div>
                  <UiEmpty v-else class="mt-16" title="这个目录是空的" />
                </template>

                <template v-else>
                  <pre v-if="contentText !== null && contentText !== ''" class="doc-raw mt-16">{{ contentText }}</pre>
                  <UiEmpty v-else class="mt-16" title="这个文件是空的" />
                </template>
              </template>

              <section
                v-if="
                  isMemoryNode &&
                  (outgoingRows.length > 0 || backlinkRows.length > 0 || linksError !== null)
                "
                class="links"
                aria-label="关联记忆"
              >
                <div class="links__title">关联</div>

                <UiCallout v-if="linksError !== null" tone="warn">
                  <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
                  <div>关联没有取到：{{ linksError }}</div>
                </UiCallout>

                <section v-if="outgoingRows.length > 0" class="links__group">
                  <div class="links__group-title">这条记忆指向</div>
                  <ul class="links__list">
                    <li
                      v-for="(row, index) in outgoingRows"
                      :key="`out-${index}-${row.uri}`"
                      class="links__item"
                    >
                      <div class="links__row">
                        <span class="links__type">{{ row.label }}</span>
                        <button type="button" class="links__uri" @click="selectNode(row.uri)">
                          {{ row.uri }}
                        </button>
                      </div>
                      <p v-if="row.description !== ''" class="caption">{{ row.description }}</p>
                    </li>
                  </ul>
                </section>

                <section v-if="backlinkRows.length > 0" class="links__group">
                  <div class="links__group-title">指向这条记忆</div>
                  <ul class="links__list">
                    <li
                      v-for="(row, index) in backlinkRows"
                      :key="`in-${index}-${row.uri}`"
                      class="links__item"
                    >
                      <div class="links__row">
                        <span class="links__type">{{ row.label }}</span>
                        <button type="button" class="links__uri" @click="selectNode(row.uri)">
                          {{ row.uri }}
                        </button>
                      </div>
                      <p v-if="row.description !== ''" class="caption">{{ row.description }}</p>
                    </li>
                  </ul>
                </section>
              </section>
            </div>

            <DomainSummaryPanel
              :stat="stat"
              :abstract="abstractText"
              :abstract-source="abstractSource"
              :abstract-failed="abstractFailed"
              :freshness="health?.summary ?? null"
              :acl="acl"
              :acl-error="aclError"
              :acl-inherited-from="aclInheritedFrom"
              :memory-enabled="memoryMetaEnabled"
              :memory="memoryMeta"
              :memory-error="memoryMetaError"
              :loading="loading"
            />
          </div>
        </div>
      </div>
    </main>

    <DomainWorkspaceActionDialog
      v-model="actionOpen"
      :mode="actionMode"
      :initial-value="actionInitial"
      :busy="actionBusy"
      :error="actionError"
      @submit="submitWorkspaceAction"
    />

    <DomainMemoryCreateDialog v-model="createMemoryOpen" @created="showCreatedMemory" />

    <DomainWorkspaceShareDialog
      v-model="shareOpen"
      :uri="detailUri"
      :kind="entryKind"
      @changed="refreshWorkspace"
    />

    <DomainWorkspaceEditorDialog
      v-model="editorOpen"
      :uri="entryKind === 'file' ? detailUri : null"
      @saved="refreshWorkspace"
    />

    <UiDialog v-model="deleteOpen" title="删除">
      <div class="stack-16">
        <UiErrorCallout v-if="deleteError !== null" :message="deleteError" />
        <p class="delete-copy">
          删除 {{ documentTitle }}？{{
            isDirectory ? '其中的文件和子文件夹也会一并删除。' : '删除后无法恢复。'
          }}
        </p>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" :disabled="deleteBusy" @click="deleteOpen = false">
            取消
          </UiButton>
          <UiButton variant="danger" :disabled="deleteBusy" @click="deleteSelected">
            {{ deleteBusy ? '删除中' : '删除' }}
          </UiButton>
        </div>
      </div>
    </UiDialog>

    <UiToast />
  </div>
</template>
<style scoped>
.workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

.workspace-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background:
    radial-gradient(720px 300px at 50% -14%, var(--accent-tint-2), transparent 68%),
    var(--bg);
}

.workspace-home {
  display: grid;
  gap: 24px;
  max-width: 760px;
  margin: 0 auto;
  padding: 42px 34px 64px;
}

.workspace-home__hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px;
  border-radius: var(--r-panel);
  background: linear-gradient(145deg, var(--surface), var(--bg-2));
  box-shadow: var(--shadow-card), var(--inset-hair);
}

.workspace-home__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  background: var(--accent-tint);
  color: var(--accent-ink);
  box-shadow: var(--inset-hair);
}

.workspace-home__hero h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 720;
  letter-spacing: -0.024em;
}

.workspace-home__hero p {
  margin: 4px 0 0;
  color: var(--label-3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.workspace-home__spacer {
  flex: 1;
}

.workspace-home__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.workspace-home__folder {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 70px;
  padding: 15px 16px;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
  color: var(--label);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}

.workspace-home__folder svg {
  color: var(--accent-ink);
}

.workspace-home__folder:hover {
  background: var(--surface-2);
  transform: translateY(-1px);
  text-decoration: none;
}

.workspace-home__folder:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint), var(--inset-hair);
}

.workspace-detail__doc {
  padding: 28px 34px 68px;
}

.workspace-detail__head {
  display: grid;
  gap: 13px;
  margin-bottom: 12px;
}

.workspace-detail__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 4px;
}

.workspace-detail .uri {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 31px;
  padding: 5px 9px;
  border: 0;
  border-radius: 8px;
  background: var(--fill-2);
  color: var(--label-2);
  font: inherit;
  font-size: 12px;
  font-weight: 560;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.detail-action:hover {
  background: var(--fill-3);
  color: var(--label);
}

.detail-action:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.detail-action--danger {
  color: var(--red-ink);
}

.detail-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.detail-uri-action {
  padding: 2px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--label-3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.detail-uri-action:hover {
  background: var(--fill-hover);
  color: var(--label);
}

.directory-list {
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.directory-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 44px;
  padding: 8px 13px;
  border: 0;
  border-bottom: 0.5px solid var(--separator);
  background: transparent;
  color: var(--label-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.directory-row:last-child {
  border-bottom: 0;
}

.directory-row:hover {
  background: var(--fill-hover);
  color: var(--label);
}

.directory-row svg {
  color: var(--label-3);
}

.directory-row > span:last-child {
  color: var(--label-3);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.delete-copy {
  margin: 0;
  color: var(--label-2);
  font-size: 14px;
  line-height: 1.55;
}

/* 关联边：与正文/摘要并列的一块，失败时只在这一块里说明。 */
.links {
  display: grid;
  gap: 16px;
  margin-top: 26px;
  padding-top: 22px;
  border-top: 0.5px solid var(--separator);
}

.links__title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-3);
  text-transform: uppercase;
}

.summary-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

.summary-empty-actions a {
  text-decoration: none;
}

.links__group {
  display: grid;
  gap: 10px;
}

.links__group-title {
  font-size: 13px;
  color: var(--label-3);
}

.links__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.links__item {
  display: grid;
  gap: 3px;
}

.links__row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.links__type {
  flex: none;
  font-size: 13px;
  color: var(--label-3);
}

.links__uri {
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.45;
  color: var(--label-2);
  text-align: left;
  word-break: break-all;
  cursor: pointer;
}

.links__uri:hover {
  color: var(--accent-ink);
  text-decoration: underline;
}

.links__uri:focus-visible {
  border-radius: var(--r-xs);
  box-shadow: 0 0 0 3px var(--accent-tint);
  outline: none;
}

@media (max-width: 1180px) {
  :deep(.workspace-nav) {
    display: none;
  }
}

@media (max-width: 900px) {
  .workspace {
    display: block;
    overflow-y: auto;
  }

  :deep(.workspace-browser) {
    width: 100%;
    min-height: 430px;
    max-height: 58dvh;
    border-right: 0;
    border-bottom: 0.5px solid var(--separator);
  }

  .workspace-detail {
    min-height: 560px;
    overflow: visible;
  }

  .workspace-detail__head {
    flex-direction: column;
  }

  .workspace-detail__actions {
    flex: none;
    justify-content: flex-start;
  }

  .workspace-detail__doc {
    padding: 24px 18px 56px;
  }

  .workspace-home {
    padding: 28px 18px 56px;
  }
}

@media (max-width: 560px) {
  .workspace-home__grid {
    grid-template-columns: 1fr;
  }

  .workspace-home__hero {
    padding: 18px;
  }
}
</style>
