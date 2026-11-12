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
  restartNoticeOf,
  sourceLabelOf,
  sourceNoteOf,
  sourceToneOf,
  testSummaryOf,
  valueDisplayOf,
  type ConfigGroup,
  type ConfigItemView,
  type ConfigTestPayload,
  type ConfigTestTarget,
  type ConfigViewPayload,
} from '~/utils/settings'

useHead({ title: '设置 · CoMem 控制台' })

interface ProbeState {
  readonly status: 'idle' | 'running' | 'done'
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

const expanded = ref<ReadonlySet<ConfigGroup>>(new Set(INITIALLY_EXPANDED_GROUPS))
const probes = ref<Readonly<Record<ConfigTestTarget, ProbeState>>>(
  Object.fromEntries(CONFIG_TEST_TARGETS.map((target) => [target, idleProbe()])) as Record<
    ConfigTestTarget,
    ProbeState
  >,
)

const items = computed<readonly ConfigItemView[]>(() => view.value?.items ?? [])
const groups = computed(() => groupSettings(items.value))
const preview = computed(() => buildPatchValues(items.value, drafts.value, cleared.value))
const dirtyCount = computed(() => Object.keys(preview.value.values).length)
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

function setDraft(path: string, value: string): void {
  drafts.value = { ...drafts.value, [path]: value }
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

function resetDrafts(next: readonly ConfigItemView[]): void {
  drafts.value = Object.fromEntries(next.map((item) => [item.path, draftOf(item)]))
  cleared.value = new Set()
  fieldErrors.value = {}
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  forbidden.value = false
  try {
    const payload = await api.get<ConfigViewPayload>('/config')
    view.value = payload
    resetDrafts(payload.items)
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

async function save(): Promise<void> {
  if (saving.value) {
    return
  }

  const { values, errors } = buildPatchValues(items.value, drafts.value, cleared.value)
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
    saveResult.value = { written: result.written, overridePath: result.overridePath }
    toast.show('success', `已写入 ${result.written} 项设置，重启后生效`)
    // 重新取一次：来源徽章要从「默认值」变成「覆盖文件」。
    await load()
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

async function test(target: ConfigTestTarget | null): Promise<void> {
  if (target === null || probeOf(target).status === 'running') {
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

onMounted(() => {
  void load()
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
          <span v-if="dirtyCount > 0" class="caption tnum">待保存 {{ dirtyCount }} 项</span>
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
        <div v-if="saveResult !== null" class="callout callout--success" role="status">
          <CheckCircle2 :size="15" :stroke-width="1.4" />
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
              已写入 {{ saveResult.written }} 项。重启后再回到本页，来源徽章会变成「覆盖文件」。
            </p>
          </div>
        </div>

        <UiCallout v-if="saveError !== null">
          <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
          <div>{{ saveError }}</div>
        </UiCallout>
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
        <div class="callout callout--info">
          <PlugZap :size="15" :stroke-width="1.4" />
          <div>{{ TEST_SCOPE_NOTE }}</div>
        </div>

        <p v-if="!view.overrideWritable" class="caption">
          覆盖文件 {{ view.overridePath }} 不可写，保存会失败。容器部署不要把数据卷挂成只读。
        </p>

        <UiCard v-for="group in groups" :key="group.group" :title="group.label" panel>
          <template #actions>
            <span class="caption tnum">{{ group.items.length }} 项</span>
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
