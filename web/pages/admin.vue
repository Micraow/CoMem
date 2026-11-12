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
 * 动作**没生效。前者进页面内的提示条，后者走 toast，不把整页标成坏的。口令不合规
 * 是例外：它属于「密码」这个字段，原文挂在该字段旁，不要求用户再看一眼 toast。
 *
 * ## 给账号设密码有三条路
 *
 * 新建时直接填（可选）、列表行内「设密码」、详情抽屉的「密码」页签。后者两个入口
 * 共用 `UserPasswordForm.vue`，校验与错误落点只有一份；新建对话框要把密码和账号
 * 信息一起提交，单独一套字段。
 *
 * 密码留空是合法状态：账号可以作为 ACL 主体存在、用 API Key 接入，只是不能登录。
 * 列表的「登录密码」列把这件事写出来，否则用户只会看到「用户名或密码错误」。
 *
 * ## 权限不足不是故障
 *
 * `/admin/users` 与 `/admin/groups` 都只给系统管理员（`auth.adminUserIds` 默认空，
 * 普通用户 403）。403 的服务端原文里写着配置项名，照抄到界面只会让用户去搜文档
 * （§11）；这里与概览页、任务表一致，显示「需要管理员权限」的空态，不显示成错误。
 * 重试不会改变结果。其它失败仍显示服务端消息——那是排查用的诊断信息。
 *
 * 侧栏入口不做角色隐藏：前端不知道谁是管理员（那需要后端暴露一个权限标志）。
 * 页内的「新建」按钮在 forbidden 时收起——页面已经说明了不能用，就不留一个注定
 * 失败的入口。
 */
import { Copy, Plus } from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, isForbidden, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { CLIPBOARD_DENIED_MESSAGE, copyToClipboard } from '~/utils/clipboard'
import { isRecord } from '~/utils/record'
import type { GroupRowPayload } from '~/components/domain/GroupTable.vue'
import type { UserRowPayload } from '~/components/domain/UserTable.vue'
import {
  USER_STATUSES,
  groupMemberRoleLabel,
  userStatusLabel,
  type GroupMemberRole,
  type UserStatus,
} from '~/utils/userLabels'

useHead({ title: '用户与组 · CoMem 控制台' })

type Tab = 'users' | 'groups'

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
  /** 取值与领域层一致（`utils/userLabels.ts` 的 `GroupMemberRole`）。 */
  readonly role: GroupMemberRole
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

/** 状态下拉框的选项：值与文案都来自同一张表，加一档时不会漏掉选项。 */
const STATUS_OPTIONS = USER_STATUSES.map((status) => ({
  value: status,
  label: userStatusLabel(status),
}))

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

/** 当前账号不是系统管理员。两个列表的门禁相同，所以一个状态就够，不显示成错误。 */
const forbidden = ref(false)

const userDialogOpen = ref(false)
const editingUser = ref<UserRowPayload | null>(null)
const detailUser = ref<UserRowPayload | null>(null)

/** 行内「设密码」打开的小对话框；为空表示关闭。 */
const passwordUser = ref<UserRowPayload | null>(null)
const passwordOpen = computed({
  get: () => passwordUser.value !== null,
  set: (open: boolean) => {
    if (!open) {
      passwordUser.value = null
    }
  },
})

const detailUserOpen = computed({
  get: () => detailUser.value !== null,
  set: (open: boolean) => {
    if (!open) {
      detailUser.value = null
    }
  },
})

const ownerInfo = ref<GroupRowPayload | null>(null)
const ownerOpen = computed({
  get: () => ownerInfo.value !== null,
  set: (open: boolean) => {
    if (!open) {
      ownerInfo.value = null
    }
  },
})
const ownerCommand = computed(() =>
  ownerInfo.value === null ? '' : `pnpm group:owner ${ownerInfo.value.id} <用户 ID>`,
)
const userForm = reactive({
  id: '',
  displayName: '',
  email: '',
  status: 'active' as UserStatus,
  /** 只在新建时有值：编辑走 `PATCH`，不携带密码。 */
  password: '',
  confirmPassword: '',
})
const userSaving = ref(false)

