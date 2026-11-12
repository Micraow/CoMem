<script setup lang="ts">
/**
 * 节点侧栏（文件树页的右栏）。
 *
 * 五段：记忆、摘要来源、新鲜度、有效权限、存储。
 *
 * **不编造拿不到的状态。** 服务端只暴露「摘要是否存在」「是否降级」与全站的
 * 待刷新目录数，没有单节点的生成时间、模型、版本。设计稿里的仪表需要单节点
 * 的待刷新比例，这里改成「未知 / 已生成」加全站计数——百分比没有分母就是假数据。
 *
 * **「记忆」一段只在 `memories/` 下的文件出现。** 内容来自 `GET /memories/{uri}`：
 * 检索只返回 `active` 节点，`pending` / `archived` 在 `find` / `search` / `glob`
 * 里被过滤掉。「能否被检索」由状态推导，不另取一份数据；有效期没有值时不占一行。
 */
import type {
  AclPayload,
  FsStatPayload,
  HealthPayload,
  MemoryMetaPayload,
} from '~/composables/useApi'
import { ACL_LEVEL_LABEL, ACL_LEVEL_VARIANT, ACL_MODE_LABEL, type AclLevel } from '~/utils/aclLabels'
import { formatBytes, formatDateTime } from '~/utils/format'
import { fsEntryKindLabel, fsEntryLevelsLabel } from '~/utils/fsLabels'
import { memoryTypeLabelOf } from '~/utils/memoryTypeLabels'
import { NODE_RETRIEVAL_LABEL, NODE_STATUS_LABEL } from '~/utils/nodeStatus'

const props = withDefaults(
  defineProps<{
    stat: FsStatPayload['stat']
    abstract: string | null
    degraded: boolean
    freshness: HealthPayload['summary'] | null
    acl: AclPayload | null
    aclError: string | null
    /** 权限读自哪个目录；与当前节点不同时说明是继承（文件读父目录）。 */
    aclInheritedFrom: string | null
    /** 当前节点是 `memories/` 下的文件（目录与普通文件没有记忆元数据）。 */
    memoryEnabled: boolean
    /** `GET /memories/{uri}`；`null` 表示还没取到或不是可解析的记忆。 */
    memory: MemoryMetaPayload | null
    memoryError: string | null
    loading: boolean
  }>(),
  {
    stat: null,
    abstract: null,
    degraded: false,
    freshness: null,
    acl: null,
    aclError: null,
    aclInheritedFrom: null,
    memoryEnabled: false,
    memory: null,
    memoryError: null,
    loading: false,
  },
)

const effectiveRows = computed<readonly { principal: string; level: AclLevel }[]>(() => {
  const effective = props.acl?.effective
  if (effective === undefined) {
    return []
  }
  return Object.entries(effective).map(([principal, levels]) => ({
    principal,
    level: levels.reduce<AclLevel>((highest, level) => (level > highest ? level : highest), 1),
  }))
})

const summaryState = computed(() => {
  if (props.abstract === null) {
    return '未知'
  }
  return props.degraded ? '规则生成（降级）' : '已生成'
})

const sizeLabel = computed(() => {
  if (props.stat === null) {
    return '未知'
  }
  return props.stat.kind === 'directory'
    ? `${props.stat.size} 个条目`
    : formatBytes(props.stat.size)
})

const kindLabel = computed(() => {
  if (props.stat === null) {
    return '未知'
  }
  return fsEntryKindLabel(props.stat.kind)
})

const updatedLabel = computed(() => {
  if (props.stat === null) {
    return '未知'
  }
  return formatDateTime(props.stat.updatedAt)
})

const memoryTypeLabel = computed(() => {
  const memoryType = props.memory?.memoryType
  return memoryType === null || memoryType === undefined ? '—' : memoryTypeLabelOf(memoryType)
})

const memoryStatusLabel = computed(() => {
  const status = props.memory?.status
  return status === null || status === undefined ? '未知' : NODE_STATUS_LABEL[status]
})

/** 由状态推导，不另取一份检索结果：索引的过滤器只认 `active`。 */
const memoryRetrievalLabel = computed(() => {
  const status = props.memory?.status
  return status === null || status === undefined ? '—' : NODE_RETRIEVAL_LABEL[status]
})

/** 两侧都无界时返回 `null`，模板据此整行不渲染。 */
const memoryValidityLabel = computed<string | null>(() => {
  const from = props.memory?.validFrom ?? null
  const until = props.memory?.validUntil ?? null
  if (from !== null && until !== null) {
    return `${formatDateTime(from)} 至 ${formatDateTime(until)}`
  }
  if (from !== null) {
    return `自 ${formatDateTime(from)} 起`
  }
  if (until !== null) {
    return `截止 ${formatDateTime(until)}`
  }
  return null
})
</script>

