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
 */

export type SearchMode = 'find' | 'search'

/** 架构文档 §9.1 的三层：L0 摘要 / L1 概览 / L2 原文。 */
export type SearchLevel = 'L0' | 'L1' | 'L2'

/** 架构文档 §8.3 的 `contextTypes`。 */
export type SearchContextType = 'memory' | 'resource' | 'skill' | 'session'

export interface SearchHitPayload {
  readonly uri: string
  readonly contextType: SearchContextType
  /** 记忆类型；非记忆文件为 null。 */
  readonly memoryType: string | null
  readonly level: SearchLevel
  readonly abstract: string | null
  /** 排序分：`bm25 × levelWeight[level]`（§8.5）。 */
  readonly score: number
}

export interface SearchPlanPayload {
  readonly scopes: readonly string[]
  readonly limit: number
  readonly contextTypes: readonly string[] | null
  readonly levels: readonly string[] | null
  readonly subject: string
}

export interface SearchFindPayload {
  readonly hits: readonly SearchHitPayload[]
}

export interface SearchSearchPayload extends SearchFindPayload {
  readonly plan: SearchPlanPayload
}

/** 命中层级 → 界面文案。层级就是「为什么被召回」，不额外编造匹配原因。 */
export const LEVEL_REASON: Readonly<Record<SearchLevel, string>> = {
  L0: '摘要命中',
  L1: '概览命中',
  L2: '原文命中',
}

export const CONTEXT_LABEL: Readonly<Record<SearchContextType, string>> = {
  memory: '记忆',
  resource: '资源',
  skill: '技能',
  session: '会话',
}
</script>

<script setup lang="ts">
/**
 * 命中列表（检索调试页的结果区）。
 *
 * 三种状态互斥且必须分开：**未检索**（还没输入）、**空结果**（检索了但没有）、
 * **加载中**（骨架屏）。把「未检索」和「空结果」画成同一个空状态，用户会以为
 * 索引里真的什么都没有。
 *
 * 分数右对齐 + 等宽 + 两位小数：它是用来横向比较的，位数不齐就没法扫。
 */
import { ChevronRight, SearchX, Sparkles } from 'lucide-vue-next'

const props = defineProps<{
  hits: readonly SearchHitPayload[] | null
  loading: boolean
  /** 是否已经执行过一次检索。空结果与未检索靠它区分。 */
  searched: boolean
  mode: SearchMode
  error: string | null
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
</script>

<template>
  <div class="hitlist" aria-live="polite">
    <div v-if="props.error !== null" class="callout callout--danger">
      <SearchX :size="15" :stroke-width="1.4" />
      <div>{{ props.error }}</div>
    </div>

    <div v-else-if="props.loading" class="stack-10" aria-busy="true">
      <div v-for="index in SKELETON_ROWS" :key="index" class="hit hit--skeleton">
        <UiSkeleton :width="`${38 + (index % 3) * 9}%`" height="14px" />
        <UiSkeleton width="28%" height="11px" />
      </div>
    </div>

    <div v-else-if="!props.searched" class="empty">
      <span class="empty__icon">
        <Sparkles :size="20" :stroke-width="1.4" />
      </span>
      <span class="empty__title">输入关键词开始检索</span>
      <span class="empty__text">
        检索会走索引，不会碰文件系统；无权限的节点不会以占位形式出现。
      </span>
    </div>

    <div v-else-if="props.hits === null || props.hits.length === 0" class="empty">
      <span class="empty__icon">
        <SearchX :size="20" :stroke-width="1.4" />
      </span>
      <span class="empty__title">没有找到匹配的内容</span>
      <span class="empty__text">
        换一个关键词，或放宽层级与类型筛选；当前范围内确实没有命中。
      </span>
    </div>

    <ul v-else class="hitrows">
      <li v-for="hit in props.hits" :key="`${hit.uri}#${hit.level}`" class="hit">
        <span class="hit__level" :data-level="hit.level">{{ hit.level }}</span>

        <div class="hit__body">
          <div class="hit__top">
            <NuxtLink class="hit__uri mono" :to="`/files/${filePathOf(hit.uri)}`">
              {{ hit.uri }}
              <ChevronRight :size="12" :stroke-width="1.6" aria-hidden="true" />
            </NuxtLink>
          </div>

          <p class="hit__abstract" :class="{ 'is-empty': hit.abstract === null }">
            {{ hit.abstract ?? '（无摘要）' }}
          </p>

          <div class="hit__meta">
            <UiBadge variant="outline">{{ CONTEXT_LABEL[hit.contextType] }}</UiBadge>
            <UiBadge v-if="hit.memoryType !== null" variant="gray">
              {{ hit.memoryType }}
            </UiBadge>
            <span class="hit__reason">{{ LEVEL_REASON[hit.level] }}</span>
          </div>
        </div>

        <span class="hit__score tnum mono">{{ hit.score.toFixed(2) }}</span>
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

.hit__uri {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--label);
  text-decoration: none;
  word-break: break-all;
}

.hit__uri:hover {
  color: var(--accent-ink);
}

.hit__uri > svg {
  flex: none;
  color: var(--label-4);
}

.hit__abstract {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--label-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hit__abstract.is-empty {
  color: var(--label-4);
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

.hit__score {
  padding-top: 2px;
  font-size: 14px;
  font-weight: 600;
  color: var(--label);
  text-align: right;
}
</style>
