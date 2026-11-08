<script lang="ts">
/**
 * 组表（架构文档 §16 的用户与组页、§14 的 `/admin/groups`）。
 *
 * 成员数是 `group_member` 的行数，不是「组里有几个有效主体」——后者由 ACL 求值
 * 展开，控制台不重算一遍（§12.2：任何一条规则抄错都会让界面和服务端不一致）。
 *
 * 组的删除确认同样由页面负责：它需要 `permissionCount` 之外的成员关系后果一起
 * 说清楚，表格只抛出动作。
 */

/** `GET /admin/groups` 的行。 */
export interface GroupRowPayload {
  readonly id: string
  readonly displayName: string
  readonly description: string | null
  /** 组的 owner（`app_group.owner_user_id`）。`null` 表示还没有人管。 */
  readonly ownerUserId: string | null
  /** owner 为空：这个组只能通过命令行恢复管理（架构文档 §12.6）。 */
  readonly ownerMissing: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly memberCount: number
  /** 删除确认要用的后果说明：这个组在多少个节点上有授权。 */
  readonly permissionCount: number
}

/** 绝对时间；与用户表同一格式。 */
export function formatGroupTime(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) {
    return iso
  }
  return time.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
</script>

<script setup lang="ts">
import { Pencil, Trash2, UserRound, Users } from 'lucide-vue-next'

const props = defineProps<{
  groups: readonly GroupRowPayload[]
  total: number
  limit: number
  offset: number
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  ownerInfo: [group: GroupRowPayload]
  members: [group: GroupRowPayload]
  edit: [group: GroupRowPayload]
  delete: [group: GroupRowPayload]
  page: [offset: number]
}>()

const pageStart = computed(() => (props.groups.length === 0 ? 0 : props.offset + 1))
const pageEnd = computed(() => props.offset + props.groups.length)
const canPrev = computed(() => props.offset > 0)
const canNext = computed(() => props.offset + props.limit < props.total)
</script>

<template>
  <div class="stack-16">
    <div v-if="props.error !== null" class="callout callout--danger">
      <Users :size="15" :stroke-width="1.4" />
      <div>{{ props.error }}</div>
    </div>

    <UiCard title="组" panel flush>
      <template #actions>
        <span class="caption">共 {{ props.total }} 个</span>
      </template>

      <div v-if="props.loading && props.groups.length === 0" class="skeleton-block">
        <UiSkeleton v-for="index in 5" :key="index" :width="`${76 - index * 6}%`" height="14px" />
      </div>

      <UiTable v-else-if="props.groups.length > 0" caption="组列表">
        <thead>
          <tr>
            <th>ID</th>
            <th>显示名</th>
            <th>描述</th>
            <th class="num">成员数</th>
            <th class="num">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="group in props.groups" :key="group.id">
            <td class="mono strong">
              {{ group.id }}
              <button
                v-if="group.ownerMissing"
                type="button"
                class="owner-badge"
                :aria-label="`查看恢复组 ${group.id} 所有者的方法`"
                @click="emit('ownerInfo', group)"
              >
                <UiBadge variant="red">无所有者</UiBadge>
              </button>
            </td>
            <td>{{ group.displayName }}</td>
            <td>
              <span v-if="group.description !== null && group.description !== ''">
                {{ group.description }}
              </span>
              <span v-else class="faint">—</span>
            </td>
            <td class="num">{{ group.memberCount }}</td>
            <td class="num">
              <div class="rowflex rowflex--end">
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('members', group)"
                >
                  <UserRound :size="13" :stroke-width="1.5" />
                  成员
                </UiButton>
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('edit', group)"
                >
                  <Pencil :size="13" :stroke-width="1.5" />
                  编辑
                </UiButton>
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('delete', group)"
                >
                  <Trash2 :size="13" :stroke-width="1.5" />
                  删除
                </UiButton>
              </div>
            </td>
          </tr>
        </tbody>
      </UiTable>

      <div v-else class="empty">
        <span class="empty__icon">
          <Users :size="20" :stroke-width="1.4" />
        </span>
        <span class="empty__title">还没有组</span>
      </div>

      <template v-if="props.total > props.limit" #foot>
        <span class="caption">{{ pageStart }}–{{ pageEnd }} / {{ props.total }}</span>
        <span class="spacer" />
        <UiButton
          variant="secondary"
          size="sm"
          :disabled="!canPrev || props.loading"
          @click="emit('page', Math.max(0, props.offset - props.limit))"
        >
          上一页
        </UiButton>
        <UiButton
          variant="secondary"
          size="sm"
          :disabled="!canNext || props.loading"
          @click="emit('page', props.offset + props.limit)"
        >
          下一页
        </UiButton>
      </template>
    </UiCard>
  </div>
</template>

<style scoped>
.rowflex--end {
  justify-content: flex-end;
}

.owner-badge {
  display: inline-flex;
  margin-left: 6px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  cursor: pointer;
}

.owner-badge:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.owner-badge:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}
</style>
