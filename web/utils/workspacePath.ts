const URI_PREFIX = 'comem://'

export interface WorkspaceCrumb {
  readonly uri: string
  readonly label: string
}

function decodedLabel(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function workspaceParentUriOf(uri: string): string | null {
  const trimmed = uri.replace(/\/+$/u, '')
  if (!trimmed.startsWith(URI_PREFIX)) {
    return null
  }
  const segments = trimmed.slice(URI_PREFIX.length).split('/').filter(Boolean)
  if (segments.length <= 2) {
    return null
  }
  const separator = trimmed.lastIndexOf('/')
  return trimmed.slice(0, separator)
}

export function workspaceNameOf(uri: string): string {
  const trimmed = uri.replace(/\/+$/u, '')
  const separator = trimmed.lastIndexOf('/')
  return decodedLabel(separator < 0 ? trimmed : trimmed.slice(separator + 1))
}

export function workspaceChildUri(parent: string, name: string): string | null {
  const segment = name.trim()
  if (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
    return null
  }
  return `${parent.replace(/\/+$/u, '')}/${segment}`
}

export function workspaceBreadcrumbs(
  scopeRoot: string,
  currentUri: string,
  scopeLabel: string,
): readonly WorkspaceCrumb[] {
  const root = scopeRoot.replace(/\/+$/u, '')
  const current = currentUri.replace(/\/+$/u, '')
  const crumbs: WorkspaceCrumb[] = [{ uri: root, label: scopeLabel }]
  if (current === root || !current.startsWith(`${root}/`)) {
    return crumbs
  }

  let parent = root
  for (const segment of current.slice(root.length + 1).split('/')) {
    parent = `${parent}/${segment}`
    crumbs.push({ uri: parent, label: decodedLabel(segment) })
  }
  return crumbs
}

/** 当前地址命中的最具体直接共享根；用于在不改全局空间时定位面包屑边界。 */
export function workspaceContainingRootOf(
  uri: string,
  roots: readonly string[],
): string | null {
  const current = uri.replace(/\/+$/u, '')
  let match: string | null = null
  for (const candidate of roots) {
    const root = candidate.replace(/\/+$/u, '')
    if (
      (current === root || current.startsWith(`${root}/`)) &&
      (match === null || root.length > match.length)
    ) {
      match = root
    }
  }
  return match
}

export function workspaceCopyNameOf(name: string, isDirectory: boolean): string {
  if (isDirectory) {
    return `${name} 副本`
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return `${name} 副本`
  }
  return `${name.slice(0, dot)} 副本${name.slice(dot)}`
}
