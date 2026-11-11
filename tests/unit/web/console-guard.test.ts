/**
 * 控制台路由守卫的判定（`web/utils/consoleGuard.ts` ↔ `web/middleware/console-auth.global.ts`）。
 *
 * 三种状态各自有「必须跳」与「必须放行」：还没有账号时除了初始化页与登录页
 * 都跳 `/setup`；有账号但没有会话时跳 `/login` 并带回跳地址；已有身份时登录页
 * 与初始化页都回概览。`pending` / `failed` 由 `app.vue` 自己渲染加载态与整页
 * 错误，守卫不参与，否则「后端不可达」会变成反复重定向。
 *
 * 前两种状态不是两种部署形态：`setup-required` 建完账号就变成 `unauthenticated`，
 * 登录成功就是 `ready`。
 */
import { describe, expect, it } from 'vitest';

import type { ConsoleBootstrap } from '../../../web/composables/consoleBootstrap.js';
import type { ConsoleIdentityState } from '../../../web/composables/consoleIdentity.js';
import {
  CONSOLE_LOGIN_PATH,
  CONSOLE_SETUP_PATH,
  consoleRedirectFor,
} from '../../../web/utils/consoleGuard.js';

const BOOTSTRAP: ConsoleBootstrap = {
  needsSetup: true,
  boundSubject: 'user:local',
  adminConfigured: false,
};

const SETUP_REQUIRED: ConsoleIdentityState = { status: 'setup-required', bootstrap: BOOTSTRAP };
const UNAUTHENTICATED: ConsoleIdentityState = { status: 'unauthenticated' };
const READY: ConsoleIdentityState = {
  status: 'ready',
  identity: { subject: 'user:alice', scopes: ['comem://user/alice'] },
};

describe('还没有账号（needsSetup: true）', () => {
  it('受保护页面重定向到 /setup', () => {
    expect(consoleRedirectFor(SETUP_REQUIRED, '/', '/')).toBe(CONSOLE_SETUP_PATH);
    expect(consoleRedirectFor(SETUP_REQUIRED, '/files', '/files?uri=comem://user/local')).toBe(
      CONSOLE_SETUP_PATH,
    );
    expect(consoleRedirectFor(SETUP_REQUIRED, '/admin', '/admin')).toBe(CONSOLE_SETUP_PATH);
  });

  it('初始化页放行', () => {
    expect(consoleRedirectFor(SETUP_REQUIRED, CONSOLE_SETUP_PATH, CONSOLE_SETUP_PATH)).toBeNull();
  });

  it('登录页放行：底部的「创建管理员账号」入口要靠它可达', () => {
    expect(consoleRedirectFor(SETUP_REQUIRED, CONSOLE_LOGIN_PATH, CONSOLE_LOGIN_PATH)).toBeNull();
  });
});

describe('有账号但没有会话', () => {
  it('受保护页面跳登录页并带回跳地址', () => {
    expect(consoleRedirectFor(UNAUTHENTICATED, '/review', '/review')).toBe(
      `${CONSOLE_LOGIN_PATH}?redirect=${encodeURIComponent('/review')}`,
    );
    expect(
      consoleRedirectFor(UNAUTHENTICATED, '/files/user/local', '/files/user/local?tab=body'),
    ).toBe(`${CONSOLE_LOGIN_PATH}?redirect=${encodeURIComponent('/files/user/local?tab=body')}`);
  });

  it('登录页放行（否则登录页会重定向到自己）', () => {
    expect(consoleRedirectFor(UNAUTHENTICATED, CONSOLE_LOGIN_PATH, CONSOLE_LOGIN_PATH)).toBeNull();
  });

  it('初始化页跳登录页，且不把 /setup 当回跳地址', () => {
    expect(consoleRedirectFor(UNAUTHENTICATED, CONSOLE_SETUP_PATH, CONSOLE_SETUP_PATH)).toBe(
      CONSOLE_LOGIN_PATH,
    );
  });
});

describe('已有身份', () => {
  it('登录页与初始化页都回概览', () => {
    expect(consoleRedirectFor(READY, CONSOLE_LOGIN_PATH, CONSOLE_LOGIN_PATH)).toBe('/');
    expect(consoleRedirectFor(READY, CONSOLE_SETUP_PATH, CONSOLE_SETUP_PATH)).toBe('/');
  });

  it('业务页面放行', () => {
    expect(consoleRedirectFor(READY, '/', '/')).toBeNull();
    expect(consoleRedirectFor(READY, '/monitor', '/monitor')).toBeNull();
  });
});

describe('身份未确定', () => {
  it('pending / failed 不跳转，由 app.vue 渲染加载态与整页错误', () => {
    expect(consoleRedirectFor({ status: 'pending' }, '/', '/')).toBeNull();
    expect(consoleRedirectFor({ status: 'failed', message: '服务端没有响应。' }, '/', '/')).toBeNull();
  });
});
