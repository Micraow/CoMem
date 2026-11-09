/**
 * 摘要降级必须对调用方可见（架构文档 §9.2、§17.9「静默降级等于骗人」）。
 *
 * 缺陷现场：`SummaryService.read` 恒返回 `degraded: false`，而适配层已经解析出
 * `.abstract.md` / `.overview.md` frontmatter 里的 `degraded`。结果 `GET /content/abstract`
 * 与 `GET /content/overview` 永远显示「非降级」——规则摘要冒充模型摘要。
 *
 * 用例走真实链路：配置 `summary.generator: rule` → `RuleSummarizer` 产出
 * `degraded: true` → 写进摘要文件 frontmatter → `read` 回填 → HTTP 响应体里也是 true。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const DIR = `${ROOT}/memories`;

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request): Promise<Response> => {
      throw new TypeError(`集成测试不发起真实网络请求：${String(input)}`);
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-summary-degraded-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      // 规则摘要 = 降级生成（`RuleSummarizer` 恒带 `degraded: true`）。
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:1/v1',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
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
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function inject(options: InjectOptions) {
  return app.inject(options);
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function encode(uri: string): string {
  return encodeURIComponent(uri);
}

/** 建一个只含一条记忆的目录，并把它自己的 L0/L1 摘要按规则生成器落盘。 */
async function seedDegradedSummary(): Promise<void> {
  await inject({
    method: 'POST',
    url: '/api/v1/content/write',
    payload: { uri: `${DIR}/deploy.md`, content: '部署流程：滚动重启。' },
  });
  await container.services.indexObserver.drain();
  // `regenerate` 是显式的子树重建：不看新鲜度，一定写出摘要文件。
  await container.services.summary.regenerate(Uri.parse(DIR));
}

describe('摘要降级可见', () => {
  it('SummaryService.read 回填摘要文件里的 degraded', async () => {
    await seedDegradedSummary();

    const summary = await container.services.summary.read(Uri.parse(DIR));
    expect(summary).not.toBeNull();
    expect(summary?.degraded).toBe(true);
    // 摘要本身是规则拼出来的：有内容，说明不是「读不到所以降级」。
    expect(summary?.abstract.length).toBeGreaterThan(0);
  });

  it('content/abstract 与 content/overview 的响应体里 degraded 是 true', async () => {
    await seedDegradedSummary();

    const abstract = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/abstract?uri=${encode(DIR)}` }),
    );
    expect(abstract['degraded']).toBe(true);
    expect(abstract['source']).toBe('summary');

    const overview = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/overview?uri=${encode(DIR)}` }),
    );
    expect(overview['degraded']).toBe(true);
    expect(overview['source']).toBe('summary');
  });
});
