/**
 * MCP 工具分组文案与领域清单的对拍（`web/utils/toolLabels.ts` ↔ `src/api/mcp/registry.ts`）。
 *
 * `McpToolDefinition.kind` 在领域层是内联的字面量联合（`read` / `write` / `ingest`），
 * 没有导出运行期清单，所以这里两个方向分开钉：
 *
 * - 硬编码清单：`['read', 'write', 'ingest']`（架构文档 §13.2 的三组）；
 * - 真实注册表：`MCP_TOOLS` 里每个工具的 `kind` 都必须在清单里，清单里每个值也都
 *   得真有工具在用（`GET /mcp/tools` 序列化的是同一份 `tool.kind`）；
 * - 编译期：`Record<McpToolDefinition['kind'], McpToolKind>` 在领域层多一个 kind 时
 *   缺键，`pnpm typecheck` 失败。
 */
import { describe, expect, it } from 'vitest'

import type { McpToolDefinition } from '../../../src/api/mcp/registry.js'
import { MCP_TOOLS } from '../../../src/api/mcp/tools/index.js'
import {
  MCP_TOOL_KINDS,
  mcpToolKindLabel,
  mcpToolKindRank,
  type McpToolKind,
} from '../../../web/utils/toolLabels.js'

describe('MCP 工具分组文案', () => {
  it('kind 清单是文档里的三个', () => {
    expect([...MCP_TOOL_KINDS]).toEqual(['read', 'write', 'ingest'])
  })

  it('注册表里每个工具的 kind 都在清单里，三个值都有工具在用', () => {
    const kinds = new Set<string>(MCP_TOOLS.map((tool) => tool.kind))
    for (const kind of kinds) {
      expect(MCP_TOOL_KINDS).toContain(kind)
    }
    for (const kind of MCP_TOOL_KINDS) {
      expect(kinds).toContain(kind)
    }
  })

  it('领域层加一类工具时清单必须跟上（编译期）', () => {
    const coverage: Record<McpToolDefinition['kind'], McpToolKind> = {
      read: 'read',
      write: 'write',
      ingest: 'ingest',
    }
    // 运行期把编译期的覆盖面再对一次：多写一个领域层不存在的 kind 也会在这里失败。
    expect(Object.keys(coverage).sort()).toEqual([...MCP_TOOL_KINDS].sort())
  })

  it('分组文案与顺序', () => {
    expect(MCP_TOOL_KINDS.map(mcpToolKindLabel)).toEqual(['只读', '写入', '摄取'])
    expect(MCP_TOOL_KINDS.map(mcpToolKindRank)).toEqual([0, 1, 2])
  })
})