/** 新建对话框的字段级错误。只有密码相关字段会在本地校验。 */
const userErrors = ref<{ password?: string; confirmPassword?: string }>({})

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

const passwordDialogTitle = computed(() =>
  passwordUser.value === null ? '设密码' : `为 ${passwordUser.value.id} 设密码`,
)

/** 新建对话框里密码字段的说明与错误 id；错误出现后才把错误 id 加进去。 */
const newUserPasswordDescribedBy = computed(() => {
  const ids = ['create-user-password-hint']
  if (userErrors.value.password !== undefined) {
    ids.push('create-user-password-error')
  }
  return ids.join(' ')
})

const newUserPasswordConfirmDescribedBy = computed(() =>
  userErrors.value.confirmPassword === undefined
    ? undefined
    : 'create-user-password-confirm-error',
)

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
  forbidden.value = false
  try {
    const payload = await api.get<UserListPayload>('/admin/users', {
      limit: PAGE_SIZE,
      offset: usersOffset.value,
    })
    users.value = payload.users
    usersTotal.value = payload.total
  } catch (caught) {
    users.value = []
    usersTotal.value = 0
    if (isForbidden(caught)) {
      forbidden.value = true
    } else {
      usersError.value = errorMessageOf(caught)
    }
  } finally {
    usersLoading.value = false
  }
}

async function loadGroups(): Promise<void> {
  groupsLoading.value = true
  groupsError.value = null
  forbidden.value = false
  try {
    const payload = await api.get<GroupListPayload>('/admin/groups', {
      limit: PAGE_SIZE,
      offset: groupsOffset.value,
    })
    groups.value = payload.groups
    groupsTotal.value = payload.total
  } catch (caught) {
    groups.value = []
    groupsTotal.value = 0
    if (isForbidden(caught)) {
      forbidden.value = true
    } else {
      groupsError.value = errorMessageOf(caught)
    }
  } finally {
    groupsLoading.value = false
  }
}

function openUserDetail(user: UserRowPayload): void {
  detailUser.value = user
}

function openUserPassword(user: UserRowPayload): void {
  passwordUser.value = user
}

/**
 * 改完密码刷新列表里的状态徽章。
 *
 * 详情抽屉也走这条路：`detailUser` 是列表行的一份快照，不换掉的话同一个用户在
 * 抽屉里与表格里会显示两种状态。
 */
async function refreshUserRow(userId: string): Promise<void> {
  await loadUsers()
  if (detailUser.value !== null && detailUser.value.id === userId) {
    detailUser.value = users.value.find((user) => user.id === userId) ?? null
  }
}

async function onDialogPasswordSaved(): Promise<void> {
  const userId = passwordUser.value?.id
  passwordUser.value = null
  if (userId !== undefined) {
    await refreshUserRow(userId)
  }
}

async function onDetailPasswordSaved(): Promise<void> {
  const userId = detailUser.value?.id
  if (userId !== undefined) {
    await refreshUserRow(userId)
  }
}

async function copyOwnerCommand(): Promise<void> {
  if (ownerInfo.value === null) {
    return
  }
  if (!(await copyToClipboard(ownerCommand.value))) {
    toast.show('error', CLIPBOARD_DENIED_MESSAGE)
    return
  }
  toast.show('success', '已复制恢复命令')
}

function clearUserError(field: 'password' | 'confirmPassword'): void {
  if (userErrors.value[field] === undefined) {
    return
  }
  const next = { ...userErrors.value }
  delete next[field]
  userErrors.value = next
}

/**
 * 新建对话框的密码校验。
 *
 * 密码整体可选（留空 = 只作为 ACL 主体的账号），所以「两个都空」不是错误。
 * 填了一个就必须填另一个并保持一致——本地只能判断这两件事，强度由服务端判。
 */
function validateNewUserPassword(): boolean {
  const errors: { password?: string; confirmPassword?: string } = {}
  if (userForm.password !== '' && userForm.confirmPassword === '') {
    errors.confirmPassword = '请再次输入新密码。'
  } else if (userForm.confirmPassword !== userForm.password) {
    errors.confirmPassword = '两次输入的密码不一致。'
  }
  userErrors.value = errors
  return Object.keys(errors).length === 0
}

