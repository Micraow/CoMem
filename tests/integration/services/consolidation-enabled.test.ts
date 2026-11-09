/**
 * `memory.consolidation.enabled = true` 的接线验收（架构文档 §11.8）。
 *
 * 已有的 `tests/integration/services/consolidation.test.ts` 分成两半：
 * - 合并逻辑用 `new ConsolidationService(...)` 直接构造，**绕过了配置开关**；
 * - 开关关闭时 HTTP 端点返回 403。
 *
 * 缺的是中间那一段：配置打开后，`POST /api/v1/memories/consolidate` 真的会调模型、
 * 真的会写盘。把开关「打开」而测试只断言「不报错」，与「关着时返回 403」加起来仍
 * 证明不了端点走通了合并——`ConsolidationService` 构造了但路由拿到的不是它、或者
 * `dryRun` 默认值把写盘吞掉，两种缺陷都只会在真实链路上出现。
 *
 * 模型用回环 HTTP 替身（`tests/helpers/fake-llm-http.ts`）：走真实 `AiSdkLlmProvider`
 * 的请求/解析路径，不 mock `ai` 包，也不出网。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';

const SCOPE = 'comem://user/local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

const CODE_STYLE = `${SCOPE}/memories/preferences/code-style.md`;
const CODE_STYLE_LEGACY = `${SCOPE}/memories/preferences/code-style-legacy.md`;
const EDITOR = `${SCOPE}/memories/preferences/editor.md`;

let dataDir: string;
let container: Container;
let app: FastifyInstance | undefined;
let llm: FakeLlmHttp;

/** 模型第 1 轮就 finish：把 legacy 合并进 code-style，并删掉 legacy。 */
function consolidationDecision(): string {
  return JSON.stringify({
    action: 'finish',
    operations: [
      {
        kind: 'update',
        uri: CODE_STYLE,
        content: '缩进用 2 个空格，统一用 prettier 格式化。',
        reason: 'code-style-legacy 的结论已被 code-style 取代，合并成一条',
      },
      {
        kind: 'delete',
        uri: CODE_STYLE_LEGACY,
        reason: '内容已并入 code-style',
      },
    ],
  });
}

beforeEach(async () => {
  llm = await startFakeLlmHttp(() => consolidationDecision());
  dataDir = await mkdtemp(join(tmpdir(), 'comem-consolidation-enabled-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_TYPE: 'openai-compatible',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: llm.baseUrl,
      COMEM_PROVIDERS_LLM_DEFAULT_MODEL: 'fake',
      COMEM_PROVIDERS_LLM_DEFAULT_API_KEY: 'test',
      // 后台调度器与本用例无关。
      COMEM_SESSION_AUTOCOMMIT_ENABLED: 'false',
      COMEM_MEMORY_CONSOLIDATION_ENABLED: 'true',
    },
  });
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
});

afterEach(async () => {
  await app?.close();
  await container.close();
  await llm.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function writePreference(topic: string, content: string): Promise<void> {
  await container.services.memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
    topic,
    content,
  });
}

describe('memory.consolidation.enabled = true（container → HTTP 端点）', () => {
  it('打开后端点真的合并：更新正文、删除被取代的记忆，二者在检索面上都可见', async () => {
    expect(container.config.memory.consolidation.enabled).toBe(true);
    await writePreference('code-style', '缩进用 2 个空格。');
    await writePreference('code-style-legacy', '缩进用 4 个空格，且不要用 prettier。');
    await writePreference('editor', '默认编辑器是 vim。');
    await container.services.indexObserver.drain();

    const server = app;
    if (server === undefined) {
      throw new Error('HTTP 服务没有启动。');
    }
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/memories/consolidate',
      payload: { scope: SCOPE, dryRun: false },
    });

    // 开关关着时这里会是 403；打开后必须是一次真的合并，不是「没有可合并的记忆」。
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      readonly status: string;
      readonly result: {
        readonly adds: readonly string[];
        readonly updates: readonly string[];
        readonly deletes: readonly string[];
        readonly trace: readonly { readonly action: string }[];
      };
    };
    expect(body.status).toBe('ok');
    expect(body.result.adds).toEqual([]);
    expect(body.result.updates).toEqual([CODE_STYLE]);
    expect(body.result.deletes).toEqual([CODE_STYLE_LEGACY]);

    // 用户可见结果 1：被更新的记忆正文是模型给的合并结果。
    const updated = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(updated?.fields['content']).toBe('缩进用 2 个空格，统一用 prettier 格式化。');

    // 用户可见结果 2：被删除的记忆读不到了。
    await expect(container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).resolves.toBeNull();

    // 用户可见结果 3：检索面从 3 条变成 2 条，editor 没有被波及。
    const remaining = await container.services.search.glob('**/*.md', {
      scopes: [`${SCOPE}/memories`],
      subject: 'user:local',
      principals: PRINCIPALS,
    });
    expect(remaining.map((uri) => uri.toString()).sort()).toEqual([CODE_STYLE, EDITOR].sort());

    // 真的调过模型：没有这条，「端点 200」也可能来自一次空操作。
    expect(llm.requests.length).toBeGreaterThan(0);
  });
});
