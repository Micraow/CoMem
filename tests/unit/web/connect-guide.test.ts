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
  CURSOR_INSPECT_COMMAND,
  DEFAULT_SERVER_BASE_URL,
  DOC_LINKS,
  HOST_CONFIG_LOCATION,
  HOST_DOC_LINK,
  MCP_ENDPOINT_PATH,
  MCP_SERVER_NAME,
  deriveVerification,
  firstMemoryCall,
  firstMemoryCurl,
  hookInstallFor,
  isFreshInstall,
  mcpSnippetFor,
  trustStepFor,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('宿主清单', () => {
  it('三个宿主按文档顺序排列，标签就是宿主自己的名字', () => {
    expect([...CONNECT_HOSTS]).toEqual(['claude-code', 'codex', 'dsh']);
    expect(CONNECT_HOSTS.map((host) => CONNECT_HOST_LABELS[host])).toEqual([
      'Claude Code',
      'Codex',
      'DSH',
    ]);
  });

  it('每个宿主都有配置位置与文档锚点', () => {
    const docKeys = { 'claude-code': 'claudeCode', codex: 'codex', dsh: 'dsh' } as const;
    for (const host of CONNECT_HOSTS) {
      expect(HOST_CONFIG_LOCATION[host]).not.toBe('');
      expect(HOST_DOC_LINK[host]).toBe(DOC_LINKS[docKeys[host]]);
      expect(HOST_DOC_LINK[host]).toContain('#');
    }
    expect(DOC_LINKS.claudeCode).toContain('#claude-code');
    expect(DOC_LINKS.dsh).toContain('#dsh');
  });
});

describe('MCP 配置片段', () => {
  it('服务地址与端点路径跟仓库里的来源一致', () => {
    expect(CONFIG_SOURCE).toContain(DEFAULT_SERVER_BASE_URL);
    expect(README).toContain(`${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`);
    for (const host of CONNECT_HOSTS) {
      expect(mcpSnippetFor(host).text).toContain(
        `${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`,
      );
    }
  });

  it('Claude Code 给 JSON，type 不能省', () => {
    const snippet = mcpSnippetFor('claude-code');
    expect(snippet.format).toBe('JSON');

    const parsed: unknown = JSON.parse(snippet.text);
    expect(isRecord(parsed) && isRecord(parsed['mcpServers'])).toBe(true);
    if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
      throw new Error('Claude Code 片段不是 mcpServers 对象');
    }
    expect(parsed['mcpServers'][MCP_SERVER_NAME]).toEqual({
      type: 'http',
      url: `${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`,
    });
    expect(README).toContain('"type": "http"');
  });

  it('Codex 给 TOML，表名与 url 字段和 codex mcp add 写出的配置一致', () => {
    const snippet = mcpSnippetFor('codex');
    expect(snippet.format).toBe('TOML');
    expect(snippet.text).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(snippet.text).toContain(`url = "${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}"`);
    expect(README).toContain('~/.codex/config.toml');
  });

  it('DSH 给可解析的 YAML，transport 是必填字段', () => {
    const snippet = mcpSnippetFor('dsh');
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
        transport: 'streamable-http',
        url: `${DEFAULT_SERVER_BASE_URL}${MCP_ENDPOINT_PATH}`,
      },
    });
    expect(README).toContain('transport: streamable-http');
  });
});

describe('自动采集安装', () => {
  it('Claude Code / Codex 给出可执行的 --host 命令', () => {
    expect(hookInstallFor('claude-code')).toEqual({
      available: true,
      command: 'node integrations/cli.mjs install --host claude-code',
      note: null,
    });
    expect(hookInstallFor('codex')).toEqual({
      available: true,
      command: 'node integrations/cli.mjs install --host codex',
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
});

describe('信任步骤', () => {
  it('Codex 去 /hooks 逐条信任，Claude Code 批准项目级 MCP 服务器', () => {
    expect(trustStepFor('codex').detail).toContain('/hooks');
    expect(trustStepFor('codex').detail).toContain('integrations/servers');
    expect(trustStepFor('claude-code').detail).toContain('.mcp.json');
    expect(trustStepFor('dsh').detail).toContain('插件');
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
