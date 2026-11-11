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
    expect(navLabelOf('/unknown')).toBe('控制台');
  });
});
