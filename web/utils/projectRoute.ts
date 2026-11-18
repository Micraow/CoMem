import { fileRouteOf } from './fileRoute'

/**
 * 已绑定项目的会话 → 个人根下的项目目录路由。
 *
 * `projectId` 已经由服务端按单路径段规则规范化。这里把原始值交给 `fileRouteOf`，
 * 由它统一编码一次；先编码再调用会把 `%` 再编码成 `%25`。
 */
export function projectRouteOf(
  projectId: string | undefined,
  scopeRoot: string,
): string | null {
  if (projectId === undefined || projectId === '') {
    return null
  }
  return fileRouteOf(`${scopeRoot.replace(/\/+$/u, '')}/projects/${projectId}`)
}
