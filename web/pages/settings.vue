<script setup lang="ts">
/**
 * 设置（架构文档 §18 的配置模型、`docs/operations.md` 的「在控制台里改设置」）。
 *
 * 页面把 `GET /api/v1/config` 的 84 个叶子按 `group` 分组，首屏只展开「模型 /
 * 向量 / 重排」三组，其余折叠。每一项都显示中文名、路径、当前值与**来源徽章**
 * （默认值 / 配置文件 / 覆盖文件 / 环境变量）——来源是本页最有价值的一列，它回答
 * 「为什么我改了不生效」。不可编辑项不隐藏，显示原因并禁用控件。
 *
 * ## 保存不等于生效
 *
 * 服务端只在启动时读一次配置，`PATCH` 只写覆盖文件。保存成功后显示不可关闭的提示条
 * 与两条重启命令；页面任何地方都不写「已应用」。连接测试同样标注「测的是当前正在
 * 运行的配置」，否则「保存 + 测试通过」会被当成已生效。
 *
 * ## 环境变量遮住的项
 *
 * 服务端返回 400 并在消息里点名 `COMEM_...`。错误原文显示在对应字段旁（`details.field`
 * 定位，找不到就退回消息里找路径），不翻译成「保存失败」——用户需要看到是哪个环境
 * 变量压过了这一页。
 */
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  PlugZap,
  RefreshCw,
  Trash2,
} from 'lucide-vue-next'

