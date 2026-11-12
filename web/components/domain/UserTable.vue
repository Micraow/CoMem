<script lang="ts">
/**
 * 用户表（架构文档 §16 的用户与组页、§14 的 `/admin/users`）。
 *
 * 状态徽章只表达「能不能登录」：`active` 绿、`disabled` 灰。文字同时写出，
 * 颜色不单独表意（§16.1）。
 *
 * 删除按钮的确认文案由页面负责：它需要同时知道用户的授权节点数，而那个数字是
 * 列表响应的一部分（`permissionCount`），表格只负责把动作抛上去。
 */
import type { UserStatus } from '~/utils/userLabels'

/** `GET /admin/users` 的行。`permissionCount` 是删除确认要用的后果说明。 */
export interface UserRowPayload {
  readonly id: string
  readonly displayName: string
  readonly email: string | null
  /** 取值与领域层一致（`utils/userLabels.ts` 的 `UserStatus`）。 */
  readonly status: UserStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly permissionCount: number
}
</script>

<script setup lang="ts">
import { Pencil, Trash2, UserRound, Users } from 'lucide-vue-next'

import { formatDateTime } from '~/utils/format'
import { userStatusLabel } from '~/utils/userLabels'

const props = defineProps<{
  users: readonly UserRowPayload[]
  total: number
  limit: number
  offset: number
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  detail: [user: UserRowPayload]
  edit: [user: UserRowPayload]
  delete: [user: UserRowPayload]
  page: [offset: number]
}>()
</script>

<template>
  <div class="stack-16">
    <UiCallout v-if="props.error !== null">
      <template #icon><Users :size="15" :stroke-width="1.4" /></template>
      <div>{{ props.error }}</div>
    </UiCallout>

    <UiCard title="用户" panel flush>
      <template #actions>
        <span class="caption">共 {{ props.total }} 个</span>
      </template>

      <div v-if="props.loading && props.users.length === 0" class="skeleton-block">
        <UiSkeleton v-for="index in 5" :key="index" :width="`${76 - index * 6}%`" height="14px" />
      </div>

      <UiTable v-else-if="props.users.length > 0" caption="用户列表">
        <thead>
          <tr>
            <th>ID</th>
            <th>显示名</th>
            <th>邮箱</th>
            <th>状态</th>
            <th>创建时间</th>
            <th class="num">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in props.users" :key="user.id">
            <td class="mono strong">{{ user.id }}</td>
            <td>{{ user.displayName }}</td>
            <td>
              <span v-if="user.email !== null && user.email !== ''">{{ user.email }}</span>
              <span v-else class="faint">—</span>
            </td>
            <td>
              <UiBadge :variant="user.status === 'active' ? 'green' : 'gray'">
                {{ userStatusLabel(user.status) }}
              </UiBadge>
            </td>
            <td>
              <time class="mono" :title="formatDateTime(user.createdAt)">
                {{ formatDateTime(user.createdAt) }}
              </time>
            </td>
            <td class="num">
              <div class="rowflex rowflex--end">
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('detail', user)"
                >
                  <UserRound :size="13" :stroke-width="1.5" />
                  详情
                </UiButton>
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('edit', user)"
                >
                  <Pencil :size="13" :stroke-width="1.5" />
                  编辑
                </UiButton>
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="props.loading"
                  @click="emit('delete', user)"
                >
                  <Trash2 :size="13" :stroke-width="1.5" />
                  删除
                </UiButton>
              </div>
            </td>
          </tr>
        </tbody>
      </UiTable>

      <UiEmpty v-else v-slot="{ size }" title="还没有用户">
        <Users :size="size" :stroke-width="1.4" />
      </UiEmpty>

      <template v-if="props.total > props.limit" #foot>
        <UiPager
          :total="props.total"
          :limit="props.limit"
          :offset="props.offset"
          :shown="props.users.length"
          :loading="props.loading"
          @page="emit('page', $event)"
        />
      </template>
    </UiCard>
  </div>
</template>

<style scoped>
.rowflex--end {
  justify-content: flex-end;
}
</style>
