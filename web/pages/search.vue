<script setup lang="ts">
/**
 * 检索调试（架构文档 §16 的第二页）。
 *
 * 一条 query 选 `find` 或 `search` 执行，结果按分数降序；`search` 额外展示服务端
 * 返回的查询计划（§8.4）。
 *
 * **查询状态与 URL 同步。** 检索条件放在 `?q=...&mode=...` 里：控制台是排查工具，
 * 贴一条「我这样查没命中」的链接比自己复述条件有用。恢复只在挂载时做一次，
 * 之后由面板的防抖驱动，不做双向绑定——路由变化再回写表单会在浏览器的前进/后退
 * 上产生一次多余的检索。
 *
 * **没检索过与没命中是两件事。** 前者是空状态文案「输入关键词开始检索」，后者是
 * 「没有找到匹配的内容」，由 `searched` 区分。
 */
import type {
  SearchContextType,
  SearchFindPayload,
  SearchHitPayload,
  SearchLevel,
  SearchMode,
  SearchPlanPayload,
  SearchSearchPayload,
} from '~/components/domain/HitList.vue'

useHead({ title: '检索调试 · CoMem 控制台' })

const DEFAULT_LIMIT = '20'

const api = useApi()
const route = useRoute()
const router = useRouter()

function firstValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const head: unknown = value[0]
    return typeof head === 'string' ? head : ''
  }
  return ''
}

function modeOf(value: string): SearchMode {
  return value === 'search' ? 'search' : 'find'
}

function levelOf(value: string): SearchLevel | '' {
  return value === 'L0' || value === 'L1' || value === 'L2' ? value : ''
}

function contextTypeOf(value: string): SearchContextType | '' {
  return value === 'memory' || value === 'resource' || value === 'skill' || value === 'session'
    ? value
    : ''
}

const query = ref(firstValue(route.query['q']))
const mode = ref<SearchMode>(modeOf(firstValue(route.query['mode'])))
const scope = ref(firstValue(route.query['scope']))
const limit = ref(firstValue(route.query['limit']) || DEFAULT_LIMIT)
const level = ref<SearchLevel | ''>(levelOf(firstValue(route.query['level'])))
const contextType = ref<SearchContextType | ''>(contextTypeOf(firstValue(route.query['type'])))

const hits = ref<readonly SearchHitPayload[] | null>(null)
const plan = ref<SearchPlanPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const searched = ref(false)

function buildBody(): Record<string, unknown> {
  const body: Record<string, unknown> = { query: query.value.trim() }

  const scopeUri = scope.value.trim()
  if (scopeUri !== '') {
    body['scopes'] = [scopeUri]
  }

  const parsed = Number.parseInt(limit.value, 10)
  if (Number.isInteger(parsed) && parsed > 0) {
    body['limit'] = parsed
  }

  if (level.value !== '') {
    body['levels'] = [level.value]
  }

  if (contextType.value !== '') {
    body['contextTypes'] = [contextType.value]
  }

  return body
}

/** 查询串只保留非默认值：默认条件不写进 URL，链接才短。 */
function syncUrl(): void {
  const next: Record<string, string> = { q: query.value.trim(), mode: mode.value }
  if (scope.value.trim() !== '') {
    next['scope'] = scope.value.trim()
  }
  if (limit.value !== DEFAULT_LIMIT) {
    next['limit'] = limit.value
  }
  if (level.value !== '') {
    next['level'] = level.value
  }
  if (contextType.value !== '') {
    next['type'] = contextType.value
  }

  void router.replace({ query: next })
}

async function runSearch(): Promise<void> {
  const text = query.value.trim()
  if (text === '' || loading.value) {
    return
  }

  syncUrl()
  loading.value = true
  error.value = null

  try {
    const body = buildBody()
    if (mode.value === 'find') {
      const payload = await api.post<SearchFindPayload>('/search/find', body)
      hits.value = payload.hits
      plan.value = null
    } else {
      const payload = await api.post<SearchSearchPayload>('/search/search', body)
      hits.value = payload.hits
      plan.value = payload.plan
    }
  } catch (caught) {
    error.value = errorMessageOf(caught)
    hits.value = null
    plan.value = null
  } finally {
    loading.value = false
    searched.value = true
  }
}

const planJson = computed(() => (plan.value === null ? '' : JSON.stringify(plan.value, null, 2)))

const resultCaption = computed(() =>
  hits.value === null ? '' : `共 ${hits.value.length} 条 · 按分数降序`,
)

onMounted(() => {
  if (query.value.trim() !== '') {
    void runSearch()
  }
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader
        title="检索调试"
        description="同一条 query 分别走 find 与 search，对比召回差异。"
      >
        <template #actions>
          <UiBadge :variant="mode === 'search' ? 'blue' : 'gray'">
            {{ mode === 'search' ? 'search · 含查询计划' : 'find · 语义检索' }}
          </UiBadge>
        </template>
      </DomainPageHeader>

      <DomainSearchPanel
        v-model:query="query"
        v-model:mode="mode"
        v-model:scope="scope"
        v-model:limit="limit"
        v-model:level="level"
        v-model:context-type="contextType"
        :loading="loading"
        class="mb-20"
        @submit="runSearch"
      />

      <UiCard title="召回结果" panel>
        <template #actions>
          <span class="caption">{{ resultCaption }}</span>
        </template>

        <DomainHitList
          :hits="hits"
          :loading="loading"
          :searched="searched"
          :mode="mode"
          :error="error"
        />
      </UiCard>

      <details v-if="mode === 'search'" class="plan mt-16" open>
        <summary class="plan__summary">
          <span class="plan__title">查询计划</span>
          <span class="caption">服务端实际执行的过滤条件</span>
        </summary>
        <pre v-if="plan !== null" class="plan__json">{{ planJson }}</pre>
        <p v-else class="caption plan__empty">执行一次 search 后显示查询计划。</p>
      </details>
    </div>
  </div>
</template>

<style scoped>
.plan {
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.plan__summary {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.plan__summary::-webkit-details-marker {
  display: none;
}

.plan__summary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
  border-radius: var(--r-card);
}

.plan__title {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
}

.plan__json {
  margin: 0;
  padding: 14px 16px 16px;
  overflow-x: auto;
  border-top: 0.5px solid var(--separator);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  color: var(--label-2);
}

.plan__empty {
  margin: 0;
  padding: 0 16px 16px;
}
</style>
