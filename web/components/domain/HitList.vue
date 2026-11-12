<script lang="ts">
/**
 * 检索命中的线上形状（`POST /search/find` 与 `POST /search/search`）。
 *
 * 类型定义放在这里而不是 `composables/useApi.ts`：Wave 8b 只新增页面与页面组件，
 * 公共客户端文件由 Wave 8a 维护。两份形状必须与服务端 `serializeHit` 一致——
 * 多声明一个字段等于给「服务端改字段」制造静默兼容。
 *
 * `search` 比 `find` 多一个 `plan`（§8.4：`search` 先做意图分析再检索，返回实际
 * 执行的过滤条件）。用可辨识联合而不是 `plan?:`：`find` 永远不会带计划，
 * 可选字段会让「有没有计划」变成运行时才知道的事。
 *
 * 三个闭集字段（`level` / `contextType` / `intent`）的类型来自 `~/utils/`：清单在
 * 那里声明、与领域层的导出对拍，这里只消费派生的类型。写成 `string` 时标签映射
 * 只能靠 `as` 断言，服务端多一个取值会在界面上渲染出 `undefined` 而编译期不报。
 */
import type { Level } from '~/utils/levelLabels'
import type { ContextType, TypedQueryIntent } from '~/utils/searchLabels'

export type SearchMode = 'find' | 'search'

/** 架构文档 §9.1 的三层：L0 摘要 / L1 概览 / L2 原文（`utils/levelLabels.ts`）。 */
export type SearchLevel = Level

/** 架构文档 §8.3 的 `contextTypes`（`utils/searchLabels.ts`）。 */
export type SearchContextType = ContextType

export interface SearchHitPayload {
  readonly uri: string
  readonly contextType: SearchContextType
  /** 记忆类型；非记忆文件为 null。 */
  readonly memoryType: string | null
  readonly level: SearchLevel
  readonly abstract: string | null
  /**
   * 排序分：`bm25 × levelWeight[level]`（§8.5）。
   *
   * **不参与渲染。** 量纲随 `retrieval.engine` 变（`fts5` 无界、`vector` 是
   * `[-1, 1]` 的余弦、`hybrid` 是≈0.03 的 RRF 融合分、重排是 `0..1` 的概率），
   * 能跨引擎显示的只有名次。字段保留是因为接口契约里它还在，删掉会让「服务端
   * 有、界面没声明」变成静默兼容。
   */
  readonly score: number
  /** 哪条重写查询命中的；`find` 没有这一列。 */
  readonly matchedQuery?: string
}

/**
 * 查询计划（§8.4）：`search` 先做意图分析得到 0–5 条 TypedQuery，再逐条检索。
 *
 * `analyzed: false` 时**不是出错**，是降级：模型不可用、超时或被截断，服务端
 * 用原查询跑了一次。`reason` 必有值，界面要如实显示「意图分析不可用」。
 */
export interface SearchTypedQueryPayload {
  readonly text: string
  /** 只可能是 `TYPED_QUERY_INTENTS` 里的六个之一（`utils/searchLabels.ts`）。 */
  readonly intent: TypedQueryIntent
  readonly confidence: number
  readonly derivedFrom: string | null
}

export interface SearchPlanPayload {
  readonly original: string
  readonly queries: readonly SearchTypedQueryPayload[]
  readonly analyzed: boolean
  readonly reason: string | null
  readonly elapsedMs: number
}

export interface SearchFindPayload {
  readonly hits: readonly SearchHitPayload[]
}

export interface SearchSearchPayload extends SearchFindPayload {
  readonly plan: SearchPlanPayload
}
</script>

<script setup lang="ts">
/**
 * 命中列表（检索页的结果区）。
 *
 * 三种状态互斥且必须分开：**未检索**（还没输入）、**空结果**（检索了但没有）、
 * **加载中**（骨架屏）。把「未检索」和「空结果」画成同一个空状态，用户会以为
 * 索引里真的什么都没有。
 *
 * 分数右对齐 + 等宽 + 两位小数：它是用来横向比较的，位数不齐就没法扫。
 */
import { ChevronRight, SearchX, Sparkles } from 'lucide-vue-next'

import { LEVEL_REASON } from '~/utils/levelLabels'
import { memoryTypeLabelOf } from '~/utils/memoryTypeLabels'
import {
  CONTEXT_LABEL,
  retrievalEngineLimit,
  type RetrievalEngine,
} from '~/utils/searchLabels'

const props = defineProps<{
  hits: readonly SearchHitPayload[] | null
  loading: boolean
  /** 是否已经执行过一次检索。空结果与未检索靠它区分。 */
  searched: boolean
  mode: SearchMode
  error: string | null
  /** 全库索引为空（`GET /health` 的 `index.totalNodes === 0`）。 */
  libraryEmpty: boolean
  /** 实际生效的检索引擎；`/health` 没取到时为 null。 */
  engine: RetrievalEngine | null
}>()

const URI_PREFIX = 'comem://'

/** 骨架屏行数：与一屏常见条数一致，避免加载完成时高度跳变。 */
const SKELETON_ROWS = 5