/**
 * 服务端把口令不合规标在 `details.field = 'password'` 上（`assertPasswordPolicy`）。
 * 400 且消息里点名密码是退路：没有 `details` 的实现也应该把原文放在字段旁。
 */
function passwordFieldErrorOf(caught: unknown): string | null {
  if (!(caught instanceof ApiClientError)) {
    return null
  }
  if (isRecord(caught.details) && caught.details['field'] === 'password') {
    return caught.message
  }
  return caught.statusCode === 400 && caught.message.includes('密码') ? caught.message : null
}

function openCreateUser(): void {
  editingUser.value = null
  userForm.id = ''
  userForm.displayName = ''
  userForm.email = ''
  userForm.status = 'active'
  userForm.password = ''
  userForm.confirmPassword = ''
  userErrors.value = {}
  userDialogOpen.value = true
}

function openEditUser(user: UserRowPayload): void {
  editingUser.value = user
  userForm.id = user.id
  userForm.displayName = user.displayName
  userForm.email = user.email ?? ''
  userForm.status = user.status
  userForm.password = ''
  userForm.confirmPassword = ''
  userErrors.value = {}
  userDialogOpen.value = true
}

async function saveUser(): Promise<void> {
  if (userSaving.value) {
    return
  }
  const editing = editingUser.value
  if (editing === null && !validateNewUserPassword()) {
    return
  }

  userSaving.value = true
  try {
    const email = userForm.email.trim()
    const password = userForm.password
    if (editing === null) {
      await api.post('/admin/users', {
        id: userForm.id.trim(),
        displayName: userForm.displayName.trim(),
        email: email === '' ? null : email,
        ...(password === '' ? {} : { password }),
      })
      toast.show(
        'success',
        password === ''
          ? '用户已创建。尚未设置密码，该账号暂时不能登录。'
          : '用户已创建，可以用密码登录。',
      )
    } else {
      await api.patch(`/admin/users/${encodeURIComponent(editing.id)}`, {
        displayName: userForm.displayName.trim(),
        email: email === '' ? null : email,
        status: userForm.status,
      })
      toast.show('success', '用户已更新')
    }
    userDialogOpen.value = false
    await loadUsers()
  } catch (caught) {
    const fieldMessage = editing === null ? passwordFieldErrorOf(caught) : null
    if (fieldMessage === null) {
      toast.show('error', errorMessageOf(caught))
    } else {
      userErrors.value = { password: fieldMessage }
    }
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
      <DomainPageHeader title="用户与组">
        <template v-if="!forbidden" #actions>
          <UiButton variant="primary" size="sm" @click="openCreate">
            <Plus :size="14" :stroke-width="1.8" />
            {{ createLabel }}
          </UiButton>
        </template>
      </DomainPageHeader>

      <UiTabs v-model="tab" :items="TABS" aria-label="用户与组" />

      <div class="mt-16">
        <UiCard v-if="forbidden" :title="tab === 'users' ? '用户' : '组'" panel flush>
          <UiEmpty forbidden />
        </UiCard>

        <DomainUserTable
          v-else-if="tab === 'users'"
          :users="users"
          :total="usersTotal"
          :limit="PAGE_SIZE"
          :offset="usersOffset"
          :loading="usersLoading"
          :error="usersError"
          @detail="openUserDetail"
          @edit="openEditUser"
          @password="openUserPassword"
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
          @owner-info="ownerInfo = $event"
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
            placeholder="用户 ID"
            aria-label="用户 ID"
          />
          <span class="field__hint">小写字母或数字开头，最长 64 个字符。</span>
        </label>
        <label class="field">
          <span class="field__label">显示名</span>
          <UiInput v-model="userForm.displayName" aria-label="显示名" />
        </label>
        <label class="field">
          <span class="field__label">邮箱</span>
          <UiInput
            v-model="userForm.email"
            placeholder="name@example.com"
            aria-label="邮箱"
          />
        </label>
        <label v-if="editingUser !== null" class="field">
          <span class="field__label">状态</span>
          <UiSelect v-model="userForm.status" :options="STATUS_OPTIONS" aria-label="用户状态" />
        </label>
        <template v-else>
          <div class="field">
            <label class="field__label" for="create-user-password">密码</label>
            <UiInput
              id="create-user-password"
              v-model="userForm.password"
              type="password"
              autocomplete="new-password"
              :disabled="userSaving"
              :aria-describedby="newUserPasswordDescribedBy"
              @update:model-value="clearUserError('password')"
            />
            <span id="create-user-password-hint" class="field__hint">
              留空则账号暂时不能登录，之后可以在详情里设置密码。
            </span>
            <span
              v-if="userErrors.password !== undefined"
              id="create-user-password-error"
              class="field__error"
              role="alert"
            >
              {{ userErrors.password }}
            </span>
          </div>
          <div class="field">
            <label class="field__label" for="create-user-password-confirm">确认密码</label>
            <UiInput
              id="create-user-password-confirm"
              v-model="userForm.confirmPassword"
              type="password"
              autocomplete="new-password"
              :disabled="userSaving"
              :aria-describedby="newUserPasswordConfirmDescribedBy"
              @update:model-value="clearUserError('confirmPassword')"
            />
            <span
              v-if="userErrors.confirmPassword !== undefined"
              id="create-user-password-confirm-error"
              class="field__error"
              role="alert"
            >
              {{ userErrors.confirmPassword }}
            </span>
          </div>
        </template>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="userDialogOpen = false">取消</UiButton>
          <UiButton variant="primary" type="submit" :disabled="userSaving">
            {{ editingUser === null ? '创建' : '保存' }}
          </UiButton>
        </div>
      </form>
    </UiDialog>

    <DomainUserDetail
      v-model="detailUserOpen"
      :user="detailUser"
      @password-saved="onDetailPasswordSaved"
    />

    <UiDialog v-model="passwordOpen" :title="passwordDialogTitle">
      <DomainUserPasswordForm
        v-if="passwordUser !== null"
        :user-id="passwordUser.id"
        submit-label="设密码"
        cancel-label="取消"
        @saved="onDialogPasswordSaved"
        @cancel="passwordUser = null"
      />
    </UiDialog>

    <UiDialog v-model="ownerOpen" title="恢复组的所有者">
      <div class="stack-16">
        <p class="body-sm muted">
          组 {{ ownerInfo?.id }} 没有所有者，控制台无法修改它的权限或成员。恢复需要在一台能访问本仓库的机器上执行：
        </p>
        <code class="command">{{ ownerCommand }}</code>
        <p class="body-sm muted">
          第一个参数是组 ID，第二个是要接手的用户 ID（必须已存在）。详细步骤见仓库文档
          docs/operations.md 的「恢复组的 owner」。
        </p>
        <div class="rowflex">
          <span class="spacer" />
          <UiButton variant="secondary" @click="copyOwnerCommand">
            <Copy :size="14" :stroke-width="1.5" />
            复制命令
          </UiButton>
          <UiButton variant="primary" @click="ownerInfo = null">关闭</UiButton>
        </div>
      </div>
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
            placeholder="组 ID"
            aria-label="组 ID"
          />
          <span class="field__hint">小写字母或数字开头，最长 64 个字符。</span>
        </label>
        <label class="field">
          <span class="field__label">显示名</span>
          <UiInput v-model="groupForm.displayName" aria-label="组显示名" />
        </label>
        <label class="field">
          <span class="field__label">描述</span>
          <UiTextarea
            v-model="groupForm.description"
            :rows="3"
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

        <UiErrorCallout v-if="membersError !== null" :message="membersError" />

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
              <td>{{ groupMemberRoleLabel(member.role) }}</td>
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

        <UiEmpty v-else title="还没有成员" />

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

.field__error {
  font-size: 13px;
  line-height: 1.45;
  color: var(--red-ink);
  word-break: break-word;
}

.member-input {
  flex: 1;
  min-width: 160px;
}

/* 左侧抽屉的 `.dialog__body` 去掉了内边距（移动端导航复用同一套样式）。 */
.drawer-body {
  padding: 20px;
}

.command {
  display: block;
  padding: 12px;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
