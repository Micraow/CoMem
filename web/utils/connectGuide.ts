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
 * Codex 的 TOML 形状来自 `codex mcp add <name> --url <url>` 写出的
 * `~/.codex/config.toml`（`[mcp_servers.<name>]` + `url`），不是从仓库文档
 * 复制的——文档没有 Codex 的 MCP 片段。DSH 的 YAML 形状来自
 * `integrations/README.md` 的「DSH」一节。
 */

/** 仓库的 GitHub 地址。文档锚点用它拼；仓库搬家时这里是唯一要改的地方。 */
const REPO_BLOB_BASE = 'https://github.com/Micraow/CoMem/blob/master'

/** 文档锚点。页面只链接，不复述文档正文（AGENTS.md §11）。 */
export const DOC_LINKS = {
  claudeCode: `${REPO_BLOB_BASE}/integrations/README.md#claude-code`,
  codex: `${REPO_BLOB_BASE}/integrations/README.md#codex`,
  dsh: `${REPO_BLOB_BASE}/integrations/README.md#dsh`,
} as const

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

/** MCP 服务器名；决定宿主里的工具前缀（`mcp__comem__*`）。 */
export const MCP_SERVER_NAME = 'comem'

export const CONNECT_HOSTS = ['claude-code', 'codex', 'dsh'] as const

export type ConnectHost = (typeof CONNECT_HOSTS)[number]

/** 宿主名 → 界面文案。宿主自己的名字不翻译。 */
export const CONNECT_HOST_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
} satisfies Record<ConnectHost, string>

/** 各宿主的 MCP 配置写在哪。 */
export const HOST_CONFIG_LOCATION = {
  'claude-code': '个人配置 ~/.claude.json，或项目根目录的 .mcp.json',
  codex: '~/.codex/config.toml',
  dsh: '$DSH_HOME/profiles/<name>/cordis.patch.yml',
} satisfies Record<ConnectHost, string>

/** 每个宿主自己的文档小节。 */
export const HOST_DOC_LINK = {
  'claude-code': DOC_LINKS.claudeCode,
  codex: DOC_LINKS.codex,
  dsh: DOC_LINKS.dsh,
} satisfies Record<ConnectHost, string>

export type McpSnippetFormat = 'JSON' | 'TOML' | 'YAML'

export interface McpSnippet {
  readonly format: McpSnippetFormat
  readonly text: string
}

function mcpEndpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${MCP_ENDPOINT_PATH}`
}

/**
 * 按宿主实际使用的配置格式生成 MCP 片段。
 *
 * 三个宿主的字段名来自各自宿主的配置格式，不是 CoMem 自造的：
 * Claude Code 认 `mcpServers.<name>.{type,url}`（`type` 不能省，否则会被当成
 * stdio 服务器跳过）；Codex 认 `[mcp_servers.<name>]` 表的 `url`；DSH 的
 * `dsh-mcp-client` 认 `serverName` / `transport` / `url`。
 */
export function mcpSnippetFor(
  host: ConnectHost,
  baseUrl: string = DEFAULT_SERVER_BASE_URL,
): McpSnippet {
  const url = mcpEndpointOf(baseUrl)

  if (host === 'claude-code') {
    return {
      format: 'JSON',
      text: `${JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: 'http',
              url,
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
      text: `[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${url}"\n`,
    }
  }

  return {
    format: 'YAML',
    text: [
      `- id: mcp-${MCP_SERVER_NAME}`,
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      `    serverName: ${MCP_SERVER_NAME}`,
      '    transport: streamable-http',
      `    url: ${url}`,
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
export function hookInstallFor(host: ConnectHost): HookInstall {
  if (host === 'dsh') {
    return {
      available: false,
      command: null,
      note: 'DSH 需要通过插件接入，安装脚本不会直接写它的配置。',
    }
  }

  return {
    available: true,
    command: `node integrations/cli.mjs install --host ${host}`,
    note: null,
  }
}

export interface TrustStep {
  readonly title: string
  readonly detail: string
}

/**
 * 信任步骤。
 *
 * Codex 的 Hook 必须先在 `/hooks` 里逐条信任；Claude Code 的 Hook 不需要这一步，
 * 但项目级 `.mcp.json` 里的 MCP 服务器首次连接要批准。两条事实不同，不合并成一句
 * 「两个宿主都要信任 Hook」。
 */
export function trustStepFor(host: ConnectHost): TrustStep {
  if (host === 'claude-code') {
    return {
      title: '确认 MCP 服务器',
      detail:
        '项目级 .mcp.json 第一次连接时，宿主会提示批准；也可以在 /mcp 里确认。Hook 写在个人设置里，不需要逐条信任。',
    }
  }

  if (host === 'codex') {
    return {
      title: '在 /hooks 里信任 Hook',
      detail:
        '打开 /hooks 逐条信任 integrations/servers/*.mjs。不信任时 MCP 工具仍可用，但自动召回与采集不生效。',
    }
  }

  return {
    title: '先装桥插件',
    detail:
      'DSH 的 Hook 由插件提供：按「DSH」一节把 @deepseek-ai/dsh-hooks-claude-code 或 @deepseek-ai/dsh-hooks-codex 挂进 profile，再用生成的 hooks 文件验证。文档标注这条路径未端到端验证。',
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
  return `curl -sS ${mcpEndpointOf(baseUrl)} \\\n  -H 'content-type: application/json' \\\n  -H 'accept: application/json, text/event-stream' \\\n  -d '${JSON.stringify(firstMemoryCall())}'\n`
}

export type VerificationTone = 'ok' | 'warn' | 'fail' | 'idle'

export interface VerificationHealth {
  readonly status: 'ok' | 'degraded'
}

export interface VerificationSession {
  readonly lastCommitAt: string | null
  readonly messageCount: number
  readonly messages: readonly { readonly createdAt: string }[]
}

export interface VerificationInput {
  readonly health: VerificationHealth | null
  readonly healthError: string | null
  readonly sessions: readonly VerificationSession[] | null
  readonly sessionsError: string | null
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

function formatCheckTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

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
  const server: VerificationCheck =
    input.healthError !== null
      ? { key: 'server', label: '服务端可达', tone: 'fail', detail: input.healthError, hint: null }
      : input.health === null
        ? { key: 'server', label: '服务端可达', tone: 'idle', detail: '还没有检查', hint: null }
        : input.health.status === 'degraded'
          ? { key: 'server', label: '服务端可达', tone: 'warn', detail: '服务端报告降级运行', hint: null }
          : { key: 'server', label: '服务端可达', tone: 'ok', detail: '运行正常', hint: null }

  let sessions: VerificationCheck
  if (input.sessionsError !== null) {
    sessions = {
      key: 'sessions',
      label: '最近会话',
      tone: 'fail',
      detail: input.sessionsError,
      hint: null,
    }
  } else if (input.sessions === null) {
    sessions = { key: 'sessions', label: '最近会话', tone: 'idle', detail: '还没有检查', hint: null }
  } else if (input.sessions.length === 0) {
    sessions = {
      key: 'sessions',
      label: '最近会话',
      tone: 'warn',
      detail: '还没有采集到会话',
      hint: null,
    }
  } else {
    const latest = latestActivityOf(input.sessions)
    sessions = {
      key: 'sessions',
      label: '最近会话',
      tone: 'ok',
      detail:
        latest === null
          ? `已采集 ${String(input.sessions.length)} 个会话`
          : `已采集 ${String(input.sessions.length)} 个会话 · 最近 ${formatCheckTime(latest)}`,
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
