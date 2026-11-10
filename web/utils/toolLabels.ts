/**
 * MCP 工具的分组 kind → 界面文案与分组顺序（工具页）。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 取值清单来自 `src/api/mcp/registry.ts` 的 `McpToolDefinition.kind`：`GET /mcp/tools`
 * 的 `serializeTool()` 原样输出 `tool.kind`，而注册表里每个工具都声明这三个值之一
 * （`src/api/mcp/tools/*.ts`），所以响应里不会出现清单外的 kind。旧实现的
 * `KIND_LABEL[kind] ?? kind` 兜底不会命中——它只是让「注册表多一类工具、界面没跟」
 * 变成界面上一格英文原值。
 *
 * 控制台不能 import 后端类型，所以这里的 `as const` 数组是 web 侧的取值来源：类型
 * 从数组派生，映射用 `satisfies Record<kind, 文案>` 穷举，顺序也由同一个数组给出
 * （架构文档 §13.2 的「只读 / 写入 / 摄取」）。跨项目一致性由
 * `tests/unit/web/tool-labels.test.ts` 对拍。
 */
export const MCP_TOOL_KINDS = ['read', 'write', 'ingest'] as const

export type McpToolKind = (typeof MCP_TOOL_KINDS)[number]

/** kind → 文案。漏一个 kind 即编译失败，多一个键也是。 */
const KIND_LABEL = {
  read: '只读',
  write: '写入',
  ingest: '摄取',
} satisfies Record<McpToolKind, string>

/**
 * kind → 界面文案。
 *
 * 入参与 `typedQueryIntentLabel` 同源：`composables/useApi.ts` 的 `McpToolPayload`
 * 把 `kind` 声明成 `McpToolKind`，页面拿到的就是收窄后的类型。写宽成 `string` 时
 * 索引只能靠 `as` 断言，而断言会在「注册表多一类工具、界面没跟」时把 `undefined`
 * 渲染成一格空白。
 */
export function mcpToolKindLabel(kind: McpToolKind): string {
  return KIND_LABEL[kind]
}

/**
 * 分组排序用的位次：下标即位置。
 *
 * 清单外的值只可能来自契约被破坏（`indexOf` 返回 -1，排在最前），不会让工具从
 * 列表里消失；不再保留旧实现的「未知排最后」——那个分支在闭集上永远走不到。
 */
export function mcpToolKindRank(kind: McpToolKind): number {
  return MCP_TOOL_KINDS.indexOf(kind)
}
