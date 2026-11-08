<script setup lang="ts">
/**
 * 用户与组（架构文档 §16 的第五页、§12 的权限模型、§14 的 `/admin/*`）。
 *
 * 两个 tab 共用一份页面：用户是「谁能登录」，组是「授权主体的集合」。组成员关系
 * 只影响身份展开（`user:` + `group:`），不影响 ACL 的存储形状（§12.5）。
 *
 * ## 删除确认必须说清后果
 *
 * 删除用户会撤销它授权的节点（服务端在同一个事务里删 `node_permission` 与
 * `acl_entry`）。确认框里写出「多少个节点会失去授权」，而不是只问「确定吗」。
 * 删除组时成员关系也会一并删除，这句话同样写出来。
 *
 * ## 错误分两层
 *
 * 列表加载失败说明这一屏没有数据；创建、编辑、删除、加成员失败只说明**刚才那个
 * 动作**没生效。前者进页面内的提示条，后者走 toast，不把整页标成坏的。
 */
import { AlertTriangle, Plus } from 'lucide-vue-next'

import { errorMessageOf, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import type { GroupRowPayload } from '~/components/domain/GroupTable.vue'
import type { UserRowPayload } from '~/components/domain/UserTable.vue'

useHead({ title: '用户与组 · CoMem 控制台' })

type Tab = 'users' | 'groups'
type UserStatus = 'active' | 'disabled'

interface UserListPayload {
  readonly users: readonly UserRowPayload[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

interface GroupListPayload {
  readonly groups: readonly GroupRowPayload[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

interface GroupMemberPayload {
  readonly groupId: string
  readonly userId: string
  readonly role: 'owner' | 'member'
  readonly addedAt: string
}

interface MemberListPayload {
  readonly groupId: string
  readonly members: readonly GroupMemberPayload[]
  readonly total: number
}

interface DeleteResult {
  readonly revokedPermissions: number
}

const TABS = [
  { value: 'users', label: '用户' },
  { value: 'groups', label: '组' },
] as const

const STATUS_OPTIONS = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '已禁用' },
] as const

/** 单页条数。与 API 的默认值一致：控制台一页 100 个用户已经要滚动。 */
const PAGE_SIZE = 100

const api = useApi()
const toast = useToast()

const tab = ref<Tab>('users')

const users = ref<readonly UserRowPayload[]>([])
const usersTotal = ref(0)
const usersOffset = ref(0)
const usersLoading = ref(false)
const usersError = ref<string | null>(null)

const groups = ref<readonly GroupRowPayload[]>([])
const groupsTotal = ref(0)
const groupsOffset = ref(0)
const groupsLoading = ref(false)
const groupsError = ref<string | null>(null)

const userDialogOpen = ref(false)
const editingUser = ref<UserRowPayload | null>(null)
const userForm = reactive({ id: '', displayName: '', email: '', status: 'active' as UserStatus })
const userSaving = ref(false)

const groupDialogOpen = ref(false)
const editingGroup = ref<GroupRowPayload | null>(null)
const groupForm = reactive({ id: '', displayName: '', description: '' })
const groupSaving = ref(false)

const pendingDelete = ref<{
  readonly kind: 'user' | 'group'
  readonly id: string
  readonly permissionCount: number
} | null>(null)
const deleting = ref(false)

const detailGroup = ref<GroupRowPayload | null>(null)
const members = ref<readonly GroupMemberPayload[]>([])
const membersLoading = ref(false)
const membersError = ref<string | null>(null)
const memberInput = ref('')
const addingMember = ref(false)
const removingMember = ref<string | null>(null)

const detailOpen = computed({
  get: () => detailGroup.value !== null,
  set: (open: boolean) => {
    if (!open) {
      detailGroup.value = null
    }
  },
})

const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (open: boolean) => {
    if (!open) {
      pendingDelete.value = null
    }
  },
})

const createLabel = computed(() => (tab.value === 'users' ? '新建用户' : '新建组'))

const deleteTitle = computed(() =>
  pendingDelete.value?.kind === 'group' ? '删除组' : '删除用户',
)

const deleteMessage = computed(() => {
  const target = pendingDelete.value
  if (target === null) {
    return ''
  }
  if (target.kind === 'group') {
    return target.permissionCount > 0
      ? `删除组 ${target.id}？它授权的 ${target.permissionCount} 个节点会失去授权，成员关系也会一并删除。此操作无法撤销。`
      : `删除组 ${target.id}？成员关系也会一并删除。此操作无法撤销。`
  }
  return target.permissionCount > 0
    ? `删除用户 ${target.id}？它授权的 ${target.permissionCount} 个节点会失去授权。此操作无法撤销。`
    : `删除用户 ${target.id}？这个用户还没有被授权任何节点。此操作无法撤销。`
})

async function loadUsers(): Promise<void> {
  usersLoading.value = true
  usersError.value = null
  try {
    const payload = await api.get<UserListPayload>('/admin/users', {
      limit: PAGE_SIZE,
      offset: usersOffset.value,
    })
    users.value = payload.users
    usersTotal.value = payload.total
  } catch (caught) {
    usersError.value = errorMessageOf(caught)
    users.value = []
    usersTotal.value = 0
  } finally {
    usersLoading.value = false
  }
}

async function loadGroups(): Promise<void> {
  groupsLoading.value = true
  groupsError.value = null
  try {
    const payload = await api.get<GroupListPayload>('/admin/groups', {
      limit: PAGE_SIZE,
      offset: groupsOffset.value,
    })
    groups.value = payload.groups
    groupsTotal.value = payload.total
  } catch (caught) {
    groupsError.value = errorMessageOf(caught)
    groups.value = []
    groupsTotal.value = 0
  } finally {
    groupsLoading.value = false
  }
}

function openCreateUser(): void {
  editingUser.value = null
  userForm.id = ''
  userForm.displayName = ''
  userForm.email = ''
  userForm.status = 'active'
  userDialogOpen.value = true
}

function openEditUser(user: UserRowPayload): void {
  editingUser.value = user
  userForm.id = user.id
  userForm.displayName = user.displayName
  userForm.email = user.email ?? ''
  userForm.status = user.status
  userDialogOpen.value = true
}

async function saveUser(): Promise<void> {
  if (userSaving.value) {
    return
  }
  userSaving.value = true
  try {
    const email = userForm.email.trim()
    if (editingUser.value === null) {
      await api.post('/admin/users', {
        id: userForm.id.trim(),
        displayName: userForm.displayName.trim(),
        email: email === '' ? null : email,
      })
      toast.show('success', '用户已创建')
    } else {
      await api.patch(`/admin/users/${encodeURIComponent(editingUser.value.id)}`, {
        displayName: userForm.displayName.trim(),
        email: email === '' ? null : email,
        status: userForm.status,
      })
      toast.show('success', '用户已更新')
    }
    userDialogOpen.value = false
    await loadUsers()
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    userSaving.value = false
  }
}

function openCreateGroup(): void {
  editingGroup.value = null
  groupForm.id = ''
  groupForm.displayName = ''
  groupForm.description = ''
  groupDialogOpen.value = true
}

function openEditGroup(group: GroupRowPayload): void {
  editingGroup.value = group
  groupForm.id = group.id
  groupForm.displayName = group.displayName
  groupForm.description = group.description ?? ''
  groupDialogOpen.value = true
}

async function saveGroup(): Promise<void> {
  if (groupSaving.value) {
    return
  }
  groupSaving.value = true
  try {
    const description = groupForm.description.trim()
    if (editingGroup.value === null) {
      await api.post('/admin/groups', {
        id: groupForm.id.trim(),
        displayName: groupForm.displayName.trim(),
        description: description === '' ? null : description,
      })
      toast.show('success', '组已创建')
    } else {
      await api.patch(`/admin/groups/${encodeURIComponent(editingGroup.value.id)}`, {
        displayName: groupForm.displayName.trim(),
        description: description === '' ? null : description,
      })
      toast.show('success', '组已更新')
    }
    groupDialogOpen.value = false
    await loadGroups()
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    groupSaving.value = false
  }
}

function requestDeleteUser(user: UserRowPayload): void {
  pendingDelete.value = {
    kind: 'user',
    id: user.id,
    permissionCount: user.permissionCount,
  }
}

function requestDeleteGroup(group: GroupRowPayload): void {
  pendingDelete.value = {
    kind: 'group',
    id: group.id,
    permissionCount: group.permissionCount,
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (target === null || deleting.value) {
    return
  }
  deleting.value = true
  try {
    const result =
      target.kind === 'user'
        ? await api.del<DeleteResult>(`/admin/users/${encodeURIComponent(target.id)}`)
        : await api.del<DeleteResult>(`/admin/groups/${encodeURIComponent(target.id)}`)
    toast.show(
      'success',
      `已删除${target.kind === 'user' ? '用户' : '组'} ${target.id}，撤销了 ${result.revokedPermissions} 条授权`,
    )
    pendingDelete.value = null
    await Promise.all([loadUsers(), loadGroups()])
    if (detailGroup.value !== null) {
      await loadMembers(detailGroup.value.id)
    }
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    deleting.value = false
  }
}

async function loadMembers(groupId: string): Promise<void> {
  membersLoading.value = true
  membersError.value = null
  try {
    const payload = await api.get<MemberListPayload>(
      `/admin/groups/${encodeURIComponent(groupId)}/members`,
    )
    members.value = payload.members
  } catch (caught) {
    membersError.value = errorMessageOf(caught)
    members.value = []
  } finally {
    membersLoading.value = false
  }
}

function openMembers(group: GroupRowPayload): void {
  detailGroup.value = group
  memberInput.value = ''
  members.value = []
  membersError.value = null
  void loadMembers(group.id)
}

async function addMember(): Promise<void> {
  const group = detailGroup.value
  const userId = memberInput.value.trim()
  if (group === null || userId === '' || addingMember.value) {
    return
  }
  addingMember.value = true
  try {
    await api.post(`/admin/groups/${encodeURIComponent(group.id)}/members`, { userId })
    memberInput.value = ''
    toast.show('success', `已把 ${userId} 加入 ${group.id}`)
    await Promise.all([loadMembers(group.id), loadGroups()])
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    addingMember.value = false
  }
}

async function removeMember(userId: string): Promise<void> {
  const group = detailGroup.value
  if (group === null || removingMember.value !== null) {
    return
  }
  removingMember.value = userId
  try {
    await api.del(
      `/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(userId)}`,
    )
    toast.show('success', `已把 ${userId} 移出 ${group.id}`)
    await Promise.all([loadMembers(group.id), loadGroups()])
  } catch (caught) {
    toast.show('error', errorMessageOf(caught))
  } finally {
    removingMember.value = null
  }
}

function pageUsers(offset: number): void {
  usersOffset.value = offset
  void loadUsers()
}

function pageGroups(offset: number): void {
  groupsOffset.value = offset
  void loadGroups()
}

function openCreate(): void {
  if (tab.value === 'users') {
    openCreateUser()
  } else {
    openCreateGroup()
  }
}

onMounted(() => {
  void Promise.all([loadUsers(), loadGroups()])
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader
        title="用户与组"
        description="用户列表、组列表与组成员维护。"
      >
        <template #actions>
          <UiButton variant="primary" size="sm" @click="openCreate">
            <Plus :size="14" :stroke-width="1.8" />
            {{ createLabel }}
          </UiButton>
        </template>
      </DomainPageHeader>

      <UiTabs v-model="tab" :items="TABS" aria-label="用户与组" />

      <div class="mt-16">
        <DomainUserTable
          v-if="tab === 'users'"
          :users="users"
          :total="usersTotal"
          :limit="PAGE_SIZE"
          :offset="usersOffset"
          :loading="usersLoading"
          :error="usersError"
          @edit="openEditUser"
          @delete="requestDeleteUser"
          @page="pageUsers"
        />

        <DomainGroupTable
          v-else
          :groups="groups"
          :total="groupsTotal"
          :limit="PAGE_SIZE"
          :offset="groupsOffset"
          :loading="groupsLoading"
          :error="groupsError"
          @members="openMembers"
          @edit="openEditGroup"
          @delete="requestDeleteGroup"
          @page="pageGroups"
        />
      </div>
    </div>

    <UiDialog
      v-model="userDialogOpen"
      :title="editingUser === null ? '新建用户' : '编辑用户'"
    >
      <form class="stack-16" @submit.prevent="saveUser">
        <label class="field">
          <span class="field__label">ID</span>
          <UiInput
            v-model="userForm.id"
            :disabled="editingUser !== null"
            placeholder="alice"
            aria-label="用户 ID"
          />
          <span class="field__hint">小写字母或数字开头，最长 64 个字符。</span>
        </label>
        <label class="field">
          <span class="field__label">显示名</span>
          <UiInput v-model="userForm.displayName" placeholder="Alice" aria-label="显示名" />
        </label>
        <label class="field">
          <span class="field__label">邮箱</span>
          <UiInput
            v-model="userForm.email"
            placeholder="alice@example.com"
            aria-label="邮箱"
          />
        </label>
        <label v-if="editingUser !== null" class="field">
          <span class="field__label">状态</span>
          <UiSelect v-model="userForm.status" :options="STATUS_OPTIONS" aria-label="用户状态" />
        </label>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="userDialogOpen = false">取消</UiButton>
          <UiButton variant="primary" type="submit" :disabled="userSaving">
            {{ editingUser === null ? '创建' : '保存' }}
          </UiButton>
        </div>
      </form>
    </UiDialog>

    <UiDialog
      v-model="groupDialogOpen"
      :title="editingGroup === null ? '新建组' : '编辑组'"
    >
      <form class="stack-16" @submit.prevent="saveGroup">
        <label class="field">
          <span class="field__label">ID</span>
          <UiInput
            v-model="groupForm.id"
            :disabled="editingGroup !== null"
            placeholder="eng"
            aria-label="组 ID"
          />
          <span class="field__hint">小写字母或数字开头，最长 64 个字符。</span>
        </label>
        <label class="field">
          <span class="field__label">显示名</span>
          <UiInput v-model="groupForm.displayName" placeholder="工程组" aria-label="组显示名" />
        </label>
        <label class="field">
          <span class="field__label">描述</span>
          <UiTextarea
            v-model="groupForm.description"
            :rows="3"
            placeholder="这个组负责什么"
            aria-label="组描述"
          />
        </label>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="groupDialogOpen = false">取消</UiButton>
          <UiButton variant="primary" type="submit" :disabled="groupSaving">
            {{ editingGroup === null ? '创建' : '保存' }}
          </UiButton>
        </div>
      </form>
    </UiDialog>

    <UiDialog v-model="detailOpen" placement="left" :title="detailGroup === null ? '组成员' : `组 ${detailGroup.id}`">
      <div class="stack-16 drawer-body">
        <p class="caption">共 {{ members.length }} 个成员</p>

        <div v-if="membersError !== null" class="callout callout--danger">
          <AlertTriangle :size="15" :stroke-width="1.4" />
          <div>{{ membersError }}</div>
        </div>

        <div v-else-if="membersLoading" class="stack-12">
          <UiSkeleton v-for="index in 4" :key="index" :width="`${70 - index * 6}%`" height="14px" />
        </div>

        <UiTable v-else-if="members.length > 0" caption="组成员">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th class="num">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in members" :key="member.userId">
              <td class="mono strong">{{ member.userId }}</td>
              <td>{{ member.role === 'owner' ? '所有者' : '成员' }}</td>
              <td class="num">
                <UiButton
                  variant="plain"
                  size="sm"
                  :disabled="removingMember !== null"
                  @click="removeMember(member.userId)"
                >
                  移出
                </UiButton>
              </td>
            </tr>
          </tbody>
        </UiTable>

        <div v-else class="empty">
          <span class="empty__title">还没有成员</span>
        </div>

        <form class="rowflex" @submit.prevent="addMember">
          <UiInput
            v-model="memberInput"
            class="member-input"
            placeholder="用户 ID"
            aria-label="要添加的用户 ID"
          />
          <UiButton
            variant="primary"
            type="submit"
            :disabled="addingMember || memberInput.trim() === ''"
          >
            添加
          </UiButton>
        </form>
      </div>
    </UiDialog>

    <UiDialog v-model="deleteOpen" :title="deleteTitle">
      <div class="stack-16">
        <p class="body-sm muted">{{ deleteMessage }}</p>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="pendingDelete = null">取消</UiButton>
          <UiButton variant="danger" :disabled="deleting" @click="confirmDelete">删除</UiButton>
        </div>
      </div>
    </UiDialog>

    <UiToast />
  </div>
</template>

<style scoped>
.field {
  display: grid;
  gap: 6px;
}

.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-2);
}

.field__hint {
  font-size: 13px;
  line-height: 1.4;
  color: var(--label-3);
}

.member-input {
  flex: 1;
  min-width: 160px;
}

/* 左侧抽屉的 `.dialog__body` 去掉了内边距（移动端导航复用同一套样式）。 */
.drawer-body {
  padding: 20px;
}
</style>
