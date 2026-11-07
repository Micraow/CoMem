/**
 * 目录树的状态与展开逻辑（文件树页）。
 *
 * `GET /fs/tree` 返回的是**深度优先的扁平条目**（不含根自身），不带 `depth`。
 * 界面需要的是「缩进 + 展开/收起」，所以在客户端补两条派生信息：
 *
 * - `depth`：用 URI 前缀栈推出来，不依赖服务端字段；
 * - 可见性：节点的所有祖先目录都展开才可见。过滤时把命中节点的祖先一并保留，
 *   否则搜到的文件会因为父目录没展开而消失。
 *
 * 数据放在 `useState` 里跨页共享：从文件树切到概览再切回来不重取。
 */

import type { ComputedRef, Ref } from 'vue'

import {
  errorMessageOf,
  useApi,
  useScopeRoot,
  type TreeEntryPayload,
  type TreePayload,
} from './useApi'

/** 架构文档 §13.2 的 `tree` 工具契约：`levelLimit=3`。 */
const DEFAULT_TREE_DEPTH = 3

/** 与服务端 `tree` 的上限一致；超过就截断。 */
const DEFAULT_TREE_LIMIT = 1000

export interface TreeNode extends TreeEntryPayload {
  /** 相对根的层级，0 是根的直接子项。 */
  readonly depth: number
}

export interface TreeState {
  readonly root: string
  readonly nodes: readonly TreeNode[]
  readonly truncated: boolean
}

export interface UseTree {
  readonly state: Ref<TreeState | null>
  readonly loading: Ref<boolean>
  readonly error: Ref<string | null>
  readonly filter: Ref<string>
  readonly rows: ComputedRef<readonly TreeNode[]>
  load(uri?: string): Promise<void>
  refresh(): Promise<void>
  toggle(uri: string): void
  expandAncestors(uri: string): void
  isExpanded(uri: string): boolean
  ancestorsOf(uri: string): readonly string[]
}

/** 把 DFS 顺序的扁平条目补上层级。 */
function withDepth(entries: readonly TreeEntryPayload[]): readonly TreeNode[] {
  const stack: string[] = []
  return entries.map((entry) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top !== undefined && entry.uri.startsWith(`${top}/`)) {
        break
      }
      stack.pop()
    }
    const depth = stack.length
    stack.push(entry.uri)
    return { ...entry, depth }
  })
}

export function useTree(): UseTree {
  const api = useApi()
  const scopeRoot = useScopeRoot()

  const state = useState<TreeState | null>('comem-tree-state', () => null)
  const loading = useState<boolean>('comem-tree-loading', () => false)
  const error = useState<string | null>('comem-tree-error', () => null)
  const expanded = useState<string[]>('comem-tree-expanded', () => [])
  const filter = useState<string>('comem-tree-filter', () => '')

  /** 祖先目录的 URI，从根的直接子项到父目录。 */
  function ancestorsOf(uri: string): readonly string[] {
    const root = state.value?.root ?? scopeRoot.value
    if (!uri.startsWith(`${root}/`)) {
      return []
    }

    const parts = uri.slice(root.length + 1).split('/')
    const ancestors: string[] = []
    let current = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]
      if (part === undefined) {
        break
      }
      current = `${current}/${part}`
      ancestors.push(current)
    }
    return ancestors
  }

  const rows = computed<readonly TreeNode[]>(() => {
    const nodes = state.value?.nodes ?? []
    if (nodes.length === 0) {
      return []
    }

    const needle = filter.value.trim().toLowerCase()
    if (needle === '') {
      const open = new Set(expanded.value)
      return nodes.filter((node) => ancestorsOf(node.uri).every((ancestor) => open.has(ancestor)))
    }

    const visible = new Set<string>()
    for (const node of nodes) {
      if (node.name.toLowerCase().includes(needle) || node.uri.toLowerCase().includes(needle)) {
        visible.add(node.uri)
        for (const ancestor of ancestorsOf(node.uri)) {
          visible.add(ancestor)
        }
      }
    }
    return nodes.filter((node) => visible.has(node.uri))
  })

  async function load(uri: string = scopeRoot.value): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const payload = await api.get<TreePayload>('/fs/tree', {
        uri,
        depth: DEFAULT_TREE_DEPTH,
        limit: DEFAULT_TREE_LIMIT,
      })
      const nodes = withDepth(payload.entries)
      state.value = { root: payload.root, nodes, truncated: payload.truncated }
      // 默认展开第一层目录：既能看出结构，又不会一上来铺满上千行。
      expanded.value = nodes
        .filter((node) => node.kind === 'directory' && node.depth === 0)
        .map((node) => node.uri)
    } catch (caught) {
      error.value = errorMessageOf(caught)
      state.value = null
      expanded.value = []
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    await load(state.value?.root ?? scopeRoot.value)
  }

  function toggle(uri: string): void {
    expanded.value = expanded.value.includes(uri)
      ? expanded.value.filter((item) => item !== uri)
      : [...expanded.value, uri]
  }

  /** 把某个节点的祖先目录全部展开，用于「从 URL 直接进入深层文件」。 */
  function expandAncestors(uri: string): void {
    const ancestors = ancestorsOf(uri)
    if (ancestors.length === 0) {
      return
    }
    expanded.value = [...new Set([...expanded.value, ...ancestors])]
  }

  function isExpanded(uri: string): boolean {
    return expanded.value.includes(uri)
  }

  return {
    state,
    loading,
    error,
    filter,
    rows,
    load,
    refresh,
    toggle,
    expandAncestors,
    isExpanded,
    ancestorsOf,
  }
}

const SIZE_UNITS: readonly string[] = ['KB', 'MB', 'GB']

/** 文件大小。不足 1 KB 显示字节，其余保留一位小数。 */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }

  let value = size / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${SIZE_UNITS[unitIndex] ?? 'KB'}`
}
