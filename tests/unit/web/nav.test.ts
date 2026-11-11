/**
 * 主导航清单（`web/utils/nav.ts`）。
 *
 * 侧栏与标题栏面包屑共用这份清单。接入入口必须排在「概览」之前：新装用户打开
 * 控制台时，第一眼看到的应该是「怎么把 Agent 接上来」，而不是四张全 0 的卡片。
 */
import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, isActivePath, navLabelOf } from '../../../web/utils/nav.js';

describe('主导航', () => {
  it('「接入 Agent」在控制台分组的第一位，「概览」紧随其后', () => {
    const consoleGroup = NAV_GROUPS.find((group) => group.label === '控制台');
    expect(consoleGroup).toBeDefined();

    const items = consoleGroup?.items ?? [];
    expect(items[0]).toMatchObject({ to: '/connect', label: '接入 Agent' });
    expect(items[1]).toMatchObject({ to: '/', label: '概览' });
    expect(items.findIndex((item) => item.to === '/connect')).toBeLessThan(
      items.findIndex((item) => item.to === '/'),
    );
  });

  it('路径命中：根路径精确匹配，子路径按前缀', () => {
    expect(isActivePath('/connect', '/connect')).toBe(true);
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/', '/files')).toBe(false);
    expect(isActivePath('/files', '/files/readme.md')).toBe(true);
  });

  it('面包屑取当前路径的入口标签', () => {
    expect(navLabelOf('/connect')).toBe('接入 Agent');
    expect(navLabelOf('/')).toBe('概览');
    expect(navLabelOf('/settings')).toBe('设置');
    expect(navLabelOf('/unknown')).toBe('控制台');
  });

  it('「设置」是最后一组，入口只有一个且指向 /settings', () => {
    const last = NAV_GROUPS[NAV_GROUPS.length - 1];
    expect(last).toBeDefined();
    expect(last?.label).toBe('设置');
    expect(last?.items).toEqual([{ to: '/settings', label: '设置', icon: 'settings' }]);

    // 侧栏按这份清单渲染；页面里硬编码入口会让「改一处、漏一处」再次出现。
    expect(isActivePath('/settings', '/settings')).toBe(true);
    expect(isActivePath('/settings', '/settings/providers')).toBe(true);
    expect(isActivePath('/settings', '/sessions')).toBe(false);
  });
});
