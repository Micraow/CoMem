/**
 * 接入引导的片段来源与验证状态（`web/utils/connectGuide.ts`）。
 *
 * 片段里会漂移的三样东西都直接对着仓库里的来源断言：
 *
 * - 服务地址与端点路径 → `integrations/lib/config.mjs` 的 `DEFAULT_CONFIG.baseUrl`
 *   与 `integrations/README.md` 的示例；
 * - 宿主格式 → README 的「MCP 接入」一节；
 * - 安装命令 → `integrations/cli.mjs` 的 `--host` 取值（`dsh` 是硬失败）。
 *
 * 这里不做组件挂载（仓库没有组件测试运行器）：页面的「接线」用源码断言，
 * 纯逻辑（验证三态、新装判定）直接调函数。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  CONNECT_HOSTS,
  CONNECT_HOST_LABELS,
  CONNECT_KEY_NAMES,
  CONNECT_TOKEN_ENV,
  CURSOR_INSPECT_COMMAND,
  DEFAULT_REPO_ROOT,
  DEFAULT_SERVER_BASE_URL,
  DOC_LINKS,
  HERMES_OPENUI_DOC,
  HOST_CONFIG_LOCATION,
  HOST_DOC_LINK,
  MCP_ENDPOINT_PATH,
  MCP_SERVER_NAME,
  SHARED_CONFIG_PATH,
  apiKeysPathForSubject,
  apiKeyNameForHost,
  automaticSetupFor,
  deriveVerification,
  doctorCommandFor,
  firstMemoryCall,
  firstMemoryCurl,
  hookInstallFor,
  isFreshInstall,
  mcpSnippetFor,
  sharedConfigSetupCommand,
  sharedConfigSnippet,
  trustStepFor,
  userIdFromSubject,
} from '../../../web/utils/connectGuide.js';

const CONFIG_SOURCE = readFileSync(
  new URL('../../../integrations/lib/config.mjs', import.meta.url),
  'utf8',
);
const README = readFileSync(new URL('../../../integrations/README.md', import.meta.url), 'utf8');
const INDEX_PAGE = readFileSync(
  new URL('../../../web/pages/index.vue', import.meta.url),
  'utf8',
);
const CONNECT_PAGE = readFileSync(
  new URL('../../../web/pages/connect.vue', import.meta.url),
  'utf8',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('宿主清单', () => {
  it('宿主按文档顺序排列，标签就是宿主自己的名字', () => {
    expect([...CONNECT_HOSTS]).toEqual(['claude-code', 'codex', 'dsh', 'hermes']);
    expect(CONNECT_HOSTS.map((host) => CONNECT_HOST_LABELS[host])).toEqual([
      'Claude Code',
      'Codex',
      'DSH',
      'Hermes',
    ]);
  });

  it('每个宿主都有配置位置与文档锚点', () => {
    const docKeys = { 'claude-code': 'claudeCode', codex: 'codex', dsh: 'dsh', hermes: 'hermes' } as const;
    for (const host of CONNECT_HOSTS) {
      expect(HOST_CONFIG_LOCATION[host]).not.toBe('');
      expect(HOST_DOC_LINK[host]).toBe(DOC_LINKS[docKeys[host]]);
      expect(HOST_DOC_LINK[host]).toContain('#');
    }
    expect(DOC_LINKS.claudeCode).toContain('#claude-code');
    expect(DOC_LINKS.dsh).toContain('#dsh');
  });

  it('CoMem 文档链接指向 master', () => {
    for (const url of Object.values(DOC_LINKS)) {
      expect(url).toMatch(/^https:\/\/github\.com\/Micraow\/CoMem\/blob\/master\//u);
    }
  });

  it('独立的 Hermes OpenUI 文档链接指向新仓库 main', () => {
    expect(HERMES_OPENUI_DOC).toBe(
      'https://github.com/Micraow/hermes-openui/blob/main/README.md',
    );
  });
});

describe('MCP 配置片段', () => {
  it('共享配置服务地址与端点路径跟仓库里的来源一致', () => {
    expect(CONFIG_SOURCE).toContain(DEFAULT_SERVER_BASE_URL);
    expect(README).toContain(`${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`);
    expect(SHARED_CONFIG_PATH).toContain('${XDG_CONFIG_HOME:-$HOME/.config}/comem');
    expect(sharedConfigSnippet().text).toContain(DEFAULT_SERVER_BASE_URL);
    expect(mcpSnippetFor('hermes').text).toContain(
      `${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`,
    );
  });

  it('Claude Code 默认用 JSON 启动仓库内 stdio 代理', () => {
    const repoRoot = '/srv/CoMem with space';
    const snippet = mcpSnippetFor('claude-code', DEFAULT_SERVER_BASE_URL, repoRoot);
    expect(snippet.format).toBe('JSON');

    const parsed: unknown = JSON.parse(snippet.text);
    expect(isRecord(parsed) && isRecord(parsed['mcpServers'])).toBe(true);
    if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
      throw new Error('Claude Code 片段不是 mcpServers 对象');
    }
    expect(parsed['mcpServers'][MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/srv/CoMem with space/integrations/servers/mcp-proxy.mjs'],
    });
    expect(README).toContain('"type": "stdio"');
  });

  it('Codex 默认用 TOML 启动仓库内 stdio 代理', () => {
    const repoRoot = '/srv/CoMem';
    const snippet = mcpSnippetFor('codex', DEFAULT_SERVER_BASE_URL, repoRoot);
    expect(snippet.format).toBe('TOML');
    expect(snippet.text).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(snippet.text).toContain('command = "node"');
    expect(snippet.text).toContain('"/srv/CoMem/integrations/servers/mcp-proxy.mjs"');
    expect(snippet.text).not.toContain('bearer_token_env_var');
    expect(README).toContain('~/.codex/config.toml');
  });

  it('DSH 默认用 YAML 启动同一份 stdio 代理', () => {
    const repoRoot = '/srv/CoMem';
    const snippet = mcpSnippetFor('dsh', DEFAULT_SERVER_BASE_URL, repoRoot);
    expect(snippet.format).toBe('YAML');

    const parsed: unknown = parseYaml(snippet.text);
    expect(Array.isArray(parsed)).toBe(true);
    if (!Array.isArray(parsed)) {
      throw new Error('DSH 片段不是顶层序列');
    }
    expect(parsed[0]).toMatchObject({
      id: `mcp-${MCP_SERVER_NAME}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: MCP_SERVER_NAME,
        transport: 'stdio',
        command: 'node',
        args: ['/srv/CoMem/integrations/servers/mcp-proxy.mjs'],
      },
    });
    expect(README).toContain('transport: stdio');
    expect(README).toContain(`process.env.${CONNECT_TOKEN_ENV}`);
    expect(README).toContain('Authorization: !!js');
  });

  it('Hermes 的 Docker 配置只引用当前 profile 的 API Key 环境变量', () => {
    const snippet = parseYaml(mcpSnippetFor('hermes', 'http://127.0.0.1:18080').text);
    expect(snippet).toEqual({
      mcp_servers: {
        comem: {
          url: 'http://127.0.0.1:18080/mcp',
          auth: 'header',
          headers: { Authorization: 'Bearer ${COMEM_TOKEN}' },
          tools: { include: ['health', 'find', 'read', 'remember'] },
        },
      },
    });
  });

  it('Hermes 配置引用统一 COMEM_TOKEN', () => {
    expect(CONNECT_TOKEN_ENV).toBe('COMEM_TOKEN');
    expect(mcpSnippetFor('hermes').text).toContain(`\${${CONNECT_TOKEN_ENV}}`);
    expect(mcpSnippetFor('hermes').text).toContain('auth: header');
  });

  it('默认片段共享代理，Hermes 保持自己的 profile 凭据', () => {
    const proxyPath = `${DEFAULT_REPO_ROOT}/integrations/servers/mcp-proxy.mjs`;
    for (const host of ['claude-code', 'codex', 'dsh'] as const) {
      const text = mcpSnippetFor(host).text;
      expect(text).toContain(proxyPath);
      expect(text).not.toContain(CONNECT_TOKEN_ENV);
      expect(text).not.toMatch(/\bcomem_[a-z0-9]/iu);
    }
    expect(mcpSnippetFor('hermes').text).toContain(CONNECT_TOKEN_ENV);
    expect(mcpSnippetFor('hermes').text).not.toMatch(/\bcomem_[a-z0-9]/u);
  });

  it('共享配置片段只包含地址和待替换占位符，不插入动态 Key', () => {
    const setup = sharedConfigSetupCommand();
    expect(setup).toContain('config_file="${COMEM_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}');
    expect(setup).toContain('install -d -m 700');
    expect(setup).toContain('install -m 600 /dev/null');
    expect(setup).toContain('chmod 600');
    expect(setup).toContain('"${EDITOR:-vi}"');

    const snippet = sharedConfigSnippet('http://127.0.0.1:18080/');
    expect(snippet).toEqual({
      format: 'YAML',
      text: "baseUrl: http://127.0.0.1:18080\ntoken: '<本页生成的 Key>'\n",
    });
  });
});

describe('当前账号 API Key', () => {
  it('用户主体生成既有自助 API Key 端点', () => {
    expect(userIdFromSubject('user:pengbo')).toBe('pengbo');
    expect(apiKeysPathForSubject('user:pengbo')).toBe('/admin/users/pengbo/api-keys');
    expect(userIdFromSubject('group:eng')).toBeNull();
    expect(apiKeysPathForSubject('group:eng')).toBeNull();
  });

  it('Key 名称按所选宿主设置', () => {
    expect(CONNECT_KEY_NAMES).toEqual({
      'claude-code': 'Claude Code',
      codex: 'Codex',
      dsh: 'DSH',
      hermes: 'Hermes',
    });
    for (const host of CONNECT_HOSTS) {
      expect(apiKeyNameForHost(host)).toBe(CONNECT_HOST_LABELS[host]);
    }
  });

  it('四个宿主共用显式生成按钮，Key 只保留在组件状态', () => {
    expect(CONNECT_PAGE).toContain('consoleIdentityState');
    expect(CONNECT_PAGE).toContain('generateConnectKey');
    expect(CONNECT_PAGE).toContain('生成 ${keyName} 接入 Key');
    expect(CONNECT_PAGE).toContain('apiKeyNameForHost(requestHost)');
    expect(CONNECT_PAGE).toContain('trustStepFor(host.value)');
    expect(CONNECT_PAGE).toContain(
      'doctorCommandFor(host.value, currentSubject.value, effectiveRepoRoot.value)',
    );
    expect(CONNECT_PAGE).toContain('完整 Key 只显示这一次');
    expect(CONNECT_PAGE).not.toContain('localStorage');
    expect(CONNECT_PAGE).not.toContain('sessionStorage');
    expect(CONNECT_PAGE).not.toMatch(/onMounted\([^)]*generateConnectKey/u);
  });

  it('页面明确区分控制台来源与 Agent 后端地址', () => {
    expect(CONNECT_PAGE).toContain('consoleOrigin');
    expect(CONNECT_PAGE).toContain('本网页');
    expect(CONNECT_PAGE).toContain('Agent');
  });

  it('页面把当前登录、Key 所有者和免凭据回环身份分开说明', () => {
    expect(CONNECT_PAGE).toContain('当前登录');
    expect(CONNECT_PAGE).toContain('接入 Key 所有者');
    expect(CONNECT_PAGE).toContain('免凭据连接会写入');
    expect(CONNECT_PAGE).toContain('未携带凭据的回环请求兜底身份');
    expect(CONNECT_PAGE).toContain('共享连接配置');
    expect(CONNECT_PAGE).toContain('integrations-repo-root');
    expect(CONNECT_PAGE).toContain('GUI 无需继承终端环境');
    expect(CONNECT_PAGE).toContain('to="/account"');
    expect(CONNECT_PAGE).not.toContain('服务绑定');
    expect(CONNECT_PAGE).not.toContain('is-mismatch');
  });

  it('宿主或账号切换会清空 Key 并使在途请求失效', () => {
    expect(CONNECT_PAGE).toContain('keyRequestVersion');
    expect(CONNECT_PAGE).toMatch(/requestVersion !== keyRequestVersion/u);
    expect(CONNECT_PAGE).toMatch(/host\.value !== requestHost/u);
    expect(CONNECT_PAGE).toMatch(/watch\(host,[\s\S]*resetCredentialState/u);
    expect(CONNECT_PAGE).toMatch(/watch\(currentSubject,[\s\S]*resetCredentialState/u);
  });

  it('会话检查只读当前账号个人根，不跟随团队作用域', () => {
    expect(CONNECT_PAGE).toContain("scope.startsWith('comem://user/')");
    expect(CONNECT_PAGE).toContain('const targetScope = personalScope.value');
    expect(CONNECT_PAGE).not.toContain("startsWith('hermes-')");
    expect(CONNECT_PAGE).not.toContain('scopeRoot');
  });
});

describe('自动采集安装', () => {
  it('Claude Code / Codex 给出使用仓库绝对路径的 --host 命令', () => {
    expect(hookInstallFor('claude-code', '/srv/CoMem')).toEqual({
      available: true,
      command: "node '/srv/CoMem/integrations/cli.mjs' install --host claude-code",
      note: null,
    });
    expect(hookInstallFor('codex', '/srv/CoMem')).toEqual({
      available: true,
      command: "node '/srv/CoMem/integrations/cli.mjs' install --host codex",
      note: null,
    });
  });

  it('DSH 不给会硬失败的 --host dsh，改为指向文档', () => {
    const hook = hookInstallFor('dsh');
    expect(hook.available).toBe(false);
    expect(hook.command).toBeNull();
    expect(hook.note).toContain('插件');
    expect(HOST_DOC_LINK.dsh).toBe(DOC_LINKS.dsh);
  });

  it('Claude Code 与 Codex 安装命令固定到输入的仓库路径', () => {
    for (const host of ['claude-code', 'codex'] as const) {
      const setup = automaticSetupFor(host, '/srv/CoMem');
      expect(setup.command).toContain("'/srv/CoMem/integrations/cli.mjs'");
      expect(setup.command).toContain(`--host ${host}`);
      expect(setup.detail).toContain('共享配置');
      expect(setup.detail).toContain('GUI 无需终端环境变量');
    }
  });

  it('DSH 原生插件保持空配置，沿用只读共享配置', () => {
    const setup = automaticSetupFor('dsh', '/srv/CoMem');
    expect(setup.command).toContain("'link:/srv/CoMem/integrations/dsh-plugin'");
    expect(setup.command).toContain('--profile YOUR_PROFILE');
    expect(setup.detail).toContain('YOUR_PROFILE');
    const config = parseYaml(setup.config?.text ?? '');
    expect(config).toMatchObject([
      {
        insert: [{ id: 'comem', name: 'comem-dsh-plugin' }],
      },
    ]);
    expect((config as Array<{ insert: Array<{ config: unknown }> }>)[0]?.insert[0]?.config).toEqual(
      {},
    );
    expect(setup.config?.text).not.toContain('baseUrl:');
    expect(setup.config?.text).not.toContain('token:');
    expect(setup.detail).toContain('共享配置');
    expect(setup.detail).toContain('GUI 无需终端环境变量');
  });

  it('Hermes 设置向导明确使用同一个配置文件环境变量', () => {
    const setup = automaticSetupFor('hermes');
    expect(setup.command).toBe('hermes memory setup');
    expect(setup.detail).toContain(CONNECT_TOKEN_ENV);
    expect(setup.detail).toContain('profile');
  });
});

describe('信任步骤', () => {
  it('四个宿主都要求用 health 的 subject 核对当前账号', () => {
    expect(trustStepFor('codex').title).toContain('/hooks');
    expect(trustStepFor('codex').detail).toContain('health');
    expect(trustStepFor('claude-code').detail).toContain('确认账号');
    expect(trustStepFor('dsh').detail).toContain('health');
    expect(trustStepFor('hermes').detail).toContain('hermes memory status');
  });

  it('Hook 身份自检使用当前账号，不在命令中出现凭据', () => {
    expect(doctorCommandFor('claude-code', 'user:pengbo', '/srv/CoMem')).toBe(
      `COMEM_CONFIG_FILE="${SHARED_CONFIG_PATH}" node '/srv/CoMem/integrations/cli.mjs' doctor --expect-subject user:pengbo`,
    );
    expect(doctorCommandFor('codex', 'user:pengbo', '/srv/CoMem')).toContain(
      '--expect-subject user:pengbo',
    );
    expect(doctorCommandFor('codex', 'user:INVALID')).toBeNull();
    expect(doctorCommandFor('dsh', 'user:pengbo')).toBeNull();
    expect(trustStepFor('codex').detail).toContain('上方 doctor 命令');
    expect(trustStepFor('codex').detail).not.toContain('--expect-subject');
  });

  it('仓库路径中的单引号经过 shell 安全转义', () => {
    expect(hookInstallFor('codex', "/srv/CoMem's").command).toBe(
      `node '/srv/CoMem'"'"'s/integrations/cli.mjs' install --host codex`,
    );
  });
});

describe('第一条记忆', () => {
  it('调用体就是可直接发送的 JSON-RPC 请求', () => {
    const call = firstMemoryCall();
    expect(call.method).toBe('tools/call');
    expect(call.params.name).toBe('remember');
    expect(call.params.arguments.messages).toEqual([
      { role: 'user', content: '以后用中文回答。' },
    ]);
  });

  it('curl 命令带 MCP 需要的 accept 头，请求体与调用体一致', () => {
    const curl = firstMemoryCurl();
    expect(curl).toContain('curl -sS');
    expect(curl).toContain(`${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`);
    expect(curl).toContain(`authorization: Bearer \${${CONNECT_TOKEN_ENV}}`);
    expect(curl).toContain("accept: application/json, text/event-stream");

    const payload = /-d '([^']+)'/u.exec(curl)?.[1];
    expect(payload).toBeDefined();
    expect(JSON.parse(payload ?? '')).toEqual(firstMemoryCall());
  });
});

describe('验证三态', () => {
  const HEALTH = { status: 'ok' } as const;
  const COMMITTED_SESSION = {
    lastCommitAt: '2026-01-02T03:04:05.000Z',
    messageCount: 0,
    messages: [],
  } as const;
  const EMPTY_SESSION = {
    lastCommitAt: null,
    messageCount: 0,
    messages: [],
  } as const;

  it('三项都通过', () => {
    const result = deriveVerification({
      health: HEALTH,
      healthError: null,
      sessions: [COMMITTED_SESSION],
      sessionsError: null,
    });

    expect(result.checks.map((check) => check.key)).toEqual(['server', 'sessions', 'cursor']);
    expect(result.checks.map((check) => check.tone)).toEqual(['ok', 'ok', 'ok']);
    expect(result.allGreen).toBe(true);
  });

  it('服务端不可达：服务端失败，另外两项不再声称通过', () => {
    const result = deriveVerification({
      health: null,
      healthError: '无法连接 CoMem 服务，请确认后端已启动。',
      sessions: null,
      sessionsError: null,
    });

    expect(result.checks[0]).toMatchObject({ key: 'server', tone: 'fail' });
    expect(result.checks[1]?.tone).toBe('idle');
    expect(result.checks[2]?.tone).toBe('idle');
    expect(result.allGreen).toBe(false);
  });

  it('有会话但没有游标证据：会话通过、游标待处理', () => {
    const result = deriveVerification({
      health: HEALTH,
      healthError: null,
      sessions: [EMPTY_SESSION],
      sessionsError: null,
    });

    expect(result.checks.map((check) => check.tone)).toEqual(['ok', 'ok', 'warn']);
    expect(result.checks[2]?.detail).toContain('提交');
    expect(result.checks[2]?.hint).toBe(CURSOR_INSPECT_COMMAND);
    expect(result.allGreen).toBe(false);
  });

  it('无宿主来源的会话只陈述当前账号数据，不冒充某个宿主已接通', () => {
    const missing = deriveVerification({
      health: HEALTH,
      healthError: null,
      sessionsError: null,
      currentSubject: 'user:pengbo',
      sessions: [],
    });
    expect(missing.checks.map((check) => check.key)).toEqual(['server', 'sessions', 'cursor']);
    expect(missing.checks[1]?.label).toBe('当前账号会话');
    expect(missing.checks[1]?.detail).toContain('user:pengbo');
    expect(missing.checks[1]?.detail).toContain('还没有归档');
    expect(missing.checks[1]?.tone).toBe('warn');
    expect(missing.allGreen).toBe(false);
    const observed = deriveVerification({
      health: HEALTH,
      healthError: null,
      sessionsError: null,
      currentSubject: 'user:pengbo',
      sessions: [{ ...COMMITTED_SESSION, id: 'unknown-origin' }],
    });
    expect(observed.allGreen).toBe(true);
    expect(observed.checks[1]?.label).toBe('当前账号会话');
    expect(observed.checks[1]?.detail).toContain('user:pengbo');
    expect(observed.checks[1]?.detail).toContain('1 个归档会话');
    expect(JSON.stringify(observed)).not.toContain('Hermes');
  });
});

describe('概览页空状态', () => {
  it('新装：没有索引、没有排队任务、任务列表为空', () => {
    const health = { index: { totalNodes: 0 }, queue: { pending: 0 } };
    expect(isFreshInstall(health, 0)).toBe(true);
  });

  it('有索引 / 有排队任务 / 有任务行 / 还没取到健康数据时都不算新装', () => {
    expect(isFreshInstall({ index: { totalNodes: 1 }, queue: { pending: 0 } }, 0)).toBe(false);
    expect(isFreshInstall({ index: { totalNodes: 0 }, queue: { pending: 1 } }, 0)).toBe(false);
    expect(isFreshInstall({ index: { totalNodes: 0 }, queue: { pending: 0 } }, 1)).toBe(false);
    expect(isFreshInstall(null, 0)).toBe(false);
  });

  it('概览页用同一个判定，并给出到接入页的入口', () => {
    expect(INDEX_PAGE).toContain('isFreshInstall');
    expect(INDEX_PAGE).toContain('to="/connect"');
    expect(INDEX_PAGE).toContain('接入 Agent');
  });
});
