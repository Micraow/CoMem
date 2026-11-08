import { describe, expect, it } from 'vitest';

import {
  ConsoleIdentityError,
  consoleIdentityOrThrow,
  consoleIdentityState,
  fetchConsoleIdentity,
  identityHeaders,
  type HealthFetcher,
  type HealthResponseLike,
} from '../../../web/composables/consoleIdentity.js';

const BASE = 'https://console.example.test/api/v1';
const SUBJECT = 'user:alice';

function healthResponse(result: unknown, status = 200): HealthResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ status: 'ok', result }),
  };
}

/** 记录请求 URL 的替身。控制台只应该请求 `/health` 一次。 */
function fetcherOf(response: HealthResponseLike, calls: string[] = []): HealthFetcher {
  return async (url) => {
    calls.push(url);
    return response;
  };
}

/**
 * 控制台身份引导的单元测试。
 *
 * **本文件不调用 `setConsoleIdentity`**：状态转换由 `plugins/console-identity.ts`
 * 负责，这里只覆盖「从 /health 解出主体」「主体进请求头」「失败与字段缺失」。也
 * 正因为如此，`consoleIdentityState()` 在整个文件里保持 `pending`——它证明的是
 * 「插件没成功时控制台没有身份」，而不是「测试把状态复位了」。
 */
describe('控制台身份引导', () => {
  it('从 /health 取服务端主体，并把它写进请求头', async () => {
    const calls: string[] = [];
    const identity = await fetchConsoleIdentity(
      BASE,
      fetcherOf(healthResponse({ subject: SUBJECT, scopes: ['comem://user/alice'] }), calls),
    );

    expect(calls).toEqual([`${BASE}/health`]);
    expect(identity).toEqual({ subject: SUBJECT, scopes: ['comem://user/alice'] });
    // 后续请求用的就是这里构造的头（`useApi` 的 `request` 只做这一件事）。
    expect(identityHeaders(identity)).toEqual({ 'x-comem-subject': SUBJECT });
  });

  it('base 末尾的斜杠不会拼出 //health', async () => {
    const calls: string[] = [];
    await fetchConsoleIdentity(
      `${BASE}/`,
      fetcherOf(healthResponse({ subject: SUBJECT, scopes: [] }), calls),
    );
    expect(calls).toEqual([`${BASE}/health`]);
  });

  it('/health 500 时抛错，控制台没有身份，后续请求发不出去', async () => {
    const request: HealthFetcher = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(fetchConsoleIdentity(BASE, request)).rejects.toBeInstanceOf(ConsoleIdentityError);
    await expect(fetchConsoleIdentity(BASE, request)).rejects.toMatchObject({
      code: 'HEALTH_UNAVAILABLE',
    });

    // 插件只在成功时落身份；失败后状态停在 pending，`useApi` 的请求在 fetch 之前抛错。
    expect(consoleIdentityState().status).toBe('pending');
    expect(() => consoleIdentityOrThrow()).toThrow(ConsoleIdentityError);
  });

  it('subject / scopes 缺失或类型不对时不猜默认主体', async () => {
    const invalid: readonly unknown[] = [
      { scopes: ['comem://user/alice'] },
      { subject: '', scopes: ['comem://user/alice'] },
      { subject: 42, scopes: ['comem://user/alice'] },
      { subject: SUBJECT },
      { subject: SUBJECT, scopes: 'comem://user/alice' },
      { subject: SUBJECT, scopes: [1] },
    ];

    for (const result of invalid) {
      await expect(
        fetchConsoleIdentity(BASE, fetcherOf(healthResponse(result))),
      ).rejects.toMatchObject({ code: 'INVALID_HEALTH_RESPONSE' });
    }
  });

  it('响应不是 JSON 时抛 INVALID_HEALTH_RESPONSE', async () => {
    const request: HealthFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(fetchConsoleIdentity(BASE, request)).rejects.toMatchObject({
      code: 'INVALID_HEALTH_RESPONSE',
    });
  });

  it('scopes 为空是合法状态：主体没有任何可访问的命名空间', async () => {
    const identity = await fetchConsoleIdentity(
      BASE,
      fetcherOf(healthResponse({ subject: SUBJECT, scopes: [] })),
    );
    expect(identity.scopes).toEqual([]);
  });
});
