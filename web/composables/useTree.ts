/**
 * 目录树的状态与展开逻辑（文件树页）。
 *
 * **按需加载，一次一层。** `GET /fs/tree?depth=3` 会把根以下三层一次性拉回来，
 * 而归档目录在第四层（`sessions/{id}/history/archive_001`）——要么看不见，要么把
 * 深度调到 4 之后每次进页面都拉整棵树（根下有几十个会话，`W51b` 实测）。这里改成
 * 「展开一个目录才拉它的直接子项」（`GET /fs/ls`）：首屏只有根的第一层，代价与库
 * 大小无关。
 *
 * 副作用是**筛选只能命中已经加载过的路径**。这与「展开」是同一件事的两面——没拉
 * 下来的层级本来就不在界面上。空状态文案因此写「已展开的路径里没有匹配项」，而不是
 * 「没有匹配的路径」。
 *
 * 数据放在 `useState` 里跨页共享：从文件树切到概览再切回来不重取。
 *
 * ## 为什么存 `children` 映射而不是扁平数组
 *
 * 深度是 URI 的函数（`uri` 相对根有几段），不需要服务端给；而「谁在谁下面」必须
 * 由父目录那次请求决定。存「父 URI → 直接子项」之后，扁平列表与缩进都在渲染时
 * 用 DFS 推出来，合并一层新数据不会打乱顺序，也不需要重新排序（服务端已按 name
 * 升序返回）。
 */

import type { ComputedRef, Ref } from 'vue'

import {
  errorMessageOf,
  useApi,
  useScopeRoot,
  type FsListPayload,
  type TreeEntryPayload,
} from './useApi'

export interface TreeNode extends TreeEntryPayload {
  /** 相对根的层级，0 是根的直接子项。 */
  readonly depth: number
}

export interface TreeState {
  readonly root: string
  /** 父目录 URI → 直接子项。只含已经拉过的目录。 */
  readonly children: Readonly<Record<string, readonly TreeEntryPayload[]>>
}

export interface UseTree {
  readonly state: Ref<TreeState | null>
  readonly loading: Ref<boolean>
  readonly error: Ref<string | null>
  readonly filter: Ref<string>
  readonly rows: ComputedRef<readonly TreeNode[]>
  load(uri?: string): Promise<void>
  refresh(): Promise<void>
  toggle(uri: string): Promise<void>
  expandAncestors(uri: string): Promise<void>
  isExpanded(uri: string): boolean
  /** 正在拉这个目录的直接子项。界面用它把展开箭头置灰。 */
  isPending(uri: string): boolean
  ancestorsOf(uri: string): readonly string[]
}

export function useTree(): UseTree {
  const api = useApi()
  const scopeRoot = useScopeRoot()

  const state = useState<TreeState | null>('comem-tree-state', () => null)
  const loading = useState<boolean>('comem-tree-loading', () => false)
  const error = useState<string | null>('comem-tree-error', () => null)
  const expanded = useState<string[]>('comem-tree-expanded', () => [])
  const filter = useState<string>('comem-tree-filter', () => '')
  /** 正在拉的目录 URI 列表。 */
  const pending = useState<string[]>('comem-tree-pending', () => [])

  function rootOf(): string {
    return state.value?.root ?? scopeRoot.value
  }

  /** 祖先目录的 URI，从根的直接子项到父目录。 */
  function ancestorsOf(uri: string): readonly string[] {
    const root = rootOf()
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

  /**
   * 按 DFS 展开成扁平列表。
   *
   * `open` 为 `null` 时展开全部已加载层级——筛选要用「所有拉过的节点」判断，
   * 而不是「当前展开的节点」：搜到的文件因为父目录没展开而消失，等于搜不到。
   */
  function flatten(open: ReadonlySet<string> | null): readonly TreeNode[] {
    const snapshot = state.value
    if (snapshot === null) {
      return []
    }

    const rows: TreeNode[] = []
    const walk = (parent: string, depth: number): void => {
      for (const child of snapshot.children[parent] ?? []) {
        rows.push({ ...child, depth })
        if (child.kind !== 'directory') {
          continue
        }
        if (open !== null && !open.has(child.uri)) {
          continue
        }
        walk(child.uri, depth + 1)
      }
    }
    walk(snapshot.root, 0)
    return rows
  }

  const rows = computed<readonly TreeNode[]>(() => {
    if (state.value === null) {
      return []
    }

    const needle = filter.value.trim().toLowerCase()
    if (needle === '') {
      return flatten(new Set(expanded.value))
    }

    const visible = new Set<string>()
    for (const node of flatten(null)) {
      if (node.name.toLowerCase().includes(needle) || node.uri.toLowerCase().includes(needle)) {
        visible.add(node.uri)
        for (const ancestor of ancestorsOf(node.uri)) {
          visible.add(ancestor)
        }
      }
    }
    return flatten(null).filter((node) => visible.has(node.uri))
  })

  /** 拉一个目录的直接子项并写进 `children`。失败时记录消息，不抛。 */
  async function loadChildren(directory: string): Promise<boolean> {
    if (pending.value.includes(directory)) {
      return false
    }
    pending.value = [...pending.value, directory]
    try {
      const payload = await api.get<FsListPayload>('/fs/ls', { uri: directory })
      const snapshot = state.value
      if (snapshot === null) {
        return false
      }
      state.value = {
        ...snapshot,
        children: { ...snapshot.children, [directory]: payload.entries },
      }
      return true
    } catch (caught) {
      error.value = errorMessageOf(caught)
      return false
    } finally {
      pending.value = pending.value.filter((item) => item !== directory)
    }
  }

  async function load(uri: string = scopeRoot.value): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const payload = await api.get<FsListPayload>('/fs/ls', { uri })
      state.value = {
        // 服务端回的是解析后的 URI（可能补了末尾斜杠），以它为准；没回时用入参。
        root: payload.uri === '' ? uri : payload.uri,
        children: { [payload.uri === '' ? uri : payload.uri]: payload.entries },
      }
      // 不自动展开：展开要再发一次请求，而根下可能是几十个会话（`W51b`）。
      expanded.value = []
    } catch (caught) {
      error.value = errorMessageOf(caught)
      state.value = null
      expanded.value = []
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    await load(rootOf())
  }

  async function toggle(uri: string): Promise<void> {
    if (expanded.value.includes(uri)) {
      expanded.value = expanded.value.filter((item) => item !== uri)
      return
    }

    if (state.value?.children[uri] === undefined) {
      const loaded = await loadChildren(uri)
      if (!loaded) {
        return
      }
    }
    expanded.value = [...expanded.value, uri]
  }

  /** 把某个节点的祖先目录全部展开（并拉下来），用于「从 URL 直接进入深层文件」。 */
  async function expandAncestors(uri: string): Promise<void> {
    const ancestors = ancestorsOf(uri)
    if (ancestors.length === 0) {
      return
    }
    for (const ancestor of ancestors) {
      if (state.value === null) {
        return
      }
      if (state.value.children[ancestor] === undefined) {
        await loadChildren(ancestor)
      }
    }
    expanded.value = [...new Set([...expanded.value, ...ancestors])]
  }

  function isExpanded(uri: string): boolean {
    return expanded.value.includes(uri)
  }

  function isPending(uri: string): boolean {
    return pending.value.includes(uri)
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
    isPending,
    ancestorsOf,
  }
}
