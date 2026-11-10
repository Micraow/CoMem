<script setup lang="ts">
/**
 * 节点侧栏（文件树页的右栏）。
 *
 * 四段：摘要来源、新鲜度、有效权限、存储。
 *
 * **不编造拿不到的状态。** 服务端只暴露「摘要是否存在」「是否降级」与全站的
 * 待刷新目录数，没有单节点的生成时间、模型、版本。设计稿里的仪表需要单节点
 * 的待刷新比例，这里改成「未知 / 已生成」加全站计数——百分比没有分母就是假数据。
 */
import type { AclPayload, FsStatPayload, HealthPayload } from '~/composables/useApi'
import { formatBytes } from '~/composables/useTree'
import { ACL_LEVEL_LABEL, ACL_MODE_LABEL, type AclLevel } from '~/utils/aclLabels'
import { fsEntryKindLabel, fsEntryLevelsLabel } from '~/utils/fsLabels'

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
    loading: false,
  },
)

const LEVEL_VARIANT: Readonly<Record<AclLevel, 'gray' | 'teal' | 'purple'>> = {
  1: 'gray',
  3: 'teal',
  7: 'purple',
}

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
  const date = new Date(props.stat.updatedAt)
  if (Number.isNaN(date.getTime())) {
    return props.stat.updatedAt
  }
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
})
</script>

<template>
  <aside class="inspector" aria-label="节点摘要与权限">
    <section class="inspector__section">
      <div class="inspector__title">摘要来源</div>
      <div v-if="props.loading" class="stack-8">
        <UiSkeleton width="70%" height="12px" />
        <UiSkeleton width="50%" height="12px" />
      </div>
      <div v-else class="meta-list">
        <div class="meta-list__row">
          <span class="meta-list__k">状态</span>
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
            <UiBadge :variant="LEVEL_VARIANT[row.level]">{{ ACL_LEVEL_LABEL[row.level] }}</UiBadge>
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
