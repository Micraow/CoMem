<script setup lang="ts">
/**
 * 接入引导（`/connect`，架构文档 §15.6 的 MCP 接入、§15.2 的 Hook 生命周期）。
 *
 * 页面按「选宿主 → 验证 → 第一条记忆」组织。三件事分别对应三条独立的通道：
 * MCP 配置决定 agent 能不能主动读写，Hook 安装决定会话会不会被自动召回与采集，
 * 验证区读 `GET /health` 与个人根 `GET /sessions`；它只证明服务端和账号数据可读，
 * 宿主自己的 doctor / status 才用于核对该宿主实际认证的 subject。
 *
 * **片段不在页面里手写。** 宿主格式、服务地址与安装命令都在
 * `utils/connectGuide.ts` 里生成，并由 `tests/unit/web/connect-guide.test.ts`
 * 与仓库里的文档 / 配置对拍；页面只负责展示与复制。
 *
 * **游标读不到本机文件。** 控制台跑在浏览器里，拿不到 `{tmpdir}/comem-cursors.json`，
 * 所以第三项检查只根据会话提交记录间接判断，并在提示里给出本机命令。
 */
import { AlertTriangle, CheckCircle2, Copy, KeyRound, RefreshCw } from 'lucide-vue-next'

import type { SessionListPayload } from '~/components/domain/SessionList.vue'
import { errorMessageOf, useApi, type HealthPayload } from '~/composables/useApi'
import { consoleIdentityState } from '~/composables/consoleIdentity'
import { useToast } from '~/composables/useToast'
import { CLIPBOARD_DENIED_MESSAGE, copyToClipboard } from '~/utils/clipboard'
import {
  CONNECT_TOKEN_ENV,
  CONNECT_HOSTS,
  CONNECT_HOST_LABELS,
  DEFAULT_REPO_ROOT,
  DEFAULT_SERVER_BASE_URL,
  FIRST_MEMORY_TEXT,
  HERMES_OPENUI_DOC,
  HOST_CONFIG_LOCATION,
  HOST_DOC_LINK,
  SHARED_CONFIG_PATH,
  apiKeyNameForHost,
  automaticSetupFor,
  deriveVerification,
  doctorCommandFor,
  firstMemoryCurl,
  mcpSnippetFor,
  apiKeysPathForSubject,
  serverBaseUrlFromApiBase,
  sharedConfigSetupCommand,
  sharedConfigSnippet,
  trustStepFor,
  type ConnectHost,
  type VerificationTone,
} from '~/utils/connectGuide'

useHead({ title: '接入 Agent · CoMem 控制台' })

type BadgeVariant = 'green' | 'orange' | 'red' | 'gray'

const CHECK_TONE_LABEL = {
  ok: '通过',
  warn: '待处理',
  fail: '失败',
  idle: '未检查',
} satisfies Record<VerificationTone, string>

const CHECK_VARIANT = {
  ok: 'green',
  warn: 'orange',
  fail: 'red',
  idle: 'gray',
} satisfies Record<VerificationTone, BadgeVariant>

function checkVariantOf(tone: VerificationTone): BadgeVariant {
  return CHECK_VARIANT[tone]
}

function checkToneLabelOf(tone: VerificationTone): string {
  return CHECK_TONE_LABEL[tone]
}

const HOST_TABS = CONNECT_HOSTS.map((host) => ({
  value: host,
  label: CONNECT_HOST_LABELS[host],
}))

const api = useApi()
const toast = useToast()
const runtimeConfig = useRuntimeConfig()
const route = useRoute()
const identityState = consoleIdentityState()
const identity = identityState.status === 'ready' ? identityState.identity : null
const currentSubject = computed(() => identity?.subject ?? '')
const apiKeysPath = computed(() => apiKeysPathForSubject(currentSubject.value))
const personalScope = computed(
  () => identity?.scopes.find((scope) => scope.startsWith('comem://user/')) ?? '',
)
const consoleOrigin = typeof window === 'undefined' ? '' : window.location.origin

/**
 * Agent 要连的服务地址。
 *
 * `apiBase` 默认是相对路径（`/api/v1`），由代理转到后端，浏览器看不到后端端口；
 * 本地开发用代理转发的后端端口；同源部署用当前页面的地址。输入框用于调整可达地址。
 */