<template>
  <aside class="inspector" aria-label="节点摘要与权限">
    <section v-if="props.memoryEnabled" class="inspector__section">
      <div class="inspector__title">记忆</div>
      <div
        v-if="props.loading || (props.memory === null && props.memoryError === null)"
        class="stack-8"
      >
        <UiSkeleton width="70%" height="12px" />
        <UiSkeleton width="52%" height="12px" />
        <UiSkeleton width="60%" height="12px" />
      </div>
      <template v-else-if="props.memory !== null">
        <div class="meta-list">
          <div class="meta-list__row">
            <span class="meta-list__k">类型</span>
            <span class="meta-list__v">{{ memoryTypeLabel }}</span>
          </div>
          <div class="meta-list__row">
            <span class="meta-list__k">状态</span>
            <span class="meta-list__v">{{ memoryStatusLabel }}</span>
          </div>
          <div class="meta-list__row">
            <span class="meta-list__k">能否被检索</span>
            <span class="meta-list__v">{{ memoryRetrievalLabel }}</span>
          </div>
          <div v-if="memoryValidityLabel !== null" class="meta-list__row">
            <span class="meta-list__k">有效期</span>
            <span class="meta-list__v">{{ memoryValidityLabel }}</span>
          </div>
        </div>
        <NuxtLink
          v-if="props.memory.status === 'pending'"
          to="/review"
          class="btn btn--secondary btn--sm memory-action"
        >
          去复核
        </NuxtLink>
        <p v-else-if="props.memory.status === 'archived'" class="caption">
          已归档的记忆不参与检索，但按 URI 仍可读取。
        </p>
      </template>
      <p v-else class="caption">记忆状态没有取到：{{ props.memoryError }}</p>
    </section>

    <section class="inspector__section">
      <div class="inspector__title">摘要来源</div>
      <div v-if="props.loading" class="stack-8">
        <UiSkeleton width="70%" height="12px" />
        <UiSkeleton width="50%" height="12px" />
      </div>
      <div v-else class="meta-list">
        <div class="meta-list__row">
          <span class="meta-list__k">摘要状态</span>
          <span class="meta-list__v">{{ summaryState }}</span>
        </div>
        <div class="meta-list__row">
          <span class="meta-list__k">层级</span>
          <span class="meta-list__v">
            {{ stat === null ? 'L0 摘要' : fsEntryLevelsLabel(stat.kind) }}
          </span>
        </div>
      </div>
    </section>

    <section class="inspector__section">
      <div class="inspector__title">新鲜度</div>
      <div v-if="props.loading" class="stack-8">
        <UiSkeleton width="80%" height="12px" />
        <UiSkeleton width="60%" height="12px" />
      </div>
      <template v-else>
        <div class="meta-list">
          <div class="meta-list__row">
            <span class="meta-list__k">待刷新目录</span>
            <span class="meta-list__v">{{ props.freshness?.pendingDirs ?? '未知' }}</span>
          </div>
          <div class="meta-list__row">
            <span class="meta-list__k">降级目录</span>
            <span class="meta-list__v">{{ props.freshness?.degradedDirs ?? '未知' }}</span>
          </div>
        </div>
        <p class="caption">统计范围为整个命名空间。</p>
      </template>
    </section>

    <section class="inspector__section">
      <div class="inspector__title">有效权限</div>
      <div v-if="props.loading" class="stack-8">
        <UiSkeleton width="85%" height="12px" />
        <UiSkeleton width="65%" height="12px" />
      </div>
      <p v-else-if="props.aclError !== null" class="caption">{{ props.aclError }}</p>
      <template v-else-if="props.acl !== null">
        <div class="rowflex" style="gap: 6px">
          <UiBadge :variant="props.acl.mode === 'restricted' ? 'purple' : 'gray'">
            {{ ACL_MODE_LABEL[props.acl.mode] }}
          </UiBadge>
        </div>
        <p v-if="props.aclInheritedFrom !== null" class="caption">
          继承自 {{ props.aclInheritedFrom }}
        </p>
        <div v-if="effectiveRows.length === 0" class="caption">没有生效的授权。</div>
        <div v-else class="acl-mini">
          <div v-for="row in effectiveRows" :key="row.principal" class="acl-mini__row">
            <span class="acl-mini__p">{{ row.principal }}</span>
            <UiBadge :variant="ACL_LEVEL_VARIANT[row.level]">{{ ACL_LEVEL_LABEL[row.level] }}</UiBadge>
          </div>
        </div>
      </template>
      <p v-else class="caption">未知</p>
    </section>

    <section class="inspector__section">
      <div class="inspector__title">存储</div>
      <div v-if="props.loading" class="stack-8">
        <UiSkeleton width="60%" height="12px" />
        <UiSkeleton width="75%" height="12px" />
      </div>
      <div v-else class="meta-list">
        <div class="meta-list__row">
          <span class="meta-list__k">类型</span>
          <span class="meta-list__v">{{ kindLabel }}</span>
        </div>
        <div class="meta-list__row">
          <span class="meta-list__k">大小</span>
          <span class="meta-list__v">{{ sizeLabel }}</span>
        </div>
        <div class="meta-list__row">
          <span class="meta-list__k">更新于</span>
          <span class="meta-list__v">{{ updatedLabel }}</span>
        </div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
/* 「去复核」是侧栏里唯一的行动入口：不拉伸成整行按钮。 */
.memory-action {
  justify-self: start;
}
</style>