import { ApiClientError, errorMessageOf, isForbidden, useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import {
  CONFIG_TEST_TARGETS,
  INITIALLY_EXPANDED_GROUPS,
  LOCAL_INFERENCE_DIMENSION,
  RESTART_COMMANDS,
  TEST_SCOPE_NOTE,
  buildPatchValues,
  draftOf,
  errorHintOf,
  fieldControlOf,
  fieldHintOf,
  fieldLabelOf,
  fieldOptionsOf,
  fieldPathOfError,
  groupSettings,
  inferenceFillDrafts,
  restartNoticeOf,
  sourceLabelOf,
  sourceNoteOf,
  sourceToneOf,
  testSummaryOf,
  testTypePathOf,
  valueDisplayOf,
  type ConfigGroup,
  type ConfigItemView,
  type ConfigTestPayload,
  type ConfigTestTarget,
  type ConfigViewPayload,
  type LocalInferenceFillKind,
  type LocalInferenceStartPayload,
  type LocalInferenceStatusPayload,
} from '~/utils/settings'

useHead({ title: '设置 · CoMem 控制台' })

interface ProbeState {
  readonly status: 'idle' | 'running' | 'done' | 'skipped'
  readonly result: ConfigTestPayload | null
  readonly error: string | null
}

function idleProbe(): ProbeState {
  return { status: 'idle', result: null, error: null }
}

const api = useApi()
const toast = useToast()

const view = ref<ConfigViewPayload | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const forbidden = ref(false)

const drafts = ref<Readonly<Record<string, string>>>({})
const cleared = ref<ReadonlySet<string>>(new Set())
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const saveError = ref<string | null>(null)
const saveResult = ref<{ readonly written: number; readonly overridePath: string } | null>(null)
const saving = ref(false)

/**
 * 已写进覆盖文件、但还没成为运行值的项。`value` 是按配置类型转换后的值，
 * `draft` 是保存时输入框里的原文——用户再改它，这一项就重新算「待保存」。
 *
 * 保存后**不重新 GET**：`GET /config` 回的是启动快照，重新拉取会把刚填的值
 * 覆盖回旧值。表单继续用用户填的值，等重启（或用户点「重新读取运行中配置」）。
 */
interface PendingSave {
  readonly draft: string
  readonly value: unknown
}

const pending = ref<Readonly<Record<string, PendingSave>>>({})

const expanded = ref<ReadonlySet<ConfigGroup>>(new Set(INITIALLY_EXPANDED_GROUPS))
const probes = ref<Readonly<Record<ConfigTestTarget, ProbeState>>>(
  Object.fromEntries(CONFIG_TEST_TARGETS.map((target) => [target, idleProbe()])) as Record<
    ConfigTestTarget,
    ProbeState
  >,
)

/**
 * 本地推理卡片的状态与它自己的请求。
 *
 * 与 `/config` 分开取数：这一块失败不应挡住其余设置项，反之亦然（§16 的
 * 「一个页面的多个区域各自取数」）。启动请求最长 25 秒，`useApi` 的 30 秒超时
 * 覆盖得住。
 */
const inference = ref<LocalInferenceStatusPayload | null>(null)
const inferenceLoading = ref(false)
const inferenceAction = ref<'idle' | 'starting' | 'stopping'>('idle')
const inferenceError = ref<string | null>(null)

const items = computed<readonly ConfigItemView[]>(() => view.value?.items ?? [])
const groups = computed(() => groupSettings(items.value))

/** 判断两个配置值是否相同（数组与标量都走 JSON 序列化）。 */
function sameValueOf(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 一项待生效的保存是否已经在运行值里。
 *
 * 密钥没有明文可比，用「是否已设置 + 末 4 位掩码」判断；其余项直接比类型化值。
 * 重启后 `GET /config` 返回覆盖文件里的值，这项就自动从待生效里消失。
 */
function isApplied(item: ConfigItemView, saved: PendingSave): boolean {
  if (item.secret) {
    // 密钥没有明文可比：来源必须是覆盖文件，再用末 4 位确认掩码。
    if (item.source !== 'override') {
      return false
    }
    if (saved.value === '') {
      return !item.configured
    }
    return (
      item.configured &&
      item.masked !== null &&
      item.masked.endsWith(String(saved.value).slice(-4))
    )
  }
  return sameValueOf(item.value, saved.value)
}

/**
 * 把待生效的值当成比较基线：`buildPatchValues` 只提交相对覆盖文件的改动。
 *
 * 没有这一层，保存后草稿仍相对运行值有差异，页头会一直显示「待保存」。
 */
const baselineItems = computed<readonly ConfigItemView[]>(() =>
  items.value.map((item) => {
    const saved = pending.value[item.path]
    return saved === undefined ? item : { ...item, value: saved.value }
  }),
)

const preview = computed(() =>
  buildPatchValues(baselineItems.value, drafts.value, cleared.value),
)

/** 这一项的草稿是否就是上次成功保存的原文。 */
function pendingSavedOf(path: string): boolean {
  const saved = pending.value[path]
  return saved !== undefined && drafts.value[path] === saved.draft
}

const pendingCount = computed(() => Object.keys(pending.value).length)

const dirtyCount = computed(() =>
  Object.keys(preview.value.values).filter((path) => !pendingSavedOf(path)).length,
)

const canSave = computed(
  () =>
    !saving.value &&
    view.value !== null &&
    view.value.overrideWritable &&
    dirtyCount.value > 0 &&
    Object.keys(preview.value.errors).length === 0,
)

function inputIdOf(path: string): string {
  return `config-${path.replaceAll('.', '-')}`
}

function probeOf(target: ConfigTestTarget | null): ProbeState {
  return target === null ? idleProbe() : probes.value[target]
}

function probeResultOf(target: ConfigTestTarget | null): ConfigTestPayload | null {
  return probeOf(target).result
}

function probeOkOf(target: ConfigTestTarget | null): boolean {
  return probeResultOf(target)?.ok === true
}

function probeSummaryOf(target: ConfigTestTarget | null): string {
  const result = probeResultOf(target)
  return result === null ? '' : testSummaryOf(result)
}

function probeDetailOf(target: ConfigTestTarget | null): string {
  const state = probeOf(target)
  return state.result?.detail ?? state.error ?? ''
}

function displayErrorOf(item: ConfigItemView): string | null {
  return fieldErrors.value[item.path] ?? preview.value.errors[item.path] ?? null
}

function describedByOf(item: ConfigItemView): string | undefined {
  const id = inputIdOf(item.path)
  const ids: string[] = []
  if (!item.editable && item.reason !== undefined) {
    ids.push(`${id}-reason`)
  }
  if (displayErrorOf(item) !== null) {
    ids.push(`${id}-error`)
  }
  return ids.length === 0 ? undefined : ids.join(' ')
}

/**
 * 改掉某组供应商的 `type` 后，上一轮「已停用」的测试结论就不再对应当前表单。
 * 这里只清掉这一组的测试状态，结果区不会顶着旧结论。
 */
function clearProbeForTypePath(path: string): void {
  for (const target of CONFIG_TEST_TARGETS) {
    if (testTypePathOf(target) !== path || probes.value[target].status === 'idle') {
      continue
    }
    probes.value = { ...probes.value, [target]: idleProbe() }
  }
}

function setDraft(path: string, value: string): void {
  drafts.value = { ...drafts.value, [path]: value }
  clearProbeForTypePath(path)
  if (fieldErrors.value[path] !== undefined) {
    const next = { ...fieldErrors.value }
    delete next[path]
    fieldErrors.value = next
  }
}

function setBoolean(path: string, event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) {
    setDraft(path, target.checked ? 'true' : 'false')
  }
}

function toggleClear(path: string): void {
  const next = new Set(cleared.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
    setDraft(path, '')
  }
  cleared.value = next
}

function toggleGroup(group: ConfigGroup): void {
  const next = new Set(expanded.value)
  if (next.has(group)) {
    next.delete(group)
  } else {
    next.add(group)
  }
  expanded.value = next
}

function resetDrafts(
  next: readonly ConfigItemView[],
  saved: Readonly<Record<string, PendingSave>> = {},
): void {
  drafts.value = Object.fromEntries(
    next.map((item) => {
      const entry = saved[item.path]
      return [item.path, entry === undefined ? draftOf(item) : entry.draft]
    }),
  )
  cleared.value = new Set()
  fieldErrors.value = {}
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  forbidden.value = false
  try {
    const payload = await api.get<ConfigViewPayload>('/config')
    // 重启后已经生效的项从待生效里移除；重启前仍保留，表单继续显示用户填的值。
    const nextPending = Object.fromEntries(
      Object.entries(pending.value).filter(([path, saved]) => {
        const item = payload.items.find((candidate) => candidate.path === path)
        return item !== undefined && !isApplied(item, saved)
      }),
    )
    const hadPending = Object.keys(pending.value).length > 0
    const appliedAll = hadPending && Object.keys(nextPending).length === 0
    pending.value = nextPending
    view.value = payload
    resetDrafts(payload.items, nextPending)
    if (appliedAll) {
      // 重启后所有待生效项都成为运行值，旧的成功提示不再成立。
      saveResult.value = null
      saveError.value = null
    }
  } catch (caught) {
    view.value = null
    if (isForbidden(caught)) {
      forbidden.value = true
    } else {
      loadError.value = errorMessageOf(caught)
    }
  } finally {
    loading.value = false
  }
}

/**
 * 放弃本地修改并回到正在运行的配置。
 *
 * 保存过的值仍在覆盖文件里；这里只是不再把它们当表单基线，避免用户以为
 * 「不重启也能看到保存的旧值」。
 */
async function reloadRunning(): Promise<void> {
  pending.value = {}
  saveResult.value = null
  saveError.value = null
  await load()
}

async function save(): Promise<void> {
  if (saving.value) {
    return
  }

  const { values: previewValues, errors } = buildPatchValues(
    baselineItems.value,
    drafts.value,
    cleared.value,
  )
  // 上一轮已经保存、这次没再改的密钥不要重复提交（非密钥项已由基线排除）。
  const values = Object.fromEntries(
    Object.entries(previewValues).filter(([path]) => !pendingSavedOf(path)),
  )
  if (Object.keys(errors).length > 0 || Object.keys(values).length === 0) {
    return
  }

  saving.value = true
  saveError.value = null
  fieldErrors.value = {}
  try {
    const result = await api.patch<{
      readonly written: number
      readonly overridePath: string
      readonly restartRequired: true
    }>('/config', { values })
    const nextPending = { ...pending.value }
    for (const [path, value] of Object.entries(values)) {
      const item = items.value.find((candidate) => candidate.path === path)
      if (item !== undefined && !item.secret && sameValueOf(item.value, value)) {
        // 改回了运行值：覆盖文件里写的值与运行值相同，没有「待生效」可言。
        delete nextPending[path]
      } else {
        nextPending[path] = { draft: drafts.value[path] ?? '', value }
      }
    }
    pending.value = nextPending
    saveResult.value = { written: result.written, overridePath: result.overridePath }
    toast.show('success', `已写入 ${result.written} 项设置，重启后生效`)
    // **不要重新 GET `/config`**：它回的是启动快照，会把刚填的值覆盖回旧值。
  } catch (caught) {
    const message = errorMessageOf(caught)
    const details = caught instanceof ApiClientError ? caught.details : undefined
    const path = fieldPathOfError(
      message,
      details,
      items.value.map((item) => item.path),
    )
    if (path !== null) {
      fieldErrors.value = { [path]: message }
    } else {
      saveError.value = isForbidden(caught) ? '需要系统管理员权限。' : message
    }
  } finally {
    saving.value = false
  }
}

/**
 * 这一组的类型是不是「停用」。用正在运行的配置判断：连接测试测的是运行中的配置，
 * 不是刚改、还没保存的草稿。类型停用时没有供应商可连，发请求只会得到参数错误。
 */
function typeDisabledOf(target: ConfigTestTarget): boolean {
  const path = testTypePathOf(target)
  return items.value.find((item) => item.path === path)?.value === 'disabled'
}

/** 把「去启用」落到该组的类型选择框上：展开分组、聚焦并滚到它。 */
function revealTypeField(target: ConfigTestTarget): void {
  const next = new Set<ConfigGroup>(expanded.value)
  next.add(target)
  expanded.value = next
  void nextTick(() => {
    const element = document.getElementById(inputIdOf(testTypePathOf(target)))
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.focus()
  })
}

async function test(target: ConfigTestTarget | null): Promise<void> {
  if (target === null || probeOf(target).status === 'running') {
    return
  }

  if (typeDisabledOf(target)) {
    probes.value = {
      ...probes.value,
      [target]: { status: 'skipped', result: null, error: null },
    }
    return
  }

  probes.value = { ...probes.value, [target]: { status: 'running', result: null, error: null } }
  try {
    const result = await api.post<ConfigTestPayload>('/config/test', { target })
    probes.value = { ...probes.value, [target]: { status: 'done', result, error: null } }
  } catch (caught) {
    probes.value = {
      ...probes.value,
      [target]: { status: 'done', result: null, error: errorMessageOf(caught) },
    }
  }
}

async function loadInference(): Promise<void> {
  inferenceLoading.value = true
  try {
    inference.value = await api.get<LocalInferenceStatusPayload>('/inference/local')
    inferenceError.value = null
  } catch (caught) {
    inferenceError.value = isForbidden(caught) ? '需要系统管理员权限。' : errorMessageOf(caught)
  } finally {
    inferenceLoading.value = false
  }
}

async function startInference(): Promise<void> {
  if (inferenceAction.value !== 'idle') {
    return
  }
  inferenceAction.value = 'starting'
  inferenceError.value = null
  try {
    const result = await api.post<LocalInferenceStartPayload>('/inference/local/start', {})
    toast.show(
      'success',
      result.dimension === null
        ? '本地推理服务已就绪'
        : `本地推理服务已就绪（${String(result.dimension)} 维）`,
    )
  } catch (caught) {
    // 409 表示进程起来了但没就绪；服务端消息里带原因，原样显示。
    inferenceError.value = isForbidden(caught) ? '需要系统管理员权限。' : errorMessageOf(caught)
  } finally {
    inferenceAction.value = 'idle'
    await loadInference()
  }
}

async function stopInference(): Promise<void> {
  if (inferenceAction.value !== 'idle') {
    return
  }
  inferenceAction.value = 'stopping'
  inferenceError.value = null
  try {
    await api.post<{ readonly stopped: true }>('/inference/local/stop', {})
    toast.show('success', '本地推理服务已停止')
  } catch (caught) {
    inferenceError.value = isForbidden(caught) ? '需要系统管理员权限。' : errorMessageOf(caught)
  } finally {
    inferenceAction.value = 'idle'
    await loadInference()
  }
}

/**
 * 「一键填入」：只改草稿，不保存。
 *
 * `dimension` 优先用 `/health` 读到的值；服务没启动时用 1024（本地模型的固定维度）。
 * 不可编辑的字段不写；被环境变量遮住的字段由保存时的服务端错误点名（`details.field`
 * 会把错误挂到对应输入框）。
 */
function fillInference(kind: LocalInferenceFillKind): void {
  const dimension = inference.value?.dimension ?? LOCAL_INFERENCE_DIMENSION
  const values = inferenceFillDrafts(kind, dimension)
  const nextDrafts = { ...drafts.value }
  const nextCleared = new Set(cleared.value)
  const nextErrors = { ...fieldErrors.value }
  let filled = 0
  for (const [path, value] of Object.entries(values)) {
    const item = items.value.find((candidate) => candidate.path === path)
    if (item === undefined || !item.editable) {
      continue
    }
    nextDrafts[path] = value
    nextCleared.delete(path)
    delete nextErrors[path]
    filled += 1
  }
  drafts.value = nextDrafts
  cleared.value = nextCleared
  fieldErrors.value = nextErrors
  const nextExpanded = new Set(expanded.value)
  nextExpanded.add(kind === 'embedding' ? 'embedding' : 'rerank')
  expanded.value = nextExpanded
  toast.show('success', `已填入 ${String(filled)} 项，检查后点保存`)
}

onMounted(() => {
  void load()
  void loadInference()
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="设置">
        <template #actions>
          <UiBadge v-if="view !== null && !view.overrideWritable" variant="orange">
            覆盖文件不可写
          </UiBadge>
          <span v-if="pendingCount > 0" class="caption tnum">有 {{ pendingCount }} 项待重启生效</span>
          <span v-if="dirtyCount > 0" class="caption tnum">待保存 {{ dirtyCount }} 项</span>
          <UiButton
            v-if="dirtyCount > 0 || pendingCount > 0"
            variant="plain"
            size="sm"
            title="放弃本地修改，按正在运行的配置重填表单"
            @click="reloadRunning"
          >
            重新读取运行中配置
          </UiButton>
          <UiButton variant="secondary" size="sm" :disabled="loading" @click="load">
            <RefreshCw :size="14" :stroke-width="1.5" />
            {{ loading ? '加载中' : '重新加载' }}
          </UiButton>
          <UiButton variant="primary" size="sm" :disabled="!canSave" @click="save">
            保存更改
          </UiButton>
        </template>
      </DomainPageHeader>

      <div v-if="saveResult !== null || saveError !== null" class="settings-notices">
        <UiCallout v-if="saveResult !== null" tone="success" role="status">
          <template #icon><CheckCircle2 :size="15" :stroke-width="1.4" /></template>
          <div class="settings-restart">
            <p class="body-sm">{{ restartNoticeOf(saveResult.overridePath) }}</p>
            <div class="settings-restart__commands">
              <DomainCodeBlock
                v-for="command in RESTART_COMMANDS"
                :key="command.id"
                :code="command.command"
                :label="command.label"
                :copy-label="`复制重启命令（${command.label}）`"
              />
            </div>
            <p class="caption">
              已写入 {{ saveResult.written }} 项，表单保留了你刚填的值。重启后再回到本页，
              来源徽章会变成「来自网页保存」。
            </p>
          </div>
        </UiCallout>

        <UiErrorCallout v-if="saveError !== null" :message="saveError" />
      </div>

      <UiCallout v-if="loadError !== null">
        <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
        <div>
          {{ loadError }}
          <UiButton variant="plain" size="sm" @click="load">重试</UiButton>
        </div>
      </UiCallout>

      <UiCard v-else-if="forbidden" panel>
        <UiEmpty forbidden>
          <template #extra>
            <span class="caption">设置只给系统管理员。让管理员把账号加进系统管理员名单后再打开。</span>
          </template>
        </UiEmpty>
      </UiCard>

      <div v-else-if="view === null" class="settings-loading" aria-busy="true" aria-label="正在加载设置">
        <UiSkeleton height="20px" width="240px" />
        <UiSkeleton height="140px" />
        <UiSkeleton height="140px" />
      </div>

      <div v-else class="stack-24">
        <UiCallout tone="info">
          <template #icon><PlugZap :size="15" :stroke-width="1.4" /></template>
          <div>{{ TEST_SCOPE_NOTE }}</div>
        </UiCallout>

        <p v-if="!view.overrideWritable" class="caption">
          覆盖文件 {{ view.overridePath }} 不可写，保存会失败。容器部署不要把数据卷挂成只读。
        </p>

        <template v-for="group in groups" :key="group.group">
          <DomainLocalInferenceCard
            v-if="group.group === 'embedding'"
            :status="inference"
            :loading="inferenceLoading"
            :action="inferenceAction"
            :error="inferenceError"
            @refresh="loadInference"
            @start="startInference"
            @stop="stopInference"
            @fill="fillInference"
          />

          <UiCard :title="group.label" panel>
          <template #actions>
            <span class="caption tnum">{{ group.items.length }} 项</span>
            <template
              v-if="group.testTarget !== null && probeOf(group.testTarget).status === 'skipped'"
            >
              <UiBadge variant="gray" title="这一组没有配置供应商，不会发出连接请求。">
                已停用，无需测试
              </UiBadge>
              <UiButton variant="plain" size="sm" @click="revealTypeField(group.testTarget)">
                去启用
              </UiButton>
            </template>
            <UiButton
              v-if="group.testTarget !== null"
              variant="secondary"
              size="sm"
              :disabled="probeOf(group.testTarget).status === 'running'"
              :aria-label="`测试${group.label}连接`"
              @click="test(group.testTarget)"
            >
              <PlugZap :size="14" :stroke-width="1.5" />
              {{ probeOf(group.testTarget).status === 'running' ? '测试中' : '测试连接' }}
            </UiButton>
            <UiButton
              variant="plain"
              size="sm"
              :aria-expanded="expanded.has(group.group)"
              :aria-controls="`settings-group-${group.group}`"
              :aria-label="`${expanded.has(group.group) ? '收起' : '展开'}${group.label}设置`"
              @click="toggleGroup(group.group)"
            >
              <ChevronDown
                :size="14"
                :stroke-width="1.5"
                class="settings-chevron"
                :class="{ 'is-open': expanded.has(group.group) }"
                aria-hidden="true"
              />
              {{ expanded.has(group.group) ? '收起' : '展开' }}
            </UiButton>
          </template>

          <div
            v-if="expanded.has(group.group)"
            :id="`settings-group-${group.group}`"
            class="settings-rows"
          >
            <div v-for="item in group.items" :key="item.path" class="settings-row">
              <div class="settings-row__meta">
                <label :for="inputIdOf(item.path)" class="settings-row__label">
                  {{ fieldLabelOf(item.path) }}
                </label>
                <code class="settings-row__path" :title="item.path">{{ item.path }}</code>
                <div class="settings-row__badges">
                  <UiBadge :variant="sourceToneOf(item.source)" :title="sourceNoteOf(item.source)">
                    {{ sourceLabelOf(item.source) }}
                  </UiBadge>
                  <UiBadge v-if="pendingSavedOf(item.path)" variant="teal">
                    已保存，重启后生效
                  </UiBadge>
                  <UiBadge v-if="!item.editable" variant="gray">不可编辑</UiBadge>
                </div>
              </div>

              <div class="settings-row__control">
                <div v-if="fieldControlOf(item.path) === 'secret'" class="settings-row__inline">
                  <UiInput
                    :id="inputIdOf(item.path)"
                    :model-value="cleared.has(item.path) ? '' : (drafts[item.path] ?? '')"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="item.configured ? '留空表示不修改' : '未设置'"
                    :disabled="!item.editable || cleared.has(item.path)"
                    :aria-describedby="describedByOf(item)"
                    @update:model-value="setDraft(item.path, $event)"
                  />
                  <UiButton
                    v-if="item.editable && item.configured"
                    variant="plain"
                    size="sm"
                    :aria-label="`清除${fieldLabelOf(item.path)}`"
                    @click="toggleClear(item.path)"
                  >
                    <Trash2 :size="13" :stroke-width="1.5" />
                    {{ cleared.has(item.path) ? '撤销清除' : '清除' }}
                  </UiButton>
                </div>

                <input
                  v-else-if="fieldControlOf(item.path) === 'boolean'"
                  :id="inputIdOf(item.path)"
                  class="settings-checkbox"
                  type="checkbox"
                  :checked="(drafts[item.path] ?? '') === 'true'"
                  :disabled="!item.editable"
                  :aria-describedby="describedByOf(item)"
                  @change="setBoolean(item.path, $event)"
                >

                <UiSelect
                  v-else-if="fieldControlOf(item.path) === 'select'"
                  :id="inputIdOf(item.path)"
                  :model-value="drafts[item.path] ?? ''"
                  :options="fieldOptionsOf(item.path)"
                  :disabled="!item.editable"
                  :described-by="describedByOf(item)"
                  @update:model-value="setDraft(item.path, $event)"
                />

                <UiTextarea
                  v-else-if="fieldControlOf(item.path) === 'list'"
                  :id="inputIdOf(item.path)"
                  :model-value="drafts[item.path] ?? ''"
                  :rows="2"
                  :disabled="!item.editable"
                  :aria-describedby="describedByOf(item)"
                  @update:model-value="setDraft(item.path, $event)"
                />

                <UiInput
                  v-else-if="fieldControlOf(item.path) === 'number'"
                  :id="inputIdOf(item.path)"
                  :model-value="drafts[item.path] ?? ''"
                  type="text"
                  inputmode="decimal"
                  :disabled="!item.editable"
                  :aria-describedby="describedByOf(item)"
                  @update:model-value="setDraft(item.path, $event)"
                />

                <UiInput
                  v-else
                  :id="inputIdOf(item.path)"
                  :model-value="drafts[item.path] ?? ''"
                  :disabled="!item.editable"
                  :aria-describedby="describedByOf(item)"
                  @update:model-value="setDraft(item.path, $event)"
                />

                <p class="settings-row__current caption">
                  当前值：<b class="mono">{{ valueDisplayOf(item) }}</b>
                </p>
                <p v-if="fieldHintOf(item.path) !== null" class="settings-row__hint caption">
                  {{ fieldHintOf(item.path) }}
                </p>
                <p
                  v-if="!item.editable && item.reason !== undefined"
                  :id="`${inputIdOf(item.path)}-reason`"
                  class="settings-row__note"
                >
                  {{ item.reason }}
                </p>
                <p
                  v-if="displayErrorOf(item) !== null"
                  :id="`${inputIdOf(item.path)}-error`"
                  class="settings-row__error"
                  role="alert"
                >
                  {{ displayErrorOf(item) }}
                </p>
                <p
                  v-if="errorHintOf(displayErrorOf(item)) !== null"
                  class="settings-row__hint caption"
                >
                  {{ errorHintOf(displayErrorOf(item)) }}
                </p>
              </div>
            </div>

            <div
              v-if="group.testTarget !== null && probeOf(group.testTarget).status === 'done'"
              class="settings-probe"
              role="status"
            >
              <div class="settings-probe__head">
                <UiBadge :variant="probeOkOf(group.testTarget) ? 'green' : 'red'">
                  {{ probeOkOf(group.testTarget) ? '连接通过' : '连接失败' }}
                </UiBadge>
                <span v-if="probeResultOf(group.testTarget) !== null" class="caption tnum">
                  {{ probeSummaryOf(group.testTarget) }}
                </span>
              </div>
              <p
                v-if="probeResultOf(group.testTarget) !== null"
                class="settings-probe__detail mono"
              >
                {{ probeDetailOf(group.testTarget) }}
              </p>
              <p v-else class="settings-probe__detail">{{ probeDetailOf(group.testTarget) }}</p>
            </div>
          </div>
        </UiCard>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-notices {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
}

.settings-loading {
  display: grid;
  gap: 16px;
}

.settings-restart {
  display: grid;
  gap: 12px;
  min-width: 0;
  width: 100%;
}

.settings-restart p {
  margin: 0;
}

.settings-restart__commands {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.settings-rows {
  display: grid;
  gap: 2px;
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
  gap: 20px;
  padding: 16px 0;
  align-items: start;
}

.settings-row + .settings-row {
  box-shadow: 0 -0.5px 0 var(--hairline);
}

.settings-row__meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.settings-row__label {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
  color: var(--label);
}

.settings-row__path {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.4;
  letter-spacing: -0.008em;
  color: var(--label-3);
  word-break: break-all;
}

.settings-row__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.settings-row__control {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.settings-row__inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.settings-row__inline .input {
  flex: 1;
  min-width: 0;
}

.settings-row__current,
.settings-row__hint,
.settings-row__note,
.settings-row__error {
  margin: 0;
}

.settings-row__current b {
  font-weight: 590;
  color: var(--label);
}

.settings-row__note {
  font-size: 13px;
  line-height: 1.4;
  color: var(--orange-ink);
}

.settings-row__error {
  font-size: 13px;
  line-height: 1.45;
  color: var(--red-ink);
  word-break: break-word;
}

.settings-checkbox {
  width: 18px;
  height: 18px;
  margin: 9px 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.settings-checkbox:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.settings-chevron {
  transition: transform var(--dur-fast) var(--ease);
}

.settings-chevron.is-open {
  transform: rotate(180deg);
}

.settings-probe {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
}

.settings-probe__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-probe__detail {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--label-2);
  word-break: break-word;
}

@media (max-width: 720px) {
  .settings-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
</style>
