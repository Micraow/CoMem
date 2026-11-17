/**
 * 接入引导（`/connect`）的宿主清单、片段生成与验证状态推导。
 *
 * ## 片段从哪里来
 *
 * 控制台没有「返回 MCP 配置」的端点（服务端不提供），所以片段由本模块按宿主的
 * 配置形状拼装。拼装只使用三个可变值：
 *
 * - 服务地址：默认 `http://127.0.0.1:1933`，来源是
 *   `integrations/lib/config.mjs` 的 `DEFAULT_CONFIG.baseUrl`。反向代理 / 容器
 *   部署时用户要把它换成实际的服务地址。
 * - 端点路径：`/mcp`（`docs/architecture.md` §15.6）。
 * - 服务器名：`comem`（`integrations/README.md` 的示例）。
 *
 * 说明文字不复制：认证模型、回环信任与 Hook 预算是文档的事，页面只给
 * `DOC_LINKS` 里的锚点。**这是唯一会漂移的地方**：`integrations/README.md` 与
 * `integrations/lib/config.mjs` 改了地址或字段名时，本文件要跟着改；
 * `tests/unit/web/connect-guide.test.ts` 直接读那两个文件做对拍，改漏会失败。
 *
 * 默认接入方式：
 *
 * - Claude Code、Codex、DSH 启动仓库内的 stdio 代理，共用共享 `config.yaml`；
 * - Hermes 使用自身 profile 配置，并在 MCP 头中引用 `COMEM_TOKEN`。
 *
 * 默认片段都不写入明文密钥。
 */

import { formatMonthDayTime } from './format'

/** CoMem 仓库的 GitHub 地址。文档锚点用它拼；仓库搬家时这里是唯一要改的地方。 */
const REPO_BLOB_BASE = 'https://github.com/Micraow/CoMem/blob/master'

/** Hermes OpenUI 在独立仓库维护，文档链接使用该仓库的默认分支。 */
const HERMES_OPENUI_REPO_BLOB_BASE = 'https://github.com/Micraow/hermes-openui/blob/main'

/** 文档锚点。页面只链接，不复述文档正文（AGENTS.md §11）。 */
export const DOC_LINKS = {
  claudeCode: `${REPO_BLOB_BASE}/integrations/README.md#claude-code`,
  codex: `${REPO_BLOB_BASE}/integrations/README.md#codex`,
  dsh: `${REPO_BLOB_BASE}/integrations/README.md#dsh`,
  hermes: `${REPO_BLOB_BASE}/integrations/hermes-memory/README.md#install`,
} as const

export const HERMES_OPENUI_DOC = `${HERMES_OPENUI_REPO_BLOB_BASE}/README.md`

/**
 * 服务端默认地址。
 *
 * 与 `integrations/lib/config.mjs` 的 `DEFAULT_CONFIG.baseUrl` 是同一个值。
 * 服务端没有「返回自身外部地址」的端点，控制台也不知道反向代理后的地址，所以页面
 * 同时写明「换成实际的服务地址」。
 */
export const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:1933'

/** MCP 端点路径（`docs/architecture.md` §15.6）。 */
export const MCP_ENDPOINT_PATH = '/mcp'

/** 输入框尚未填写时的占位仓库路径；真实片段始终使用输入值。 */
export const DEFAULT_REPO_ROOT = '/绝对路径/CoMem'

/** Hook、stdio MCP 代理和 doctor 共用的非宿主专属配置路径表达式。 */
export const SHARED_CONFIG_PATH =
  '${COMEM_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/comem/config.yaml}'

/**
 * 从控制台实际使用的 API 地址推导服务地址。
 *
 * `useApi()` 把 `runtimeConfig.public.apiBase` 拼在路径前面；默认值是相对路径
 * （`/api/v1`），由 Nuxt 的 devProxy / 反向代理转到后端，浏览器这一侧看不到后端
 * 端口。只有部署把 `apiBase` 配成绝对地址（`http://host:port/api/v1`）时才能
 * 可靠地取到 origin；相对路径返回 `null`，页面改用可编辑的服务地址输入框。
 */