function initialServerBaseUrl(): string {
  const derived = serverBaseUrlFromApiBase(String(runtimeConfig.public.apiBase))
  if (derived !== null) {
    return derived
  }
  if (typeof window !== 'undefined') {
    if (import.meta.dev) {
      return `http://127.0.0.1:${runtimeConfig.public.devBackendPort}`
    }
    return window.location.origin
  }
  return DEFAULT_SERVER_BASE_URL
}

const serverBaseUrl = useState<string>('comem-mcp-server-base-url', initialServerBaseUrl)
const repoRoot = useState<string>('comem-integrations-repo-root', () => DEFAULT_REPO_ROOT)

const host = ref<ConnectHost>(route.query.host === 'hermes' ? 'hermes' : 'claude-code')
const isHermes = computed(() => host.value === 'hermes')
const keyName = computed(() => apiKeyNameForHost(host.value))
const health = ref<HealthPayload | null>(null)
const healthError = ref<string | null>(null)
const sessions = ref<SessionListPayload['sessions'] | null>(null)
const sessionsError = ref<string | null>(null)
const loading = ref(false)
const generatingKey = ref(false)
const keyError = ref<string | null>(null)
const generatedKey = ref<{
  readonly key: string
  readonly host: ConnectHost
  readonly subject: string
} | null>(null)
let keyRequestVersion = 0

/** 空输入时退回文档里的默认地址，片段里不出现 `/mcp` 这种没有主机的地址。 */
const effectiveServerBaseUrl = computed(
  () => serverBaseUrl.value.trim() || DEFAULT_SERVER_BASE_URL,
)
const effectiveRepoRoot = computed(() => repoRoot.value.trim() || DEFAULT_REPO_ROOT)

const snippet = computed(() =>
  mcpSnippetFor(host.value, effectiveServerBaseUrl.value, effectiveRepoRoot.value),
)
const automatic = computed(() => automaticSetupFor(host.value, effectiveRepoRoot.value))
const trust = computed(() => trustStepFor(host.value))
const doctor = computed(() =>
  doctorCommandFor(host.value, currentSubject.value, effectiveRepoRoot.value),
)
const sharedConfig = computed(() => sharedConfigSnippet(effectiveServerBaseUrl.value))
const sharedConfigSetup = sharedConfigSetupCommand()
const configLocation = computed(() => HOST_CONFIG_LOCATION[host.value])
const docLink = computed(() => HOST_DOC_LINK[host.value])
const memoryCurl = computed(() => firstMemoryCurl(effectiveServerBaseUrl.value))

/** 没有模型时服务端跳过记忆抽取：会话归档，但不产生记忆。 */
const memoryExtractSkipped = computed(() => health.value?.memoryExtract.skipped === true)

const verification = computed(() =>
  deriveVerification({
    health: health.value,
    healthError: healthError.value,
    sessions: sessions.value,
    sessionsError: sessionsError.value,
    currentSubject: currentSubject.value,
  }),
)

function resetCredentialState(): void {
  keyRequestVersion += 1
  generatingKey.value = false
  keyError.value = null
  generatedKey.value = null
}

async function generateConnectKey(): Promise<void> {
  if (apiKeysPath.value === null || generatingKey.value || generatedKey.value !== null) {
    return
  }
  const requestVersion = ++keyRequestVersion
  const requestSubject = currentSubject.value
  const requestPath = apiKeysPath.value
  const requestHost = host.value
  generatingKey.value = true
  keyError.value = null
  try {
    const result = await api.post<{ readonly key: string }>(requestPath, {
      name: apiKeyNameForHost(requestHost),
    })
    // 切换宿主或账号会作废在途请求；旧响应不能进入新标签的组件状态。
    if (
      requestVersion !== keyRequestVersion ||
      host.value !== requestHost ||
      currentSubject.value !== requestSubject
    ) {
      return
    }
    generatedKey.value = { ...result, host: requestHost, subject: requestSubject }
    toast.show('success', `已为 ${requestSubject} 生成 ${apiKeyNameForHost(requestHost)} 接入 Key`)
  } catch (caught) {
    if (requestVersion === keyRequestVersion && host.value === requestHost) {
      keyError.value = errorMessageOf(caught)
    }
  } finally {
    if (requestVersion === keyRequestVersion) {
      generatingKey.value = false
    }
  }
}

async function copyConnectToken(): Promise<void> {
  const key = generatedKey.value?.key
  if (key === undefined) {
    return
  }
  if (!(await copyToClipboard(key))) {
    toast.show('error', CLIPBOARD_DENIED_MESSAGE)
    return
  }
  toast.show('success', '已复制接入 Key')
}

