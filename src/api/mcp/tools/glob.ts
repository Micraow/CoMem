/**
 * `glob`：按路径通配找文件（架构文档 §8.4、§13.2）。
 *
 * 只看路径，不看内容——找内容用 `grep`，找语义用 `find`。`*` 不跨 `/`，跨层用
 * `**`。
 */

import { READ_LEVEL } from '../../../domain/acl.js';
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
    '按路径通配列文件，不读内容，所以比 grep 快。pattern 相对 uri，* 不跨 /，跨层写 **。要列举有哪些文件、或给 read / grep 找准确路径时用；找内容用 grep，找语义用 find。nodeLimit 截断时不另行提示，取满就收窄 pattern。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '相对路径通配模式，如 **/*.md' },
      uri: { type: 'string', description: '搜索范围的目录 URI；~ 是当前身份的根' },
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
    await context.acl.assert(uri, READ_LEVEL, context.principals);

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