export function serverBaseUrlFromApiBase(apiBase: string): string | null {
  if (!/^https?:\/\//iu.test(apiBase)) {
    return null
  }
  try {
    return new URL(apiBase).origin
  } catch {
    return null
  }
}

/** MCP 服务器名；决定宿主里的工具前缀（`mcp__comem__*`）。 */
export const MCP_SERVER_NAME = 'comem'

export const CONNECT_HOSTS = ['claude-code', 'codex', 'dsh', 'hermes'] as const

export type ConnectHost = (typeof CONNECT_HOSTS)[number]

/** 宿主名 → 界面文案。宿主自己的名字不翻译。 */
export const CONNECT_HOST_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
  hermes: 'Hermes',
} satisfies Record<ConnectHost, string>

/** 各宿主的 MCP 配置写在哪。 */
export const HOST_CONFIG_LOCATION = {
  'claude-code': '个人配置 ~/.claude.json，或项目根目录的 .mcp.json',
  codex: '~/.codex/config.toml',
  dsh: '$DSH_HOME/profiles/<name>/cordis.patch.yml',
  hermes: '当前 Hermes 配置目录的 config.yaml',
} satisfies Record<ConnectHost, string>

/** 每个宿主自己的文档小节。 */
export const HOST_DOC_LINK = {
  'claude-code': DOC_LINKS.claudeCode,
  codex: DOC_LINKS.codex,
  dsh: DOC_LINKS.dsh,
  hermes: DOC_LINKS.hermes,
} satisfies Record<ConnectHost, string>

export type McpSnippetFormat = 'JSON' | 'TOML' | 'YAML'

export interface McpSnippet {
  readonly format: McpSnippetFormat
  readonly text: string
}

export const CONNECT_TOKEN_ENV = 'COMEM_TOKEN'

/** API Key 名称跟随当前宿主，后续可在“我的账户”按用途撤销。 */
export const CONNECT_KEY_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
  hermes: 'Hermes',
} satisfies Record<ConnectHost, string>

export function apiKeyNameForHost(host: ConnectHost): string {
  return CONNECT_KEY_NAMES[host]
}

/** 当前网页登录主体 → API Key 端点使用的用户 ID。 */
export function userIdFromSubject(subject: string): string | null {
  return subject.startsWith('user:') && subject.length > 'user:'.length
    ? subject.slice('user:'.length)
    : null
}

/** 当前用户自助管理 API Key 的既有端点。 */
export function apiKeysPathForSubject(subject: string): string | null {
  const userId = userIdFromSubject(subject)
  return userId === null
    ? null
    : `/admin/users/${encodeURIComponent(userId)}/api-keys`
}

function mcpEndpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${MCP_ENDPOINT_PATH}`
}

function normalizedRepoRoot(repoRoot: string): string {
  return (repoRoot.trim() || DEFAULT_REPO_ROOT).replace(/\/+$/u, '')
}

function proxyPathFor(repoRoot: string): string {
  return `${normalizedRepoRoot(repoRoot)}/integrations/servers/mcp-proxy.mjs`
}

function cliPathFor(repoRoot: string): string {
  return `${normalizedRepoRoot(repoRoot)}/integrations/cli.mjs`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function sharedConfigSetupCommand(): string {
  return [
    'config_file="${COMEM_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/comem/config.yaml}"',
    'config_dir="$(dirname "$config_file")"',
    'install -d -m 700 "$config_dir"',
    'test -e "$config_file" || install -m 600 /dev/null "$config_file"',
    'chmod 600 "$config_file"',
    '"${EDITOR:-vi}" "$config_file"',
    '',
  ].join('\n')
}

/** 共享配置中的非密钥地址与待替换 Key；不接收或嵌入动态生成的密钥。 */
export function sharedConfigSnippet(
  baseUrl: string = DEFAULT_SERVER_BASE_URL,
): McpSnippet {
  return {
    format: 'YAML',
    text: `baseUrl: ${baseUrl.replace(/\/+$/u, '')}\ntoken: '<本页生成的 Key>'\n`,
  }
}

/**
 * 按宿主实际使用的配置格式生成 MCP 片段。
 *
 * Claude Code、Codex 和 DSH 默认启动同一份 stdio 代理；代理从共享
 * `config.yaml` 读取地址和 Key，所以 GUI 进程无需继承终端环境。
 * Hermes 使用自己的 provider / MCP 配置，继续引用 profile 中的 `COMEM_TOKEN`。
 */
export function mcpSnippetFor(
  host: ConnectHost,
  baseUrl: string = DEFAULT_SERVER_BASE_URL,
  repoRoot: string = DEFAULT_REPO_ROOT,
): McpSnippet {
  const url = mcpEndpointOf(baseUrl)
  const proxyPath = proxyPathFor(repoRoot)

  if (host === 'claude-code') {
    return {
      format: 'JSON',
      text: `${JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: 'stdio',
              command: 'node',
              args: [proxyPath],
            },
          },
        },
        null,
        2,
      )}\n`,
    }
  }

  if (host === 'codex') {
    return {
      format: 'TOML',
      text: `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "node"\nargs = [${JSON.stringify(proxyPath)}]\n`,
    }
  }

  if (host === 'hermes') {
    return {
      format: 'YAML',
      // Hermes 0.23.2 的运行时直接用 headers 建立 HTTP transport；auth 只在值为 oauth 时
      // 触发 OAuth。header 是本机 Hermes 配置界面保存 Bearer 配置时使用的显式模式标记。
      text: `mcp_servers:\n  comem:\n    url: ${JSON.stringify(url)}\n    auth: header\n    headers:\n      Authorization: "Bearer \${${CONNECT_TOKEN_ENV}}"\n    tools:\n      include: [health, find, read, remember]\n`,
    }
  }

  return {
    format: 'YAML',
    text: [
      `- id: mcp-${MCP_SERVER_NAME}`,
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      `    serverName: ${MCP_SERVER_NAME}`,
      '    transport: stdio',
      '    command: node',
      '    args:',
      `      - ${JSON.stringify(proxyPath)}`,
      '',
    ].join('\n'),
  }
}

export interface HookInstall {
  /** 宿主能不能直接用 `co-mem install --host <host>` 写入。 */
  readonly available: boolean
  /** 可执行命令；DSH 为 null（安装脚本对它硬失败）。 */
  readonly command: string | null
  /** DSH 的替代说明；其它宿主为 null。 */
  readonly note: string | null
}

/**
 * Hook 安装命令。
 *
 * `--host dsh` 在 `integrations/cli.mjs` 里是**硬失败**：DSH 没有 settings 里的
 * hook 面，写 `~/.dsh/settings.json` 一个读者都没有。页面因此不给这条会失败的
 * 命令，改为说明需要先装桥插件。
 */
export function hookInstallFor(
  host: ConnectHost,
  repoRoot: string = DEFAULT_REPO_ROOT,
): HookInstall {
  if (host === 'hermes') {
    return {
      available: false,
      command: null,
      note: '安装 CoMem Memory Provider，再运行 hermes memory setup。',
    }
  }
  if (host === 'dsh') {
    return {
      available: false,
      command: null,
      note: 'DSH 需要通过插件接入，安装脚本不会直接写它的配置。',
    }
  }

  return {
    available: true,
    command: `node ${shellQuote(cliPathFor(repoRoot))} install --host ${host}`,
    note: null,
  }
}

export interface AutomaticSetup {
  readonly title: string
  readonly detail: string
  readonly command: string | null
  readonly commandLabel: string | null
  readonly config: McpSnippet | null
  readonly configLabel: string | null
  readonly docLabel: string
}

/** 当前宿主自动召回 / 采集的安装步骤。命令和配置都不写入密钥明文。 */
export function automaticSetupFor(
  host: ConnectHost,
  repoRoot: string = DEFAULT_REPO_ROOT,
): AutomaticSetup {
  if (host === 'hermes') {
    return {
      title: '自动记忆',
      detail: `运行设置向导并选择 CoMem，在同一个 profile 中设置 ${CONNECT_TOKEN_ENV}。`,
      command: 'hermes memory setup',
      commandLabel: 'Hermes 接入设置',
      config: null,
      configLabel: null,
      docLabel: '安装和配置记忆插件',
    }
  }

  if (host === 'dsh') {
    return {
      title: '自动召回与采集',
      detail:
        '先把 YOUR_PROFILE 替换为实际 profile 名；空配置会读取共享配置，GUI 无需终端环境变量。',
      command: `dsh plugin --profile YOUR_PROFILE add ${shellQuote(`link:${normalizedRepoRoot(repoRoot)}/integrations/dsh-plugin`)}`,
      commandLabel: '在仓库根目录安装 DSH 插件',
      config: {
        format: 'YAML',
        text: '- insert:\n    - id: comem\n      name: comem-dsh-plugin\n      config: {}\n',
      },
      configLabel: 'DSH 插件配置（cordis.patch.yml）',
      docLabel: '查看 DSH 接入步骤',
    }
  }

  return {
    title: '自动召回与采集',
    detail: '安装器只写 Hook，不复制密钥；Hook 读取共享配置，GUI 无需终端环境变量。',
    command: hookInstallFor(host, repoRoot).command,
    commandLabel: '在仓库根目录安装自动采集',
    config: null,
    configLabel: null,
    docLabel: `查看 ${CONNECT_HOST_LABELS[host]} 接入步骤`,
  }
}

export interface TrustStep {
  readonly title: string
  readonly detail: string
}

/** Hook 安装器的身份自检命令；预期主体只从当前登录身份传入。 */
export function doctorCommandFor(
  host: ConnectHost,
  currentSubject: string,
  repoRoot: string = DEFAULT_REPO_ROOT,
): string | null {
  if (host !== 'claude-code' && host !== 'codex') {
    return null
  }
  const userId = userIdFromSubject(currentSubject)
  if (userId === null || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(userId)) {
    return null
  }
  return `COMEM_CONFIG_FILE="${SHARED_CONFIG_PATH}" node ${shellQuote(cliPathFor(repoRoot))} doctor --expect-subject ${currentSubject}`
}

/**
 * 信任步骤。
 *
 * Codex 的 Hook 必须先在 `/hooks` 里逐条信任；Claude Code 的 Hook 不需要这一步，
 * 但项目级 `.mcp.json` 里的 MCP 服务器首次连接要批准。两条事实不同，不合并成一句
 * 「两个宿主都要信任 Hook」。doctor 的预期主体来自当前登录身份，不进入 Key 片段。
 */
export function trustStepFor(host: ConnectHost): TrustStep {
  if (host === 'claude-code') {
    return {
      title: '确认 MCP 服务器',
      detail: '批准 MCP 服务器后，在会话里调用 health；再运行上方 doctor 命令确认账号。',
    }
  }

  if (host === 'codex') {
    return {
      title: '在 /hooks 里信任 Hook',
      detail: '逐条信任 Hook 后，调用 health；再运行上方 doctor 命令确认账号。',
    }
  }

  if (host === 'hermes') {
    return {
      title: '检查并开启新会话',
      detail: `运行 hermes memory status，确认 subject 是当前登录账号。自动记忆与 MCP 都读取同一个 ${CONNECT_TOKEN_ENV}。`,
    }
  }

  return {
    title: '先装桥插件',
    detail:
      '启动 DSH 后调用 MCP health，确认 subject 是当前登录账号；--dump-config 只能证明插件配置可加载。',
  }
}

/** 第一条记忆的示例正文。 */
export const FIRST_MEMORY_TEXT = '以后用中文回答。'

export interface McpRememberCall {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: 'tools/call'
  readonly params: {
    readonly name: 'remember'
    readonly arguments: {
      readonly messages: readonly {
        readonly role: 'user'
        readonly content: string
      }[]
    }
  }
}

/** 一次等价的 `remember` 工具调用。 */
export function firstMemoryCall(): McpRememberCall {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'remember',
      arguments: {
        messages: [{ role: 'user', content: FIRST_MEMORY_TEXT }],
      },
    },
  }
}

/** 可直接粘贴执行的 curl 命令；`-d` 的请求体就是上面的工具调用。 */
export function firstMemoryCurl(baseUrl: string = DEFAULT_SERVER_BASE_URL): string {
  return `curl -sS ${mcpEndpointOf(baseUrl)} \\\n  -H "authorization: Bearer \${${CONNECT_TOKEN_ENV}}" \\\n  -H 'content-type: application/json' \\\n  -H 'accept: application/json, text/event-stream' \\\n  -d '${JSON.stringify(firstMemoryCall())}'\n`
}

export type VerificationTone = 'ok' | 'warn' | 'fail' | 'idle'

export interface VerificationHealth {
  readonly status: 'ok' | 'degraded'
  /** 没有模型时的精简模式；有就据此给出健康状态的说明。 */
  readonly memoryExtract?: { readonly skipped: boolean }
  /** 规则摘要也是合法状态，不该在「服务端可达」里说成降级。 */
  readonly summary?: { readonly degraded: boolean }
}

export interface VerificationSession {
  readonly id?: string
  readonly lastCommitAt: string | null
  readonly messageCount: number
  readonly messages: readonly { readonly createdAt: string }[]
}

export interface VerificationInput {
  /** 部分宿主状态组件只需要账号级检查；该字段不参与宿主判定。 */
  readonly host?: ConnectHost
  readonly health: VerificationHealth | null
  readonly healthError: string | null
  readonly sessions: readonly VerificationSession[] | null
  readonly sessionsError: string | null
  /** 当前网页登录主体；会话列表必须来自这个账号的个人根。 */
  readonly currentSubject?: string | null
}

export interface VerificationCheck {
  readonly key: 'server' | 'sessions' | 'cursor'
  readonly label: string
  readonly tone: VerificationTone
  readonly detail: string
  /** 需要用户在本机执行时给出的命令；没有则为 null。 */
  readonly hint: string | null
}

export interface VerificationResult {
  readonly checks: readonly VerificationCheck[]
  readonly allGreen: boolean
}

/** 游标文件的位置（`integrations/README.md`「临时文件」一节）。 */
export const CURSOR_INSPECT_COMMAND =
  'cat "${COMEM_HOOK_TMPDIR:-${TMPDIR:-/tmp}}/comem-cursors.json"'

function latestActivityOf(sessions: readonly VerificationSession[]): string | null {
  let latest: string | null = null
  for (const session of sessions) {
    const candidate = session.lastCommitAt ?? session.messages[0]?.createdAt ?? null
    if (candidate === null) {
      continue
    }
    if (latest === null || Date.parse(candidate) > Date.parse(latest)) {
      latest = candidate
    }
  }
  return latest
}

/**
 * 把两个接口的结果折成三项检查。
 *
 * **游标只能间接判断。** 控制台读不到本机的游标文件（`{tmpdir}/comem-cursors.json`
 * 在宿主机上），能拿到的证据只有会话：最近提交过（`lastCommitAt`）或 live 里还有
 * 消息（`messageCount > 0`）说明游标至少推进过一次。两者都没有时给「待处理」，
 * 并把本机命令放在 `hint` 里，不声称「已推进」。
 */
export function deriveVerification(input: VerificationInput): VerificationResult {
  const sessionLabel = '当前账号会话'
  const currentAccount = input.currentSubject?.trim() || '当前账号'
  const observedSessions = input.sessions
  // `/health` 返回 200 就说明服务端可达；健康状态放在 detail 里单独说，不再把
  // 「可达」与「降级」挤进同一个徽章（规则摘要 / 未配置模型都会让 status 是
  // degraded，那是合法配置，不是连不上）。
  let serverDetail = '已连通，运行正常'
  if (input.health !== null) {
    if (input.health.memoryExtract?.skipped === true) {
      serverDetail = '已连通，当前是精简模式（未配置模型）'
    } else if (input.health.summary?.degraded === true) {
      serverDetail = '已连通，当前使用规则摘要'
    } else if (input.health.status === 'degraded') {
      serverDetail = '已连通，但服务报告降级运行'
    }
  }

  const server: VerificationCheck =
    input.healthError !== null
      ? { key: 'server', label: '服务端可达', tone: 'fail', detail: input.healthError, hint: null }
      : input.health === null
        ? { key: 'server', label: '服务端可达', tone: 'idle', detail: '还没有检查', hint: null }
        : { key: 'server', label: '服务端可达', tone: 'ok', detail: serverDetail, hint: null }

  let sessions: VerificationCheck
  if (input.sessionsError !== null) {
    sessions = {
      key: 'sessions',
      label: sessionLabel,
      tone: 'fail',
      detail: input.sessionsError,
      hint: null,
    }
  } else if (observedSessions === null) {
    sessions = { key: 'sessions', label: sessionLabel, tone: 'idle', detail: '还没有检查', hint: null }
  } else if (observedSessions.length === 0) {
    sessions = {
      key: 'sessions',
      label: sessionLabel,
      tone: 'warn',
      detail: `${currentAccount} 还没有归档会话`,
      hint: null,
    }
  } else {
    const latest = latestActivityOf(observedSessions)
    sessions = {
      key: 'sessions',
      label: sessionLabel,
      tone: 'ok',
      detail:
        latest === null
          ? `${currentAccount} 有 ${String(observedSessions.length)} 个归档会话`
          : `${currentAccount} 有 ${String(observedSessions.length)} 个归档会话 · 最近 ${formatMonthDayTime(latest)}`,
      hint: null,
    }
  }

  let cursor: VerificationCheck
  if (input.sessionsError !== null || input.sessions === null) {
    cursor = {
      key: 'cursor',
      label: '游标推进',
      tone: 'idle',
      detail: '会话列表取不到，无法判断',
      hint: CURSOR_INSPECT_COMMAND,
    }
  } else if (input.sessions.some((session) => session.lastCommitAt !== null)) {
    cursor = {
      key: 'cursor',
      label: '游标推进',
      tone: 'ok',
      detail: '最近提交过消息',
      hint: CURSOR_INSPECT_COMMAND,
    }
  } else if (input.sessions.some((session) => session.messageCount > 0)) {
    cursor = {
      key: 'cursor',
      label: '游标推进',
      tone: 'ok',
      detail: '会话里已有消息',
      hint: CURSOR_INSPECT_COMMAND,
    }
  } else {
    cursor = {
      key: 'cursor',
      label: '游标推进',
      tone: 'warn',
      detail: '还没有提交记录',
      hint: CURSOR_INSPECT_COMMAND,
    }
  }

  const checks = [server, sessions, cursor]
  return { checks, allGreen: checks.every((check) => check.tone === 'ok') }
}

export interface FreshInstallHealth {
  readonly index: { readonly totalNodes: number }
  readonly queue: { readonly pending: number }
}

/**
 * 概览页是否该显示「去接入 Agent」的引导。
 *
 * 判据是「这份数据根里没有索引、没有排队任务、任务列表也是空的」。只少一条都不算：
 * 已经有数据的部署不该被引导文案盖住任务卡。
 */
export function isFreshInstall(
  health: FreshInstallHealth | null,
  taskCount: number | null,
): boolean {
  return (
    health !== null &&
    health.index.totalNodes === 0 &&
    health.queue.pending === 0 &&
    taskCount === 0
  )
}
