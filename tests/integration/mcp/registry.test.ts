import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_NAMES,
  ToolRegistry,
  type McpToolDefinition,
  type McpToolName,
} from '../../../src/api/mcp/registry.js';
import { MCP_TOOLS } from '../../../src/api/mcp/tools/index.js';
import { ComemError } from '../../../src/domain/errors.js';

/** §13.2 的 16 个工具，硬编码——不从实现里推导，否则测试跟着实现一起漂移。 */
const EXPECTED_NAMES = [
  'find',
  'search',
  'rule_search',
  'read',
  'list',
  'tree',
  'grep',
  'glob',
  'download',
  'health',
  'write',
  'edit',
  'remember',
  'forget',
  'add_resource',
  'add_skill',
];

function expectInternal(action: () => void): void {
  try {
    action();
    expect.unreachable('应当抛出 INTERNAL');
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    if (error instanceof ComemError) {
      expect(error.code).toBe('INTERNAL');
    }
  }
}

function firstTool(): McpToolDefinition {
  const tool = MCP_TOOLS[0];
  if (tool === undefined) {
    throw new Error('工具表为空，测试前提不成立。');
  }
  return tool;
}

describe('MCP 工具注册表', () => {
  it('16 个工具的名字与 §13.2 完全一致', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);
    expect([...MCP_TOOL_NAMES]).toEqual(EXPECTED_NAMES);
  });

  it('createToolRegistry 自检通过', () => {
    const registry = new ToolRegistry(MCP_TOOLS);
    expect(() => registry.validate()).not.toThrow();
    expect(registry.list()).toHaveLength(16);
  });

  it('少一个时 validate 抛 INTERNAL', () => {
    const registry = new ToolRegistry(MCP_TOOLS.slice(1));
    expectInternal(() => registry.validate());
  });

  it('重名时 validate 抛 INTERNAL', () => {
    const registry = new ToolRegistry([...MCP_TOOLS.slice(0, 15), firstTool()]);
    expectInternal(() => registry.validate());
  });

  it('名字不在白名单时 validate 抛 INTERNAL', () => {
    const rogue: McpToolDefinition = {
      ...firstTool(),
      name: 'get_acl' as unknown as McpToolName,
    };
    const registry = new ToolRegistry([...MCP_TOOLS.slice(0, 15), rogue]);
    expectInternal(() => registry.validate());
  });

  it('每个工具的 inputSchema 是合法 JSON Schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(typeof tool.inputSchema['properties']).toBe('object');
      expect(tool.inputSchema['properties']).not.toBeNull();
    }
  });

  it('每个 description 至少 40 个字符且包含使用场景词', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length, `${tool.name} 的描述太短`).toBeGreaterThanOrEqual(40);
      expect(tool.description, `${tool.name} 的描述没有说明什么时候用`).toMatch(/用|时/);
    }
  });
});
