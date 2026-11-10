/**
 * MCP 工具清单（架构文档 §13.2、§16）。
 *
 * 只读，不执行任何工具：控制台的「工具」页要展示 16 个工具的名字与说明，说明的
 * 真相在 `api/mcp/registry.ts`（模型看到的就是那份文本）。**展示不是新增工具**——
 * 这里是同一份注册表的一个只读视图，工具总数仍然是 16（`ToolRegistry.validate()`
 * 是唯一的执行点）。
 *
 * 为什么要有这个端点：控制台如果硬编码 16 个名字与说明，改一个工具的描述就会有
 * 两份文本，而「界面上写的」与「模型读到的」不一致时，排查的人会先怀疑模型。
 *
 * 不认证：与 `/health`、`/telemetry` 同一类进程级元数据，不含任何用户内容。工具
 * 说明本身是给模型看的公开文本。
 */

import type { FastifyInstance } from 'fastify';

import type { McpToolDefinition, ToolRegistry } from '../../mcp/registry.js';
import { ok } from '../envelope.js';
import type { HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export interface SerializedTool {
  readonly name: string;
  /**
   * `McpToolDefinition['kind']`（`read` / `write` / `ingest`），不是 `string`：
   * 展示值就是注册表里的值，界面按它分组（`web/utils/toolLabels.ts`）。
   * 写宽成 `string` 时，注册表多一类工具、控制台没跟上这件事在编译期不可见。
   */
  readonly kind: McpToolDefinition['kind'];
  readonly description: string;
  /** JSON Schema。界面只取 `properties` 的键名，不渲染完整 schema。 */
  readonly inputSchema: Record<string, unknown>;
}

function serializeTool(tool: ReturnType<ToolRegistry['list']>[number]): SerializedTool {
  return {
    name: tool.name,
    kind: tool.kind,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export function createMcpRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { registry } = services;

  return {
    prefix: '/mcp',
    register(app: FastifyInstance): void {
      app.get('/tools', async () => ok({ tools: registry.list().map(serializeTool) }));
    },
  };
}