function filePathOf(uri: string): string {
  const relative = uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri
  return relative
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * 主标题：文件的摘要优先，目录与无摘要节点用文件名。
 *
 * URI 是地址不是标题——`comem://user/local/memories/preferences/...md` 既占宽度
 * 又说不出这条记忆是什么。URI 仍然显示，但降为第二行小字。
 *
 * 目录的 L0 摘要可能是整棵子树的拼接（规则摘要把子项连成一段），拿它当标题既长
 * 又不像「一条记忆的名字」；目录命中一律退回文件名。文件（L2）的摘要是这一条
 * 记忆自己的摘要，有就优先用。
 */
function titleOf(hit: SearchHitPayload): string {
  const isFile = hit.level === 'L2'
  if (isFile) {
    const abstract = hit.abstract?.trim() ?? ''
    if (abstract !== '') {
      return abstract
    }
  }
  const relative = hit.uri.startsWith(URI_PREFIX) ? hit.uri.slice(URI_PREFIX.length) : hit.uri
  const name = relative.split('/').filter((segment) => segment !== '').at(-1) ?? relative
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {
    // 保持原样：URI 段解析失败时显示编码前的名字，不把整条结果藏掉。
  }
  // 目录命中以 `/` 结尾，和文件标题区分开（层级徽章之外的第二条线索）。
  return isFile ? decoded : `${decoded}/`
}

/** 0 命中的标题：库空与「有数据但没匹配」是两件事。 */
const emptyTitle = computed(() => (props.libraryEmpty ? '还没有记忆' : '没有匹配'))

/**
 * 0 命中的正文。库空时告诉用户下一步；有数据时给出当前引擎的边界，而不是一句
 * 通用的「无结果」。`engine === null`（/health 没取到）不猜引擎，只给关键词提示。
 */
const emptyText = computed(() => {
  if (props.libraryEmpty) {
    return '先写入一条记忆，或接入 agent 之后再来检索。'
  }
  const limit = props.engine === null ? null : retrievalEngineLimit(props.engine)
  return limit === null ? '换个说法或更短的关键词再试一次。' : `试试更短的关键词。${limit}`
})
</script>

<template>
  <div class="hitlist" aria-live="polite">
    <UiCallout v-if="props.error !== null">
      <template #icon><SearchX :size="15" :stroke-width="1.4" /></template>
      <div>{{ props.error }}</div>
    </UiCallout>

    <div v-else-if="props.loading" class="stack-10" aria-busy="true">
      <div v-for="index in SKELETON_ROWS" :key="index" class="hit hit--skeleton">
        <UiSkeleton :width="`${38 + (index % 3) * 9}%`" height="14px" />
        <UiSkeleton width="28%" height="11px" />
      </div>
    </div>

    <UiEmpty v-else-if="!props.searched" v-slot="{ size }" title="还没有检索">
      <Sparkles :size="size" :stroke-width="1.4" />
    </UiEmpty>

    <UiEmpty
      v-else-if="props.hits === null || props.hits.length === 0"
      v-slot="{ size }"
      :title="emptyTitle"
      :text="emptyText"
    >
      <SearchX :size="size" :stroke-width="1.4" />
    </UiEmpty>

    <ul v-else class="hitrows">
      <li
        v-for="(hit, index) in props.hits"
        :key="`${hit.uri}#${hit.level}`"
        class="hit"
      >
        <span class="hit__level" :data-level="hit.level">{{ hit.level }}</span>

        <div class="hit__body">
          <NuxtLink class="hit__title" :to="`/files/${filePathOf(hit.uri)}`">
            {{ titleOf(hit) }}
            <ChevronRight :size="12" :stroke-width="1.6" aria-hidden="true" />
          </NuxtLink>

          <p class="hit__uri mono">{{ hit.uri }}</p>

          <div class="hit__meta">
            <UiBadge variant="outline">{{ CONTEXT_LABEL[hit.contextType] }}</UiBadge>
            <UiBadge v-if="hit.memoryType !== null" variant="gray">
              {{ memoryTypeLabelOf(hit.memoryType) }}
            </UiBadge>
            <span class="hit__reason">{{ LEVEL_REASON[hit.level] }}</span>
          </div>
        </div>

        <!--
          显示名次而不是分数：FTS5 / 向量 / 融合 / 重排四种引擎的分数量纲互不相同
          （见 `src/services/search.ts` 的 `find` 注释），跨引擎比数字没有意义，
          而且 hybrid 的融合分（≈0.03）用任何两位小数都渲成 0.00。
        -->
        <span class="hit__rank tnum mono">{{ index + 1 }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.hitrows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.hit {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 56px;
  align-items: start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--r-control);
  transition: background var(--dur-fast) var(--ease);
}

.hit + .hit {
  box-shadow: 0 -0.5px 0 var(--hairline);
}

.hit:hover {
  background: var(--fill-hover);
}

.hit--skeleton {
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  padding: 14px;
}

/* 层级徽章：用强调色的深浅，不用红黄绿（§16.1） */
.hit__level {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 22px;
  border-radius: var(--r-xs);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}

.hit__level[data-level='L0'] {
  background: var(--accent-tint);
  color: var(--accent-ink);
}

.hit__level[data-level='L1'] {
  background: var(--accent-tint-2);
  color: var(--accent-ink);
}

.hit__level[data-level='L2'] {
  background: var(--fill-2);
  color: var(--label-2);
}

.hit__body {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.hit__title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 15px;
  font-weight: 550;
  line-height: 1.45;
  color: var(--label);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.hit__title:hover {
  color: var(--accent-ink);
}

.hit__title > svg {
  flex: none;
  color: var(--label-4);
  vertical-align: -1px;
}

.hit__uri {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--label-3);
  overflow-wrap: anywhere;
}

.hit__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hit__reason {
  font-size: 13px;
  color: var(--label-3);
}

.hit__rank {
  padding-top: 2px;
  font-size: 14px;
  font-weight: 600;
  color: var(--label-3);
  text-align: right;
}
</style>
