import { describe, expect, it } from 'vitest';

import {
  clearConsoleSession,
  readConsoleSession,
  writeConsoleSession,
  type ConsoleSession,
} from '../../../web/composables/consoleAuth.js';
import {
  ConsoleIdentityError,
  bootstrapConsoleIdentity,
  consoleIdentityOrThrow,
  consoleIdentityState,
  identityHeaders,
  logoutConsole,
  setConsoleIdentity,
  type ConsoleRequest,
} from '../../../web/composables/consoleIdentity.js';

const BASE = 'https://console.example.test/api/v1';
const SUBJECT = 'user:alice';

/**
 * 控制台身份引导的单元测试。
 *
 * 状态是模块级单例（`ssr: false`，没有两个请求共用一份的问题）。本文件先验证
 * 「插件没成功时没有身份」，再把它设成 `ready` 验证请求头——顺序是有意的，测试
 * 之间不共享可重置的钩子。
 */
describe('身份未确定', () => {
  it('插件跑完之前状态是 pending，后续请求在 fetch 之前抛错', () => {
    expect(consoleIdentityState().status).toBe('pending');
    expect(() => consoleIdentityOrThrow()).toThrow(ConsoleIdentityError);
    expect(() => identityHeaders()).toThrow(ConsoleIdentityError);
  });
});

