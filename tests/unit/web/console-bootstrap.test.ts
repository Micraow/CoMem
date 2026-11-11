/**
 * 首次初始化（`GET /bootstrap`、`POST /bootstrap/admin`）。
 *
 * 服务端契约来自架构文档 §16 的身份引导与 §12.7 的认证开关：初始化状态只有
 * 「没有任何用户设置过密码」这一种，创建账号的响应必须回答「是否还要重启」。
 * 这里用普通对象替身穷举字段缺失、错误码与表单校验，不依赖服务端实现。
 */
import { describe, expect, it } from 'vitest';

import {
  ConsoleBootstrapError,
  bootstrapErrorNotice,
  createBootstrapAdmin,
  fetchConsoleBootstrap,
  setupAdminConfigSnippet,
  validateSetupForm,
  type ConsoleBootstrap,
} from '../../../web/composables/consoleBootstrap.js';
import type { ConsoleRequest } from '../../../web/composables/consoleIdentity.js';

const BASE = 'https://console.example.test/api/v1';

interface MockResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

function jsonResponse(payload: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function bootstrapPayload(overrides: Partial<ConsoleBootstrap> = {}): unknown {
  return {
    status: 'ok',
    result: {
      needsSetup: false,
      authEnabled: true,
      boundSubject: 'user:local',
      adminConfigured: true,
      restartRequired: false,
      setupTokenRequired: true,
      ...overrides,
    },
  };
}

function adminPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: 'ok',
    result: {
      userId: 'local',
      created: true,
      passwordSet: true,
      authEnabled: false,
      restartRequired: true,
      ...overrides,
    },
  };
}

function errorPayload(code: string, message: string): unknown {
  return { status: 'error', error: { code, message } };
}

describe('初始化状态（GET /bootstrap）', () => {
  it('解出六个状态字段，且是匿名只读 GET', async () => {
    const calls: string[] = [];
    const request: ConsoleRequest = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return jsonResponse(bootstrapPayload({ needsSetup: true, authEnabled: false }));
    };

    await expect(fetchConsoleBootstrap(BASE, request)).resolves.toEqual({
      needsSetup: true,
      authEnabled: false,
      boundSubject: 'user:local',
      adminConfigured: true,
      restartRequired: false,
      setupTokenRequired: true,
    });
    expect(calls).toEqual([`GET ${BASE}/bootstrap`]);
  });

  it('base 末尾的斜杠不会拼出 //bootstrap', async () => {
    const calls: string[] = [];
    const request: ConsoleRequest = async (url) => {
      calls.push(url);
      return jsonResponse(bootstrapPayload());
    };

    await fetchConsoleBootstrap(`${BASE}/`, request);
    expect(calls).toEqual([`${BASE}/bootstrap`]);
  });

  it('非 200 抛 BOOTSTRAP_UNAVAILABLE，不猜「已初始化」', async () => {
    const request: ConsoleRequest = async () => jsonResponse({}, 500);

    await expect(fetchConsoleBootstrap(BASE, request)).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNAVAILABLE',
    });
  });

  it('响应不是 JSON 时抛 INVALID_BOOTSTRAP_RESPONSE', async () => {
    const request: ConsoleRequest = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(fetchConsoleBootstrap(BASE, request)).rejects.toMatchObject({
      code: 'INVALID_BOOTSTRAP_RESPONSE',
    });
  });

  it('字段缺失或类型不对时不猜默认状态', async () => {
    const invalid: readonly unknown[] = [
      undefined,
      {},
      { status: 'error' },
      { status: 'ok' },
      { status: 'ok', result: 'ok' },
      // needsSetup 不是布尔值：把字符串当真会走错分支。
      {
        status: 'ok',
        result: {
          needsSetup: 'true',
          authEnabled: false,
          boundSubject: 'user:local',
          adminConfigured: false,
          restartRequired: false,
        },
      },
      // 绑定主体为空：初始化页没法给默认用户名。
      {
        status: 'ok',
        result: {
          needsSetup: true,
          authEnabled: false,
          boundSubject: '',
          adminConfigured: false,
          restartRequired: false,
        },
      },
      {
        status: 'ok',
        result: {
          needsSetup: true,
          authEnabled: false,
          boundSubject: 'user:local',
          adminConfigured: false,
        },
      },
      // 令牌开关缺失：初始化页不知道该不该显示令牌输入框。
      {
        status: 'ok',
        result: {
          needsSetup: true,
          authEnabled: false,
          boundSubject: 'user:local',
          adminConfigured: false,
          restartRequired: true,
        },
      },
    ];

    for (const payload of invalid) {
      const request: ConsoleRequest = async () => jsonResponse(payload);
      await expect(fetchConsoleBootstrap(BASE, request)).rejects.toMatchObject({
        code: 'INVALID_BOOTSTRAP_RESPONSE',
      });
    }
  });
});

