<script lang="ts">
import type { AclPayload } from '~/composables/useApi'

/**
 * 推导链的一级：从根到当前节点的某一个目录。
 *
 * `snapshot` 为 null 表示这一级读不到 ACL（权限不足或服务端拒绝）；`error` 带
 * 服务端给的中文原因。链上有洞时不能假装「没有直接授权」——那会让人以为这一级
 * 真的没有授权。
 */
export interface AclChainLevel {
  readonly uri: string
  readonly snapshot: AclPayload | null
  readonly error: string | null
}
</script>

<script setup lang="ts">
/**
 * 有效权限推导链（架构文档 §12.1、§12.2）。
 *
 * 自根向下逐级展示：每一级的 `mode` + 直接授权，最后一行是服务端算好的最终权限。
 *
 * **求值只在服务端做。** 前端的职责是把 `effective` 显示出来，不是重算一遍：
 * `effective(N)` 依赖 owner 恒 manage、同节点 deny 优先、restricted 切断继承三条
 * 规则，任何一条抄错都会出现「界面说能读、服务端说不能」的二义性。
 *
 * **`restricted` 必须视觉上强调。** 它和 `inherit` 的差别不是「多一条规则」，而是
 * 「上游授权在这里全部失效」；只换一个文字标签，用户会以为下游的 read 仍然生效。
 */
import { AlertTriangle, Ban, CornerDownRight } from 'lucide-vue-next'

const props = defineProps<{
  levels: readonly AclChainLevel[]
  /** 当前身份，用来在 `effective` 里取最终权限。 */
  subject: string
  loading: boolean
}>()

type AclLevel = 1 | 3 | 7

const LEVEL_NAME: Readonly<Record<AclLevel, string>> = {
  1: 'read',
  3: 'write',
  7: 'manage',
}

function levelNameOf(level: number): string {
  return level === 1 || level === 3 || level === 7 ? LEVEL_NAME[level] : String(level)
}

function modeOf(level: AclChainLevel): 'inherit' | 'restricted' | null {
  return level.snapshot?.mode ?? null
}

function grantsOf(level: AclChainLevel): string {
  if (level.snapshot === null) {
    return ''
  }
  if (level.snapshot.entries.length === 0) {
    return level.snapshot.mode === 'restricted' ? '无直接授权（继承已切断）' : '继承'
  }
  return level.snapshot.entries
    .map(
      (entry) =>
        `${entry.principal} = ${levelNameOf(entry.level)}${entry.effect === 'deny' ? ' · 拒绝' : ''}`,
    )
    .join('，')
}

const finalSnapshot = computed<AclPayload | null>(() => {
  const last = props.levels.at(-1)
  return last?.snapshot ?? null
})

/** 最终权限：服务端 `effective` 里当前身份的最高级别。没有条目就是「无」。 */
const finalLabel = computed<string>(() => {
  const effective = finalSnapshot.value?.effective
  if (effective === undefined) {
    return '无法推导'
  }
  const levels = effective[props.subject]
  if (levels === undefined || levels.length === 0) {
    return '无'
  }
  return levelNameOf(levels.reduce((highest, level) => (level > highest ? level : highest), 1))
})

const hasGap = computed(() => props.levels.some((level) => level.error !== null))

const finalVariant = computed<'gray' | 'blue' | 'teal'>(() => {
  if (finalLabel.value === '无' || finalLabel.value === '无法推导') {
    return 'gray'
  }
  return finalLabel.value === 'manage' ? 'blue' : finalLabel.value === 'write' ? 'teal' : 'gray'
})
</script>

<template>
  <div class="chain">
    <div v-if="props.loading && props.levels.length === 0" class="stack-8" aria-busy="true">
      <UiSkeleton v-for="index in 3" :key="index" :width="`${70 - index * 8}%`" height="13px" />
    </div>

    <ol v-else class="chain__list">
      <li
        v-for="(level, index) in props.levels"
        :key="level.uri"
        class="chain__node"
        :class="{
          'is-cut': modeOf(level) === 'restricted',
          'is-here': index === props.levels.length - 1,
        }"
      >
        <span class="chain__rail" aria-hidden="true" />
        <div class="chain__body">
          <div class="chain__head">
            <CornerDownRight
              v-if="index > 0"
              :size="12"
              :stroke-width="1.6"
              class="chain__caret"
              aria-hidden="true"
            />
            <span class="chain__uri mono">{{ level.uri }}</span>
            <UiBadge v-if="modeOf(level) !== null" variant="outline">{{ modeOf(level) }}</UiBadge>
            <UiBadge v-if="modeOf(level) === 'restricted'" variant="red">切断继承</UiBadge>
          </div>

          <p v-if="level.error !== null" class="chain__grants is-error">
            <AlertTriangle :size="13" :stroke-width="1.4" aria-hidden="true" />
            {{ level.error }}
          </p>
          <p v-else class="chain__grants">{{ grantsOf(level) }}</p>
        </div>
      </li>
    </ol>

    <div class="chain__final">
      <Ban v-if="finalLabel === '无' || finalLabel === '无法推导'" :size="14" :stroke-width="1.4" />
      <span>最终：</span>
      <UiBadge :variant="finalVariant">{{ finalLabel }}</UiBadge>
      <span class="caption">· {{ props.subject }}</span>
    </div>

    <p v-if="hasGap" class="caption chain__note">
      推导链需要服务端补充 effective 字段：链上有节点读不到授权，最终权限只能显示已读到的那部分。
    </p>
  </div>
</template>

<style scoped>
.chain {
  display: grid;
  gap: 12px;
}

.chain__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.chain__node {
  position: relative;
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr);
  gap: 12px;
  padding: 8px 0;
}

.chain__rail {
  border-radius: var(--r-pill);
  background: transparent;
}

.chain__node.is-here .chain__rail {
  background: var(--accent);
}

.chain__node.is-cut .chain__rail {
  background: var(--red);
}

.chain__body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.chain__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.chain__caret {
  flex: none;
  color: var(--label-4);
}

.chain__uri {
  font-size: 13px;
  color: var(--label);
  word-break: break-all;
}

.chain__grants {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--label-2);
}

.chain__grants.is-error {
  color: var(--orange-ink);
}

.chain__final {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 0.5px solid var(--separator);
  font-size: 14px;
  color: var(--label);
}

.chain__note {
  margin: 0;
}
</style>