describe('请求头', () => {
  function installStorage(): { clear: () => void } {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
      clear: (): void => {
        store.clear();
      },
    };
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
    return { clear: () => storage.clear() };
  }

  function removeStorage(): void {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  }

  function sessionOf(token = 'v1.test.token'): ConsoleSession {
    return {
      token,
      subject: SUBJECT,
      principals: [SUBJECT],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  it('清 sessionStorage 等于登出：identityHeaders 不再带 Bearer（W59）', () => {
    const storage = installStorage();
    try {
      clearConsoleSession();
      writeConsoleSession(sessionOf());
      setConsoleIdentity({ subject: SUBJECT, scopes: [] });
      expect(identityHeaders()).toEqual({ authorization: 'Bearer v1.test.token' });

      // 另一个标签页登出 / 用户手动清存储：模块级缓存不能继续发旧 token。
      storage.clear();

      expect(readConsoleSession()).toBeNull();
      expect(identityHeaders()).toEqual({});
    } finally {
      removeStorage();
    }
  });

  it('再次写入后读到的是新 token', () => {
    installStorage();
    try {
      clearConsoleSession();
      writeConsoleSession(sessionOf('first'));
      writeConsoleSession(sessionOf('second'));

      expect(readConsoleSession()?.token).toBe('second');
    } finally {
      removeStorage();
    }
  });
});

describe('身份引导的状态机（GET /bootstrap 优先）', () => {
  const BOOTSTRAP = {
    needsSetup: false,
    boundSubject: SUBJECT,
    adminConfigured: true,
  } as const;

  /** 按 URL 路由的替身；未登记的路径返回 404。 */
  function routedRequest(
    routes: Readonly<Record<string, unknown>>,
    calls: string[] = [],
  ): ConsoleRequest {
    return async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const payload = routes[url];
      return {
        ok: payload !== undefined,
        status: payload === undefined ? 404 : 200,
        json: async () => payload,
      };
    };
  }

  it('needsSetup: true 进初始化状态，且不再读会话', async () => {
    const calls: string[] = [];
    const state = await bootstrapConsoleIdentity(
      BASE,
      routedRequest(
        {
          [`${BASE}/bootstrap`]: {
            status: 'ok',
            result: { ...BOOTSTRAP, needsSetup: true },
          },
        },
        calls,
      ),
    );

    expect(state).toMatchObject({
      status: 'setup-required',
      bootstrap: { needsSetup: true, boundSubject: SUBJECT },
    });
    expect(calls).toEqual([`GET ${BASE}/bootstrap`]);
  });

  it('needsSetup: false 且没有会话 → 登录页', async () => {
    clearConsoleSession();
    const state = await bootstrapConsoleIdentity(
      BASE,
      routedRequest({ [`${BASE}/bootstrap`]: { status: 'ok', result: BOOTSTRAP } }),
    );

    expect(state).toEqual({ status: 'unauthenticated' });
  });

  it('会话可读 → 就绪，作用域来自逐个根探测', async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: {
        getItem: (key: string): string | null => storage.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          storage.set(key, value);
        },
        removeItem: (key: string): void => {
          storage.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      clearConsoleSession();
      writeConsoleSession({
        token: 'v1.test.token',
        subject: SUBJECT,
        principals: [SUBJECT, 'group:eng'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const calls: string[] = [];
      const state = await bootstrapConsoleIdentity(
        BASE,
        routedRequest(
          {
            [`${BASE}/bootstrap`]: { status: 'ok', result: BOOTSTRAP },
            [`${BASE}/fs/tree?uri=comem%3A%2F%2Fuser%2Falice&depth=1&limit=1`]: {
              status: 'ok',
              result: {},
            },
            // 组根没有可读内容（根预置缺失）：跳过它，不列出一个切过去就 403 的根。
            [`${BASE}/fs/tree?uri=comem%3A%2F%2Fgroup%2Feng&depth=1&limit=1`]: undefined,
          },
          calls,
        ),
      );

      expect(state).toEqual({
        status: 'ready',
        identity: { subject: SUBJECT, scopes: ['comem://user/alice'] },
      });
      // 两个候选根各探测一次；组根 404 被跳过。
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe(`GET ${BASE}/bootstrap`);
    } finally {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });

  it('/bootstrap 失败时整页报错，不猜一个默认身份', async () => {
    const request: ConsoleRequest = async () => ({ ok: false, status: 500, json: async () => ({}) });

    await expect(bootstrapConsoleIdentity(BASE, request)).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNAVAILABLE',
    });
  });
});

describe('退出登录', () => {
  function installStorage(): Map<string, string> {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: {
        getItem: (key: string): string | null => store.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          store.set(key, value);
        },
        removeItem: (key: string): void => {
          store.delete(key);
        },
        clear: (): void => {
          store.clear();
        },
      },
      configurable: true,
      writable: true,
    });
    return store;
  }

  function removeStorage(): void {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  }

  const SESSION: ConsoleSession = {
    token: 'v1.test.token',
    subject: SUBJECT,
    principals: [SUBJECT],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it('等响应体读完再返回，避免导航中止请求（W59）', async () => {
    installStorage();
    try {
      clearConsoleSession();
      writeConsoleSession(SESSION);

      let bodyConsumed = false;
      const request: ConsoleRequest = async (url, init) => {
        expect(url).toBe(`${BASE}/auth/logout`);
        expect(init?.method).toBe('POST');
        expect(init?.headers?.['authorization']).toBe('Bearer v1.test.token');
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', result: { loggedOut: true } }),
          text: async () => {
            bodyConsumed = true;
            return '{"status":"ok"}';
          },
        };
      };

      await logoutConsole(BASE, request);

      // 旧实现只 `await request(...)`，不读响应体；调用方的 `location.assign`
      // 会让浏览器把请求记成 `net::ERR_ABORTED`。
      expect(bodyConsumed).toBe(true);
      expect(readConsoleSession()).toBeNull();
    } finally {
      removeStorage();
    }
  });

  it('请求失败也清本地会话（finally）', async () => {
    installStorage();
    try {
      clearConsoleSession();
      writeConsoleSession(SESSION);
      const request: ConsoleRequest = async () => {
        throw new Error('network down');
      };

      await expect(logoutConsole(BASE, request)).resolves.toBeUndefined();
      expect(readConsoleSession()).toBeNull();
    } finally {
      removeStorage();
    }
  });

  it('没有会话时不发请求', async () => {
    installStorage();
    try {
      clearConsoleSession();
      let called = false;
      const request: ConsoleRequest = async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      };

      await logoutConsole(BASE, request);
      expect(called).toBe(false);
    } finally {
      removeStorage();
    }
  });
});