async function loadHealth(): Promise<void> {
  healthError.value = null
  try {
    health.value = await api.get<HealthPayload>('/health')
  } catch (caught) {
    health.value = null
    healthError.value = errorMessageOf(caught)
  }
}

async function loadSessions(): Promise<void> {
  sessionsError.value = null
  const targetScope = personalScope.value
  if (targetScope === '') {
    sessions.value = []
    return
  }
  try {
    const payload = await api.get<SessionListPayload>('/sessions', {
      scopeUri: targetScope,
    })
    sessions.value = payload.sessions
  } catch (caught) {
    sessions.value = null
    sessionsError.value = errorMessageOf(caught)
  }
}

async function check(): Promise<void> {
  if (loading.value) {
    return
  }
  loading.value = true
  try {
    await Promise.all([loadHealth(), loadSessions()])
  } finally {
    loading.value = false
  }
}

watch(host, () => {
  resetCredentialState()
  void check()
})

watch(currentSubject, () => {
  resetCredentialState()
  void check()
})

onBeforeUnmount(() => {
  keyRequestVersion += 1
})

onMounted(() => {
  void check()
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="接入 Agent">
        <template #actions>
          <UiButton variant="secondary" size="sm" :disabled="loading" @click="check">
            <RefreshCw :size="14" :stroke-width="1.5" />
            {{ loading ? '检查中' : '重新检查' }}
          </UiButton>
        </template>
      </DomainPageHeader>

      <div class="stack-24">
        <UiCard title="① 选择宿主" panel>
          <UiTabs v-model="host" :items="HOST_TABS" aria-label="选择宿主" />

          <div class="account-facts">
            <span class="account-fact account-fact--primary">
              <span class="account-fact__label">当前登录</span>
              <code>{{ currentSubject || '未识别' }}</code>
            </span>
            <span class="account-fact account-fact--primary">
              <span class="account-fact__label">接入 Key 所有者</span>
              <code>{{ currentSubject || '未识别' }}</code>
            </span>
            <span v-if="health !== null" class="account-fact">
              <span class="account-fact__label">免凭据连接会写入</span>
              <code>{{ health.subject }}</code>
            </span>
          </div>
          <p v-if="health !== null" class="loopback-consequence body-sm">
            <code>{{ health.subject }}</code> 是未携带凭据的回环请求兜底身份。
            宿主读取接入 Key 后，MCP 与自动召回都使用当前登录账号
            <code>{{ currentSubject }}</code>。
          </p>

          <div class="connect-host">
            <section class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">账号凭据</h3>
                <span class="caption">
                  {{ isHermes ? CONNECT_TOKEN_ENV : '共享配置' }} ·
                  {{ currentSubject || '当前账号未识别' }}
                </span>
              </div>
              <UiButton
                variant="secondary"
                :disabled="apiKeysPath === null || generatingKey || generatedKey !== null"
                @click="generateConnectKey"
              >
                <KeyRound :size="14" :stroke-width="1.5" />
                {{
                  generatingKey
                    ? '生成中…'
                    : generatedKey === null
                      ? `生成 ${keyName} 接入 Key`
                      : '本页已生成'
                }}
              </UiButton>
              <UiErrorCallout v-if="keyError !== null" :message="keyError" />
              <div v-if="generatedKey !== null" class="generated-key" role="status">
                <p>完整 Key 只显示这一次，刷新或离开页面后不再显示。</p>
                <code>{{ generatedKey.key }}</code>
                <UiButton variant="secondary" size="sm" @click="copyConnectToken">
                  <Copy :size="14" :stroke-width="1.5" />
                  复制接入 Key
                </UiButton>
              </div>
              <p v-if="isHermes" class="body-sm">
                Hermes 设置向导会把 Key 写入当前 profile 的 {{ CONNECT_TOKEN_ENV }}。
              </p>
              <p v-else class="body-sm">
                把 Key 写入下面的共享配置。Hook 和 MCP 代理读取同一文件，GUI 无需继承终端环境。
              </p>
              <p class="body-sm credential-manage">
                <NuxtLink to="/account">在“我的账户”中管理或撤销 API Key</NuxtLink>
              </p>
            </section>

            <section class="connect-block">
              <h3 class="headline">运行路径</h3>
              <label class="connect-address" for="mcp-server-address">
                <span class="connect-address__label">Agent 访问地址</span>
                <UiInput
                  id="mcp-server-address"
                  v-model="serverBaseUrl"
                  type="url"
                  placeholder="http://127.0.0.1:1933"
                />
              </label>
              <label v-if="!isHermes" class="connect-address" for="integrations-repo-root">
                <span class="connect-address__label">CoMem 仓库绝对路径</span>
                <UiInput
                  id="integrations-repo-root"
                  v-model="repoRoot"
                  type="text"
                  placeholder="/absolute/path/to/CoMem"
                />
              </label>
              <div class="address-pair">
                <span>本网页 <code>{{ consoleOrigin }}</code></span>
                <span>Agent <code>{{ effectiveServerBaseUrl }}</code></span>
              </div>
            </section>

            <section v-if="!isHermes" class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">共享连接配置</h3>
                <span class="caption"><code>{{ SHARED_CONFIG_PATH }}</code></span>
              </div>
              <p class="body-sm">
                先创建权限为 0600 的配置文件，再把下面两项合并进去。Key 只保存在本机文件中。
              </p>
              <DomainCodeBlock
                :code="sharedConfigSetup"
                label="创建并打开共享配置"
                copy-label="复制配置准备命令"
              />
              <DomainCodeBlock
                :code="sharedConfig.text"
                label="共享配置内容"
                copy-label="复制共享配置"
              />
            </section>

            <section class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">{{ automatic.title }}</h3>
                <a :href="docLink" target="_blank" rel="noreferrer">{{ automatic.docLabel }}</a>
              </div>
              <p class="body-sm">{{ automatic.detail }}</p>
              <DomainCodeBlock
                v-if="automatic.command !== null"
                :code="automatic.command"
                :label="automatic.commandLabel ?? '安装命令'"
                copy-label="复制安装命令"
              />
              <DomainCodeBlock
                v-if="automatic.config !== null"
                :code="automatic.config.text"
                :label="automatic.configLabel ?? `插件配置（${automatic.config.format}）`"
                copy-label="复制插件配置"
              />
              <DomainCodeBlock
                v-if="doctor !== null"
                :code="doctor"
                label="核对 Hook 使用的账号"
                copy-label="复制身份检查命令"
              />
            </section>

            <section class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">MCP 配置</h3>
                <span class="caption">写入 {{ configLocation }}</span>
              </div>
              <DomainCodeBlock
                :code="snippet.text"
                :label="`MCP 配置（${snippet.format}）`"
                copy-label="复制 MCP 配置"
              />
              <p v-if="isHermes" class="body-sm">
                Hermes 的 MCP 配置与 Memory Provider 使用当前 profile 中的
                <code>{{ CONNECT_TOKEN_ENV }}</code>。
              </p>
              <p v-else class="body-sm">
                MCP 代理读取共享配置；更新 Key 或地址后只需重启宿主，不需要改这段配置。
              </p>
            </section>

            <UiCallout tone="info">
              <template #icon><CheckCircle2 :size="15" :stroke-width="1.4" /></template>
              <div>
                <b>{{ trust.title }}</b>
                <br />
                {{ trust.detail }}
              </div>
            </UiCallout>
            <section v-if="isHermes" class="connect-block">
              <h3 class="headline">交互式回答</h3>
              <p class="body-sm">
                OpenUI 可选。安装后，Hermes 的网页聊天可边生成边显示交互式回答。
                <a :href="HERMES_OPENUI_DOC" target="_blank" rel="noreferrer">安装 OpenUI</a>
              </p>
            </section>
          </div>
        </UiCard>

        <UiCard title="② 检查服务与账号数据" panel>
          <p class="body-sm">
            当前账号：<code>{{ currentSubject || '未识别' }}</code>。
            这里只检查服务端与个人根下的归档，不能代替宿主 doctor / status 的身份核对。
          </p>

          <ul class="connect-checks">
            <li v-for="item in verification.checks" :key="item.key" class="connect-check">
              <span class="connect-check__dot" :class="`is-${item.tone}`" aria-hidden="true" />
              <div class="connect-check__body">
                <div class="connect-check__head">
                  <span class="connect-check__label">{{ item.label }}</span>
                  <UiBadge :variant="checkVariantOf(item.tone)">
                    {{ checkToneLabelOf(item.tone) }}
                  </UiBadge>
                </div>
                <p class="connect-check__detail body-sm">{{ item.detail }}</p>
                <code v-if="item.hint !== null" class="connect-check__hint mono">
                  {{ item.hint }}
                </code>
              </div>
            </li>
          </ul>

          <UiCallout v-if="verification.allGreen" tone="success" class="mt-16">
            <template #icon><CheckCircle2 :size="15" :stroke-width="1.4" /></template>
            <div v-if="memoryExtractSkipped">
              当前未配置模型，会话会被归档但不会产生新的记忆；
              见下方说明。
            </div>
            <div v-else>
              服务和当前账号归档已可读。请按上方步骤确认宿主实际认证的 subject；
              归档与召回是否生效仍以新会话结果为准。
            </div>
          </UiCallout>
        </UiCard>

        <UiCard title="③ 写入第一条记忆" panel>
          <p v-if="isHermes" class="body-sm">
            在 Hermes 发一条你确实想保留的长期偏好。回到 CoMem 看会话是否归档，等记忆处理完，再开新会话问它。
          </p>
          <p v-else class="body-sm">
            告诉 Agent：记住「{{ FIRST_MEMORY_TEXT }}」。等价的一次 MCP 调用：
          </p>
          <DomainCodeBlock
            v-if="!isHermes"
            :code="memoryCurl"
            label="开发者临时调用（当前 shell 需设置 COMEM_TOKEN）"
            copy-label="复制调用命令"
          />

          <UiCallout v-if="memoryExtractSkipped" tone="warn" class="mt-16">
            <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
            <div>
              当前未配置模型：会话会被归档，但不会产生记忆。要产生记忆请先
              <NuxtLink to="/settings">配置模型</NuxtLink>，或直接在
              <NuxtLink to="/files">文件树</NuxtLink>里新建一条。
            </div>
          </UiCallout>

          <p v-else-if="health !== null" class="caption">
            抽取在后台进行。写入后到
            <NuxtLink to="/files">文件树</NuxtLink>
            或
            <NuxtLink to="/review">记忆复核</NuxtLink>
            查看。
          </p>

          <p v-else class="caption">
            服务状态没有取到，无法确认这次写入会不会产生记忆。
          </p>
        </UiCard>
        <DomainHistoryImportGuide />
      </div>
    </div>
    <UiToast />
  </div>
</template>

<style scoped>
.connect-host {
  display: grid;
  gap: 20px;
  margin-top: 16px;
}

.account-facts,
.address-pair {
  display: flex;
  align-items: baseline;
  gap: 8px 18px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding: 11px 14px;
  border-radius: var(--r-control);
  background: var(--surface-2);
  font-size: 13px;
  color: var(--label-3);
}

.account-fact {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.account-fact__label {
  color: var(--label-3);
}

.account-fact--primary {
  color: var(--label);
}

.account-fact--primary .account-fact__label {
  color: var(--label-2);
  font-weight: 560;
}

.loopback-consequence {
  margin: 0;
  color: var(--label-2);
}

.address-pair {
  margin-top: 0;
}

.connect-block {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.connect-block__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.connect-block__head h3 {
  margin: 0;
}

.connect-address {
  display: grid;
  gap: 6px;
}

.connect-address__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--label-2);
}

.generated-key {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: var(--r-card);
  background: var(--orange-tint);
}

.generated-key p {
  font-size: 13px;
  color: var(--label-2);
}

.generated-key code {
  overflow-wrap: anywhere;
  user-select: all;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--label);
}

.credential-manage {
  margin: 0;
}

.connect-checks {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
}

.connect-check {
  display: flex;
  gap: 12px;
  padding: 14px 0;
}

.connect-check + .connect-check {
  box-shadow: 0 -0.5px 0 var(--hairline);
}

.connect-check__dot {
  width: 8px;
  height: 8px;
  flex: none;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--label-3);
}

.connect-check__dot.is-ok {
  background: var(--green);
}

.connect-check__dot.is-warn {
  background: var(--orange);
}

.connect-check__dot.is-fail {
  background: var(--red);
}

.connect-check__body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.connect-check__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.connect-check__label {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
  color: var(--label);
}

.connect-check__detail {
  margin: 0;
  color: var(--label-2);
}

.connect-check__hint {
  display: block;
  font-size: 12px;
  line-height: 1.5;
  color: var(--label-3);
  word-break: break-all;
}
</style>
