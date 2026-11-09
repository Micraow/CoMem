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
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';
import { TRUNCATED_MARKER } from '../text.js';

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
    '带层级的目录树，缩进表示层级，目录带 / 后缀。要一次看清结构时用，比多次 list 便宜；只要一层用 list。levelLimit 是相对传入 uri 的层数（默认 3），目录很大时先调小。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '目录 URI；~ 是当前身份的根' },
      levelLimit: { type: 'integer', minimum: 0, default: DEFAULT_LEVEL_LIMIT },
    },
    required: ['uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'tree');
    const uri = Uri.parse(requiredString(args, 'uri', 'tree'));
    const levelLimit = nonNegativeInteger(args, 'levelLimit', DEFAULT_LEVEL_LIMIT, 'tree');

    const result = await context.filesystem.tree(uri, context.principals, { depth: levelLimit, limit: TREE_LIMIT });
    const lines = [uri.toStringAsDirectory()];
    for (const entry of result.entries) {
      const depth = Math.max(1, entry.uri.segments.length - uri.segments.length);
      const name = entry.kind === 'directory' ? `${entry.uri.name}/` : entry.uri.name;
      lines.push(`${INDENT.repeat(depth)}${name}`);
    }
    if (result.truncated) {
      lines.push(TRUNCATED_MARKER);
    }
    return textResult(lines.join('\n'));
  },
};
