/**
 * `glob`：按路径通配找文件（架构文档 §8.4、§13.2）。
 *
 * 只看路径，不看内容——找内容用 `grep`，找语义用 `find`。`*` 不跨 `/`，跨层用
 * `**`。
 */

import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  positiveInteger,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §13.2 的默认值：`nodeLimit=100`。 */
const DEFAULT_NODE_LIMIT = 100;

export const globTool: McpToolDefinition = {
  name: 'glob',
  kind: 'read',
  description:
    '只想按文件名模式列举文件时用这个，不读内容，所以比 grep 快；* 不跨目录，跨层要写 **。pattern 是相对 uri 的路径，uri 决定根。返回按 URI 升序，nodeLimit 截断时不会另行提示，取满就该收窄 pattern。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '相对路径通配模式，如 **/*.md' },
      uri: { type: 'string', description: '搜索范围的目录 URI' },
      nodeLimit: { type: 'integer', minimum: 1, default: DEFAULT_NODE_LIMIT },
    },
    required: ['pattern', 'uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'glob');
    const pattern = requiredString(args, 'pattern', 'glob');
    const uri = Uri.parse(requiredString(args, 'uri', 'glob'));
    const nodeLimit = positiveInteger(args, 'nodeLimit', DEFAULT_NODE_LIMIT, 'glob');

    // §12.4：`SearchService.glob` 只做 filterReadable，范围本身要先求权。
    await context.acl.assert(uri, 1, context.principals);

    const matched = await context.search.glob(pattern, {
      scopes: [uri.toString()],
      subject: context.subject,
      principals: context.principals,
      limit: nodeLimit,
    });

    const lines = [`Found ${matched.length} file(s):`];
    for (const value of matched) {
      lines.push(`  ${value}`);
    }
    return textResult(lines.join('\n'));
  },
};
