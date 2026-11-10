/**
 * 关联边的展示映射（文件详情页的「关联」区块）。
 *
 * 纯函数：从 `GET /memories/{uri}/links` 的响应行取出「另一端」与用户可读的关系
 * 文案。放在 `utils/` 是为了能单测；组件里只留状态与渲染。
 *
 * 入参只声明用到的字段（`from` / `to` / `linkType` / `description`），不导入
 * `useApi.ts` 的线上类型：这个文件要能被 vitest 直接加载，而 `useApi.ts` 依赖
 * Nuxt 的自动导入，脱离 Nuxt 环境解析不了。
 */

const URI_PREFIX = 'comem://'

/**
 * 只有 `memories/` 下的节点有关联边。
 *
 * 判据是 URI 的第三段（`user/{uid}/memories/...`、`group/{gid}/memories/...`）：
 * `memories` 是记忆目录的固定段（`src/services/memory.ts` 的 `MEMORIES_DIRECTORY`），
 * 比「先请求再看错误码」稳——后者会把「没有边」与「不是记忆」混成同一个空结果，
 * 还会给每个普通文件多打两次请求。`memories` 目录本身（只有三段）不算记忆节点。
 */
export function isMemoryUri(uri: string): boolean {
  const parts = (uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri).split('/')
  return parts.length >= 4 && parts[2] === 'memories'
}

export type LinkDirection = 'links' | 'backlinks'

/** 一条关联边里界面要用的字段（`GET /memories/{uri}/links` 的子集）。 */
export interface LinkEdge {
  readonly from: string
  readonly to: string
  readonly linkType: string
  readonly description: string
}

/** 一条要渲染的关联：另一端 URI、关系文案、可选说明。 */
export interface LinkRow {
  readonly uri: string
  readonly label: string
  readonly description: string
}

/**
 * `link_type` 的展示文案。
 *
 * 已知类型按方向翻译：`derived_from` 表示起点由终点派生，所以从这条记忆看出去是
 * 「派生自」，反查回来是「派生出」。未知类型显示原值而不是留空——新增关系类型时
 * 界面不会静默吞掉一条边。
 */
const LINK_TYPE_LABEL: Readonly<
  Record<string, { readonly forward: string; readonly backlink: string }>
> = {
  derived_from: { forward: '派生自', backlink: '派生出' },
  references: { forward: '引用了', backlink: '被引用' },
  related: { forward: '相关', backlink: '相关' },
}

export function linkRowsOf(
  links: readonly LinkEdge[],
  direction: LinkDirection,
): readonly LinkRow[] {
  return links.map((link) => {
    const labels = LINK_TYPE_LABEL[link.linkType]
    return {
      // 显示「另一端」：正向边看 `to`，反向边看 `from`。
      uri: direction === 'links' ? link.to : link.from,
      label:
        labels === undefined
          ? link.linkType
          : direction === 'links'
            ? labels.forward
            : labels.backlink,
      description: link.description,
    }
  })
}
