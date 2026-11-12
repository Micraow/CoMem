<script setup lang="ts">
/**
 * 检索（架构文档 §16 的第二页）。
 *
 * 一条 query 选 `find` 或 `search` 执行，结果按分数降序；`search` 额外展示服务端
 * 返回的查询计划（§8.4）。
 *
 * **引擎标签是实际配置，不是页面自称。** `/health` 的 `retrieval.engine` 决定右上
 * 角写「关键词匹配 / 向量检索 / 混合检索」；`fts5` 是词法召回，不叫「语义检索」。
 *
 * **自然语言不在这里拆词。** 服务端的查询重写在 `search` 模式里（`IntentStage`），
 * 没有「只返回计划、不检索」的端点；前端再拆一次词就有两份分叉的分词规则。所以
 * 长句 0 命中时只提示改用更短的关键词 / 换模式，不在浏览器里重写查询。
 *
 * **查询状态与 URL 同步。** 检索条件放在 `?q=...&mode=...` 里：控制台是排查工具，
 * 贴一条「我这样查没命中」的链接比自己复述条件有用。恢复只在挂载时做一次，
 * 之后由面板的防抖驱动，不做双向绑定——路由变化再回写表单会在浏览器的前进/后退
 * 上产生一次多余的检索。
 *
 * **没检索过与没命中是两件事。** 前者是空状态「还没有检索」；后者按「库空」与
 * 「有数据但没匹配」分两种文案（`index.totalNodes === 0` 时提示先写入一条记忆），
 * 由 `searched` 区分。
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
import { useApi, type HealthPayload } from '~/composables/useApi'
import { retrievalEngineLabel, typedQueryIntentLabel } from '~/utils/searchLabels'

useHead({ title: '检索 · CoMem 控制台' })

const DEFAULT_LIMIT = '20'

const api = useApi()
const route = useRoute()
const router = useRouter()
const scopeRoot = useScopeRoot()

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
const scope = ref(firstValue(route.query['scope']) || scopeRoot.value)
const limit = ref(firstValue(route.query['limit']) || DEFAULT_LIMIT)
const level = ref<SearchLevel | ''>(levelOf(firstValue(route.query['level'])))
const contextType = ref<SearchContextType | ''>(contextTypeOf(firstValue(route.query['type'])))

const hits = ref<readonly SearchHitPayload[] | null>(null)
const plan = ref<SearchPlanPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const searched = ref(false)

/**
 * `/health` 只用于两件事：如实显示引擎，以及区分「库空」与「无匹配」。
 *
 * 取不到时保持 `null`：不猜一个默认引擎（那与「配置改了不生效」是同一类假状态），
 * 空态退回不带引擎说明的版本。检索本身不依赖它。
 */
const health = ref<HealthPayload | null>(null)
const engine = computed(() => health.value?.retrieval.engine ?? null)
const libraryEmpty = computed(
  () => health.value !== null && health.value.index.totalNodes === 0,
)

async function loadHealth(): Promise<void> {
  try {
    health.value = await api.get<HealthPayload>('/health')
  } catch {
    health.value = null
  }
}

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

const resultCaption = computed(() =>
  hits.value === null ? '' : `共 ${hits.value.length} 条 · 按分数降序`,
)

onMounted(() => {
  void loadHealth()
  if (query.value.trim() !== '') {
    void runSearch()
  }
})

// 全局作用域切换后，检索条件里的范围跟着换；已经有结果就按新范围重跑。
watch(scopeRoot, (root) => {
  scope.value = root
  if (searched.value) {
    void runSearch()
  }
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="检索">
        <template #actions>
          <UiBadge v-if="engine !== null" variant="outline">
            {{ retrievalEngineLabel(engine) }}
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
          :engine="engine"
          :library-empty="libraryEmpty"
        />
      </UiCard>

      <section v-if="mode === 'search'" class="plan mt-16">
        <header class="plan__header">
          <h2 class="plan__title">查询计划</h2>
          <span v-if="plan !== null" class="caption plan__meta">
            {{ plan.queries.length }} 条查询 · 耗时 {{ Math.round(plan.elapsedMs) }}ms
          </span>
        </header>

        <template v-if="plan === null">
          <p class="caption plan__empty">还没有查询计划。</p>
        </template>

        <template v-else>
          <!-- 降级不是错误，但必须可见：静默降级等于骗人（§17.9 的同一原则）。 -->
          <p v-if="!plan.analyzed" class="plan__degraded">
            意图分析没有完成，已用原查询检索。
          </p>

          <p v-else-if="plan.queries.length === 0" class="caption plan__empty">
            这次查询不需要检索。
          </p>

          <ul v-else class="plan__list">
            <li v-for="(query, index) in plan.queries" :key="index" class="plan__item">
              <span class="plan__intent">{{ typedQueryIntentLabel(query.intent) }}</span>
              <span class="plan__text">{{ query.text }}</span>
              <span class="plan__confidence">{{ (query.confidence * 100).toFixed(0) }}%</span>
              <span v-if="query.derivedFrom !== null" class="plan__derived">
                来自「{{ query.derivedFrom }}」
              </span>
            </li>
          </ul>

          <!-- 引擎名、失败原因这类排障信息放折叠区：主文案说「为什么没结果」，这里说「具体是什么」。 -->
          <details class="plan__advanced">
            <summary>高级信息</summary>
            <p v-if="engine !== null" class="plan__advanced-line">
              检索引擎：{{ engine }}（{{ retrievalEngineLabel(engine) }}）
            </p>
            <p v-if="!plan.analyzed && plan.reason !== null" class="plan__advanced-line">
              {{ plan.reason }}
            </p>
          </details>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.plan {
  border-radius: var(--r-card);
  background: var(--surface);
  box-shadow: var(--inset-hair);
}

.plan__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
}

.plan__title {
  margin: 0;
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
}

.plan__meta {
  font-variant-numeric: tabular-nums;
}

.plan__degraded {
  margin: 0;
  padding: 0 16px 14px;
  font-size: 13px;
  line-height: 1.47;
  color: var(--label-2);
}

.plan__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 14px 16px;
  list-style: none;
  border-top: 0.5px solid var(--separator);
}

.plan__item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: baseline;
  gap: 10px;
}

.plan__intent {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--accent-tint);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.plan__text {
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.47;
  overflow-wrap: anywhere;
}

.plan__confidence {
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--label-2);
}

.plan__derived {
  grid-column: 2 / -1;
  font-size: 13px;
  color: var(--label-3);
}

.plan__empty {
  margin: 0;
  padding: 0 16px 16px;
}

.plan__advanced {
  padding: 0 16px 14px;
  font-size: 13px;
  color: var(--label-3);
}

.plan__advanced summary {
  cursor: pointer;
  color: var(--label-2);
}

.plan__advanced-line {
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}
</style>
