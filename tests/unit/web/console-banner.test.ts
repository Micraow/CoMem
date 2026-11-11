/**
 * 单用户模式横幅（`web/utils/consoleBanner.ts`）。
 *
 * 横幅必须回答三个问题：现在有没有认证、别人会不会也是他、要怎么做。断言里
 * 钉住这三句，同时钉住「字段名不进界面」——`auth.enabled` / `adminUserIds`
 * 是配置项，用户看到的是「多用户登录」「系统管理员」（AGENTS §11）。
 */
import { describe, expect, it } from 'vitest';

import type { ConsoleIdentity } from '../../../web/composables/consoleIdentity.js';
import { singleUserModeNotice } from '../../../web/utils/consoleBanner.js';

function identityOf(overrides: Partial<ConsoleIdentity> = {}): ConsoleIdentity {
  return {
    subject: 'user:local',
    scopes: ['comem://user/local'],
    authEnabled: false,
    ...overrides,
  };
}

describe('单用户模式横幅', () => {
  it('authEnabled: false 时出现，并回答三个问题', () => {
    const notice = singleUserModeNotice(identityOf());

    expect(notice).not.toBeNull();
    // 1. 现在有没有认证
    expect(notice).toContain('没有登录');
    // 2. 其他人会不会是同一个用户
    expect(notice).toContain('同一个用户 local');
    // 3. 要怎么做
    expect(notice).toContain('启用多用户登录');
    expect(notice).toContain('配置');
  });

  it('authEnabled: true 时消失', () => {
    expect(singleUserModeNotice(identityOf({ authEnabled: true }))).toBeNull();
  });

  it('没有身份（登录页 / 初始化页）时不显示', () => {
    expect(singleUserModeNotice(null)).toBeNull();
  });

  it('authEnabled 缺省等同于单用户模式（/health 解出的身份不带这个字段）', () => {
    const identity = identityOf();
    expect(singleUserModeNotice({ subject: identity.subject, scopes: identity.scopes })).not.toBeNull();
  });

  it('主体不是 user: 前缀时原样显示用户 ID', () => {
    expect(singleUserModeNotice(identityOf({ subject: 'local' }))).toContain('同一个用户 local');
  });

  it('界面文案里不出现配置字段名', () => {
    const notice = singleUserModeNotice(identityOf()) ?? '';

    expect(notice).not.toContain('auth.enabled');
    expect(notice).not.toContain('adminUserIds');
    expect(notice).not.toContain('server.subject');
    expect(notice).not.toContain('user:local');
  });
});