describe('创建管理员账号（POST /bootstrap/admin）', () => {
  it('提交 userId 与密码，响应带 restartRequired', async () => {
    const calls: { url: string; init: Parameters<ConsoleRequest>[1] }[] = [];
    const request: ConsoleRequest = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(adminPayload());
    };

    const result = await createBootstrapAdmin(BASE, request, {
      userId: 'local',
      displayName: '',
      password: 'correct horse battery',
      setupToken: '',
    });

    expect(result).toEqual({
      userId: 'local',
      created: true,
      passwordSet: true,
      authEnabled: false,
      restartRequired: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/bootstrap/admin`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers?.['content-type']).toBe('application/json');
    // 显示名与令牌为空时整个字段不出现：服务端把 `displayName: ""` 当成一个空
    // 显示名，而空的 `setupToken` 是「这次走回环」的合法写法。
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      userId: 'local',
      password: 'correct horse battery',
    });
  });

  it('显示名非空时一起提交', async () => {
    let body: unknown;
    const request: ConsoleRequest = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(adminPayload());
    };

    await createBootstrapAdmin(BASE, request, {
      userId: 'local',
      displayName: '  本机管理员  ',
      password: 'pw',
      setupToken: '',
    });

    expect(body).toEqual({ userId: 'local', displayName: '本机管理员', password: 'pw' });
  });

  it('带正确令牌时一起提交（容器部署经 nginx 转发时用）', async () => {
    let body: unknown;
    const request: ConsoleRequest = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(adminPayload());
    };

    await createBootstrapAdmin(BASE, request, {
      userId: 'local',
      displayName: '',
      password: 'pw',
      setupToken: '  6f1c0f2a9b  ',
    });

    // 复制日志时带上的首尾空白去掉；令牌为空以外的值都原样提交。
    expect(body).toEqual({ userId: 'local', password: 'pw', setupToken: '6f1c0f2a9b' });
  });

  it('NOT_LOOPBACK 保留错误码，提示去看初始化令牌', async () => {
    const request: ConsoleRequest = async () =>
      jsonResponse(errorPayload('NOT_LOOPBACK', '初始化只能从回环地址发起。'), 403);

    const caught: unknown = await createBootstrapAdmin(BASE, request, {
      userId: 'local',
      displayName: '',
      password: 'pw',
      setupToken: '',
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ConsoleBootstrapError);
    if (!(caught instanceof ConsoleBootstrapError)) {
      throw new Error('期望抛出 ConsoleBootstrapError');
    }
    expect(caught.code).toBe('NOT_LOOPBACK');

    const notice = bootstrapErrorNotice(caught.code, caught.message);
    // 容器部署里请求经 nginx 转发，必然不是回环地址：「只能在服务器本机完成」
    // 会把主推路径说成做不到。
    expect(notice).toContain('初始化令牌');
    expect(notice).not.toContain('只能在');
    // 服务端的内部句子（错误码、接口名）不进界面。
    expect(notice).not.toContain('NOT_LOOPBACK');
  });

  it('INVALID_SETUP_TOKEN 的提示是「从日志重新复制」', () => {
    const notice = bootstrapErrorNotice('INVALID_SETUP_TOKEN', '初始化令牌无效。');

    expect(notice).toContain('初始化令牌不正确');
    expect(notice).toContain('服务端启动日志');
    expect(notice).not.toContain('INVALID_SETUP_TOKEN');
  });

  it('BOOTSTRAP_CLOSED 的提示是「直接登录」', () => {
    expect(bootstrapErrorNotice('BOOTSTRAP_CLOSED', '初始化已完成。')).toBe(
      '初始化已经完成，请直接登录。',
    );
  });

  it('弱口令等其它错误码沿用服务端原句', () => {
    expect(bootstrapErrorNotice('INVALID_ARGUMENT', '密码至少需要 8 个字符。')).toBe(
      '密码至少需要 8 个字符。',
    );
  });

  it('非 2xx 且响应体不是错误封套时用 HTTP 状态码', async () => {
    const request: ConsoleRequest = async () => jsonResponse('not json', 400);

    await expect(
      createBootstrapAdmin(BASE, request, {
        userId: 'local',
        displayName: '',
        password: 'pw',
        setupToken: '',
      }),
    ).rejects.toMatchObject({ code: 'HTTP_400' });
  });

  it('2xx 但缺少账号字段时不假装创建成功', async () => {
    const request: ConsoleRequest = async () => jsonResponse({ status: 'ok' });

    await expect(
      createBootstrapAdmin(BASE, request, {
        userId: 'local',
        displayName: '',
        password: 'pw',
        setupToken: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP_RESPONSE' });
  });
});

describe('初始化表单校验', () => {
  it('三个必填项都为空时逐字段给提示', () => {
    expect(validateSetupForm({ userId: '  ', password: '', confirmPassword: '' })).toEqual({
      userId: '请输入用户名。',
      password: '请输入密码。',
      confirmPassword: '请再次输入密码。',
    });
  });

  it('两次密码不一致时拒绝提交', () => {
    expect(
      validateSetupForm({ userId: 'local', password: 'first', confirmPassword: 'second' }),
    ).toEqual({ confirmPassword: '两次输入的密码不一致。' });
  });

  it('合法输入没有错误', () => {
    expect(
      validateSetupForm({ userId: 'local', password: 'first', confirmPassword: 'first' }),
    ).toEqual({});
  });
});

describe('配置片段', () => {
  it('包含认证开关与系统管理员名单', () => {
    const snippet = setupAdminConfigSnippet('alice');

    expect(snippet).toBe(['auth:', '  enabled: true', '  adminUserIds:', '    - "alice"'].join('\n'));
  });
});
