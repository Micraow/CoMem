/**
 * `tree`：带层级的目录树（架构文档 §13.2）。
 *
 * 缩进表示层级，目录带 `/` 后缀。`levelLimit` 是**相对 uri 的层数**，不是绝对深度：
 * 传 `comem://user/alice/projects/comem` 时第 1 层就是它的直接子项。
 */

import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  nonNegativeInteger,
  optionalBoolean,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §13.2 的默认值：3 层。 */
const DEFAULT_LEVEL_LIMIT = 3;

/** 节点上限。与 `FileSystemService.tree` 的默认值一致。 */
const TREE_LIMIT = 1000;

/** 每层两个空格。 */
const INDENT = '  ';

export const treeTool: McpToolDefinition = {
  name: 'tree',
  kind: 'read',
  description:
    '想看清一个目录的层级结构时用这个，比 list 多次调用便宜；只要一层用 list 更快。levelLimit 是相对传入 uri 的层数，默认 3，调大前先确认目录不会大到返回上千行。includeAbstract=true 会在目录行后附 L0 摘要，用于决定读哪一个分支。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '目录 URI' },
      levelLimit: { type: 'integer', minimum: 0, default: DEFAULT_LEVEL_LIMIT },
      includeAbstract: { type: 'boolean', default: false },
    },
    required: ['uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'tree');
    const uri = Uri.parse(requiredString(args, 'uri', 'tree'));
    const levelLimit = nonNegativeInteger(args, 'levelLimit', DEFAULT_LEVEL_LIMIT, 'tree');
    const includeAbstract = optionalBoolean(args, 'includeAbstract', false, 'tree');

    const result = await context.filesystem.tree(uri, context.principals, { depth: levelLimit, limit: TREE_LIMIT });
    const lines = [uri.toStringAsDirectory()];
    for (const entry of result.entries) {
      const depth = Math.max(1, entry.uri.segments.length - uri.segments.length);
      const name = entry.kind === 'directory' ? `${entry.uri.name}/` : entry.uri.name;
      const abstract = includeAbstract && entry.abstract !== null ? ` — ${entry.abstract}` : '';
      lines.push(`${INDENT.repeat(depth)}${name}${abstract}`);
    }
    if (result.truncated) {
      lines.push('... (truncated)');
    }
    return textResult(lines.join('\n'));
  },
};
