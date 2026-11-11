/**
 * 主导航入口清单（架构文档 §16 的十个业务页）。
 *
 * 图标用名字而不是组件：这份清单要能被 `tests/unit/web/nav.test.ts` 直接 import，
 * 测试运行器不需要加载 Vue 组件。图标到组件的映射在 `SideNav.vue` 里。
 *
 * 入口清单只在这里定义一份：标题栏面包屑（`AppShell.vue`）与侧栏共用同一份标签，
 * 两处各写一份迟早会出现「侧栏叫记忆复核、标题叫待复核」的漂移。
 */

/** 侧栏图标名。新增入口时在 `SideNav.vue` 的映射里补一个组件。 */
export type NavIconName =
  | 'plug'
  | 'dashboard'
  | 'tree'
  | 'search'
  | 'review'
  | 'tools'
  | 'shield'
  | 'users'
  | 'prompt'
  | 'sessions'
  | 'monitor'

export interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: NavIconName
}

export interface NavGroup {
  readonly label: string
  readonly items: readonly NavItem[]
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '控制台',
    items: [
      { to: '/connect', label: '接入 Agent', icon: 'plug' },
      { to: '/', label: '概览', icon: 'dashboard' },
      { to: '/files', label: '文件树', icon: 'tree' },
      { to: '/search', label: '检索调试', icon: 'search' },
      { to: '/review', label: '记忆复核', icon: 'review' },
      { to: '/tools', label: '工具', icon: 'tools' },
    ],
  },
  {
    label: '治理',
    items: [
      { to: '/acl', label: '权限管理', icon: 'shield' },
      { to: '/admin', label: '用户与组', icon: 'users' },
      { to: '/prompts', label: '提示词', icon: 'prompt' },
    ],
  },
  {
    label: '运维',
    items: [
      { to: '/sessions', label: '会话与任务', icon: 'sessions' },
      { to: '/monitor', label: '监控', icon: 'monitor' },
    ],
  },
]

/** 路径是否命中入口。根路径只做精确匹配，否则任何页面都会点亮「概览」。 */
export function isActivePath(to: string, path: string): boolean {
  if (to === '/') {
    return path === '/'
  }
  return path === to || path.startsWith(`${to}/`)
}

/** 当前路径对应的入口标签，用于标题栏面包屑。 */
export function navLabelOf(path: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isActivePath(item.to, path)) {
        return item.label
      }
    }
  }
  return '控制台'
}
