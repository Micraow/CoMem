<script setup lang="ts">
/**
 * 接入引导（`/connect`，架构文档 §15.6 的 MCP 接入、§15.2 的 Hook 生命周期）。
 *
 * 页面按「选宿主 → 验证 → 第一条记忆」组织。三件事分别对应三条独立的通道：
 * MCP 配置决定 agent 能不能主动读写，Hook 安装决定会话会不会被自动召回与采集，
 * 验证区读 `GET /health` 与 `GET /sessions` 判断前两件事有没有真的生效。
 *
 * **片段不在页面里手写。** 宿主格式、服务地址与安装命令都在
 * `utils/connectGuide.ts` 里生成，并由 `tests/unit/web/connect-guide.test.ts`
 * 与仓库里的文档 / 配置对拍；页面只负责展示与复制。
 *
 * **游标读不到本机文件。** 控制台跑在浏览器里，拿不到 `{tmpdir}/comem-cursors.json`，
 * 所以第三项检查只根据会话提交记录间接判断，并在提示里给出本机命令。
 */
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-vue-next'

import type { SessionListPayload } from '~/components/domain/SessionList.vue'
import { errorMessageOf, useApi, type HealthPayload } from '~/composables/useApi'
import {
  CONNECT_HOSTS,
  CONNECT_HOST_LABELS,
  DEFAULT_SERVER_BASE_URL,
  FIRST_MEMORY_TEXT,
  HERMES_OPENUI_DOC,
  HOST_CONFIG_LOCATION,
  HOST_DOC_LINK,
  deriveVerification,
  firstMemoryCurl,
  hookInstallFor,
  mcpSnippetFor,
  serverBaseUrlFromApiBase,
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
const scopeRoot = useScopeRoot()
const runtimeConfig = useRuntimeConfig()
const route = useRoute()

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

const host = ref<ConnectHost>(route.query.host === 'hermes' ? 'hermes' : 'claude-code')
const isHermes = computed(() => host.value === 'hermes')
const hermesUseApiKey = ref(false)
const health = ref<HealthPayload | null>(null)
const healthError = ref<string | null>(null)
const sessions = ref<SessionListPayload['sessions'] | null>(null)
const sessionsError = ref<string | null>(null)
const loading = ref(false)

/** 空输入时退回文档里的默认地址，片段里不出现 `/mcp` 这种没有主机的地址。 */
const effectiveServerBaseUrl = computed(
  () => serverBaseUrl.value.trim() || DEFAULT_SERVER_BASE_URL,
)

const snippet = computed(() => mcpSnippetFor(host.value, effectiveServerBaseUrl.value, hermesUseApiKey.value))
const hook = computed(() => hookInstallFor(host.value))
const trust = computed(() => trustStepFor(host.value))
const configLocation = computed(() => HOST_CONFIG_LOCATION[host.value])
const docLink = computed(() => HOST_DOC_LINK[host.value])
const memoryCurl = computed(() => firstMemoryCurl(effectiveServerBaseUrl.value))

/** 没有模型时服务端跳过记忆抽取：会话归档，但不产生记忆。 */
const memoryExtractSkipped = computed(() => health.value?.memoryExtract.skipped === true)

const verification = computed(() =>
  deriveVerification({
    host: host.value,
    health: health.value,
    healthError: healthError.value,
    sessions: sessions.value,
    sessionsError: sessionsError.value,
  }),
)

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
  try {
    const payload = await api.get<SessionListPayload>('/sessions', {
      scopeUri: scopeRoot.value,
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

onMounted(() => {
  void check()
})

// 切作用域后会话列表不同；健康检查是进程级的，但一起重取的成本可以忽略。
watch(scopeRoot, () => {
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

          <div class="connect-host">
            <section v-if="isHermes" class="connect-block">
              <h3 class="headline">自动记忆</h3>
              <p class="body-sm">安装 CoMem 的 Hermes 记忆插件。它会在每轮对话中召回相关记忆，并在答完后归档这一轮。</p>
              <DomainCodeBlock
                code="hermes memory setup"
                label="安装后在 Hermes 主机上运行"
                copy-label="复制记忆插件设置命令"
              />
              <p class="body-sm">
                <a :href="docLink" target="_blank" rel="noreferrer">安装和配置记忆插件</a>
              </p>
            </section>
            <section class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">{{ isHermes ? '主动查找与导入（MCP）' : 'MCP 配置' }}</h3>
                <span class="caption">写入 {{ configLocation }}</span>
              </div>
              <label class="connect-address" for="mcp-server-address">
                <span class="connect-address__label">服务地址</span>
                <UiInput
                  id="mcp-server-address"
                  v-model="serverBaseUrl"
                  type="url"
                  placeholder="http://127.0.0.1:1933"
                />
              </label>
              <p class="caption">
                填写 Agent 能访问的 CoMem 地址。本地开发时填写后端端口。Docker 部署请为 Agent 配置 API Key，见
                <a :href="docLink" target="_blank" rel="noreferrer">接入文档</a>。
              </p>
              <label v-if="isHermes" class="api-key-choice body-sm">
                <input v-model="hermesUseApiKey" type="checkbox" />
                CoMem 要求 API Key（例如 Docker 部署）
              </label>
              <p v-if="isHermes && hermesUseApiKey" class="body-sm">
                在 Hermes 配置目录的 <code>.env</code> 中设置 <code>COMEM_TOKEN</code>，使用与自动记忆相同的账号。
              </p>
              <DomainCodeBlock
                :code="snippet.text"
                :label="`MCP 配置（${snippet.format}）`"
                copy-label="复制 MCP 配置"
              />
            </section>

            <section v-if="!isHermes" class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">安装自动采集</h3>
                <span class="caption">在仓库根目录执行</span>
              </div>
              <DomainCodeBlock
                v-if="hook.available && hook.command !== null"
                :code="hook.command"
                label="自动采集安装"
                copy-label="复制自动采集安装命令"
              />
              <UiCallout v-else tone="warn">
                <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
                <div>
                  {{ hook.note }}
                  <a :href="docLink" target="_blank" rel="noreferrer">查看 DSH 接入步骤</a>
                </div>
              </UiCallout>
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

        <UiCard title="② 验证接入" panel>
          <p class="body-sm">要验证召回，请在新会话中问一个已经存过的约定。</p>

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
            <div v-else>CoMem 已收到会话。请到「会话与任务」检查刚才那一轮。</div>
          </UiCallout>
        </UiCard>

        <UiCard title="③ 写入第一条记忆" panel>
          <p v-if="isHermes" class="body-sm">
            在 Hermes 发一条你确实想保留的长期偏好。回到 CoMem 看会话是否归档，等记忆处理完，再开新会话问它。
          </p>
          <p v-else class="body-sm">
            告诉 Agent：记住「{{ FIRST_MEMORY_TEXT }}」。等价的一次 MCP 调用：
          </p>
          <DomainCodeBlock v-if="!isHermes" :code="memoryCurl" label="MCP 调用（curl）" copy-label="复制调用命令" />

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

.api-key-choice {
  display: flex;
  align-items: center;
  gap: 8px;
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
