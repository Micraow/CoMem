/**
 * 16 个 MCP 工具的装配点（架构文档 §13.2）。
 *
 * 数组顺序与 `MCP_TOOL_NAMES` 一致，方便 `tools/list` 的输出与文档逐行对照。
 * `createToolRegistry` 在构造后立刻自检：数量、重名、白名单，任一不满足启动就崩
 * （AGENTS.md「16 个，不多不少」）。
 */

import { ToolRegistry, type McpToolDefinition } from '../registry.js';

import { addResourceTool } from './add-resource.js';
import { addSkillTool } from './add-skill.js';
import { downloadTool } from './download.js';
import { editTool } from './edit.js';
import { findTool } from './find.js';
import { forgetTool } from './forget.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { healthTool } from './health.js';
import { listTool } from './list.js';
import { readTool } from './read.js';
import { rememberTool } from './remember.js';
import { ruleSearchTool } from './rule-search.js';
import { searchTool } from './search.js';
import { treeTool } from './tree.js';
import { writeTool } from './write.js';

/** §13.2 的 16 个工具，顺序与表格一致。 */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  findTool,
  searchTool,
  ruleSearchTool,
  readTool,
  listTool,
  treeTool,
  grepTool,
  globTool,
  downloadTool,
  healthTool,
  writeTool,
  editTool,
  rememberTool,
  forgetTool,
  addResourceTool,
  addSkillTool,
]);

/** 构造并自检。启动路径只应该用这个，不要直接 `new ToolRegistry`。 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry(MCP_TOOLS);
  registry.validate();
  return registry;
}
