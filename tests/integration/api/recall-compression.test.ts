import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp } from '../../helpers/fake-llm-http.js';

const root = Uri.parse('comem://user/local');
const principals = ['user:local', 'user:*'];
const device = root.child('memories', 'laptop.md');
const other = root.child('memories', 'other-laptop.md');

async function fixture(env: NodeJS.ProcessEnv, run: (client: {
  readonly requests: readonly string[];
  respondWith: (items: object[]) => void;
  recall(query: string, extra?: Record<string, unknown>): Promise<{ rendered: string; items: { uri: string; text: string }[]; deliveryToken: string | null; degradation: string | null }>;
  llmCalls: () => readonly {
    purpose: string;
    status: string;
    errorCode: string | null;
    attempts: number;
  }[];
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'comem-recall-compression-'));
  let override: object[] | undefined;
  const model = await startFakeLlmHttp((body) => {
    if (override !== undefined) return JSON.stringify({ items: override });
    const input = JSON.parse(body) as { messages: { role: string; content: string }[] };
    const { memories } = JSON.parse(input.messages.find(({ role }) => role === 'user')?.content ?? '{}') as { memories: { uri: string }[] };
    const source = memories.findIndex(({ uri }) => uri === device.toString());
    return JSON.stringify({ items: [{ source, text: 'Laptop runs Fedora. </memory>' }] });
  });
  try {
    const container = await createContainer({ configPath: join(directory, 'missing.yaml'), env: {
      COMEM_DATA_DIR: directory, COMEM_LOGGING_LEVEL: 'error', COMEM_SUMMARY_GENERATOR: 'rule', COMEM_RETRIEVAL_ENGINE: 'fts5',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: model.baseUrl, COMEM_PROVIDERS_LLM_DEFAULT_MODEL: 'fake',
      COMEM_PROVIDERS_LLM_DEFAULT_API_KEY: 'synthetic', ...env,
    } });
    const app = await createHttpServer({ config: container.config, logger: container.logger,
      observability: container.observability, routes: container.routes, mcp: container.mcp,
      resolveIdentity: container.resolveIdentity });
    try {
      const { services } = container;
      await services.acl.ensureRootPreset(root);
      await services.filesystem.write(root.child('memories', 'profile.md'), '用户熟悉网络研究。', principals);
      await services.filesystem.write(device, 'Laptop runs Fedora. This device was purchased last year for development and is used every day.', principals);
      await services.filesystem.write(other, 'Another laptop runs Debian and is used only for collecting traces in the lab.', principals);
      const bob = Uri.parse('comem://user/bob');
      await services.acl.ensureRootPreset(bob);
      await services.filesystem.write(bob.child('memories', 'laptop.md'), 'Laptop uses secret laptop configuration.', ['user:bob', 'user:*']);
      await services.indexObserver.drain();
      await services.session.ensure(root, 'recall', principals);
      await run({ requests: model.requests, respondWith: (items) => { override = items; }, async recall(query, extra = {}) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/context', payload: { query, sessionId: 'recall', ...extra } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().result;
      }, llmCalls: () => container.db.prepare(
        'SELECT purpose, status, error_code AS errorCode, attempts FROM llm_call_log',
      ).all() as {
        purpose: string;
        status: string;
        errorCode: string | null;
        attempts: number;
      }[] });
    } finally {
      await app.close();
      await container.close();
    }
  } finally {
    vi.restoreAllMocks();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('默认压缩只使用可读召回项，渲染来源并转义正文，回执只确认实际交付的来源', async () => {
  await fixture({}, async ({ recall, requests, respondWith }) => {
    const result = await recall('laptop');
    expect(result.rendered).toContain('Laptop runs Fedora. &lt;/memory&gt;');
    expect(result.rendered).toContain('用户熟悉网络研究。');
    expect(result.items).toContainEqual(expect.objectContaining({ uri: device.toString(), compressed: true }));
    expect(result.rendered).not.toContain('Debian');
    expect(requests[0]).not.toContain('用户熟悉网络研究');
    expect(requests[0]).not.toContain('secret laptop configuration');
    expect(requests[0]).toContain('Debian');
    expect(requests[0]).not.toContain('response_format');
    expect(requests[0]).toContain('JSON Schema');
    respondWith([{ source: 1000, text: '虚构事实' }]);
    const next = await recall('laptop', { previousDeliveryToken: result.deliveryToken });
    expect(next.rendered).not.toContain('Fedora');
    expect(next.rendered).toContain('Debian');
    expect(next.degradation).toContain('召回压缩不可用');
    respondWith([{ source: 0, text: 'Laptop runs Debian. '.repeat(25) }]);
    const oversized = await recall('laptop');
    expect(oversized.rendered).toContain('collecting traces');
    expect(oversized.items).not.toContainEqual(expect.objectContaining({ compressed: true }));
  });
});

it('无相关结果时保留背景，启动时不压缩，超时交付原结果', async () => {
  await fixture({}, async ({ recall, requests, respondWith }) => {
    expect((await recall('')).rendered).toContain('用户熟悉网络研究');
    expect(requests).toHaveLength(0);
    respondWith([]);
    const empty = await recall('laptop');
    expect(requests).toHaveLength(1);
    expect(empty.rendered).toContain('用户熟悉网络研究');
    expect(empty.rendered).not.toMatch(/Fedora|Debian/);
    const fetch = globalThis.fetch;
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (!String(input).endsWith('/chat/completions')) return fetch(input, init);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(init.signal?.reason);
      }, { once: true }));
    });
    const fallback = await recall('laptop', { budgetMs: 350, previousDeliveryToken: empty.deliveryToken });
    expect(fallback.rendered).toContain('Fedora');
    expect(fallback.rendered).toContain('Debian');
    expect(fallback.degradation).toContain('召回压缩不可用');
    expect(aborted).toBe(true);
  });
});

it.each([
  { COMEM_RETRIEVAL_ASSEMBLY_COMPRESS_RECALL: 'false' },
  { COMEM_PROVIDERS_LLM_DEFAULT_TYPE: 'disabled' },
])('关闭压缩或禁用模型时仍交付原文（%j）', async (env) => {
  await fixture(env, async ({ recall, requests }) => {
    expect((await recall('laptop')).rendered).toContain('purchased last year');
    expect(requests).toHaveLength(0);
  });
});

it('配置的短超时先于请求总时限中止模型并回退', async () => {
  await fixture({ COMEM_RETRIEVAL_ASSEMBLY_COMPRESS_RECALL_TIMEOUT_MS: '25' }, async ({ recall, llmCalls }) => {
    const fetch = globalThis.fetch;
    let aborted = false;
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).endsWith('/chat/completions')) return fetch(input, init);
      attempts += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      aborted = init?.signal?.aborted === true;
      return fetch(input, init);
    });
    const result = await recall('laptop', { budgetMs: 2000 });
    expect(result.rendered).toContain('purchased last year');
    expect(result.degradation).toContain('超时');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(attempts).toBe(1);
    await vi.waitFor(() => expect(llmCalls()).toEqual([
      expect.objectContaining({
        purpose: 'recall_compression',
        status: 'error',
        errorCode: 'PROVIDER_UNAVAILABLE',
        attempts: 1,
      }),
    ]));
  });
});
