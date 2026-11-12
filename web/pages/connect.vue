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

/**
 * Agent 要连的服务地址。
 *
 * `apiBase` 默认是相对路径（`/api/v1`），由代理转到后端，浏览器看不到后端端口；
 * 只有部署把它配成绝对地址时才能可靠推导。推不出来时默认用当前页面地址，并给出
 * 输入框——开发时控制台与后端端口不同，用户必须能改成后端的实际地址。
 */
function initialServerBaseUrl(): string {
  const derived = serverBaseUrlFromApiBase(String(runtimeConfig.public.apiBase))
  if (derived !== null) {
    return derived
  }
  if (typeof window !== 'undefined') {
    return window.location.origin
  }
  return DEFAULT_SERVER_BASE_URL
}

const serverBaseUrl = useState<string>('comem-mcp-server-base-url', initialServerBaseUrl)

const host = ref<ConnectHost>('claude-code')
const health = ref<HealthPayload | null>(null)
const healthError = ref<string | null>(null)
const sessions = ref<SessionListPayload['sessions'] | null>(null)
const sessionsError = ref<string | null>(null)
const loading = ref(false)

/** 空输入时退回文档里的默认地址，片段里不出现 `/mcp` 这种没有主机的地址。 */
const effectiveServerBaseUrl = computed(
  () => serverBaseUrl.value.trim() || DEFAULT_SERVER_BASE_URL,
)

const snippet = computed(() => mcpSnippetFor(host.value, effectiveServerBaseUrl.value))
const hook = computed(() => hookInstallFor(host.value))
const trust = computed(() => trustStepFor(host.value))
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
          <UiBadge v-if="verification.allGreen" variant="green">三项检查通过</UiBadge>
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
            <section class="connect-block">
              <div class="connect-block__head">
                <h3 class="headline">MCP 配置</h3>
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
                片段与下面的 curl 都使用这个地址。控制台和 CoMem 同源时不用改；开发时
                后端端口不同，填后端实际地址。接入方式见
                <a :href="docLink" target="_blank" rel="noreferrer">宿主接入文档</a>。
              </p>
              <DomainCodeBlock
                :code="snippet.text"
                :label="`MCP 配置（${snippet.format}）`"
                copy-label="复制 MCP 配置"
              />
            </section>

            <section class="connect-block">
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
          </div>
        </UiCard>

        <UiCard title="② 验证接入" panel>
          <p class="caption">三项都通过，说明服务端、会话采集与游标都正常。</p>

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
              服务端、会话采集与游标都正常。当前未配置模型，会话会被归档但不会产生新的记忆；
              见下方说明。
            </div>
            <div v-else>接入完成。Agent 现在可以自动召回、采集，也能主动读写记忆。</div>
          </UiCallout>
        </UiCard>

        <UiCard title="③ 写入第一条记忆" panel>
          <p class="body-sm">
            告诉 Agent：记住「{{ FIRST_MEMORY_TEXT }}」。等价的一次 MCP 调用：
          </p>
          <DomainCodeBlock :code="memoryCurl" label="MCP 调用（curl）" copy-label="复制调用命令" />

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
      </div>
    </div>
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
