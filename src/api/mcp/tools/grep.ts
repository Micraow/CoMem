/**
 * `grep`：正则按行匹配（架构文档 §8.4、§13.2）。
 *
 * 与 `find` 的差别是**任意正则**，不是词：`find` 走 FTS5 索引，`grep` 读文件。
 * 因此 `grep` 的代价与子树大小成正比，`uri` 要尽量收窄。
 *
 * 大小写不敏感用内联修饰符 `(?i:...)` 实现。`SearchService.grep` 接受的是模式
 * 字符串，没有 flags 参数；内联组是唯一不改变匹配语义的传法（需要支持 ECMAScript
 * RegExp Modifiers 的运行时）。
 */

import { READ_LEVEL } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { DEFAULT_SEARCH_LIMIT } from '../../../services/retrieval/budget.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  optionalBoolean,
  positiveInteger,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** 把模式包成大小写不敏感的组。 */
function caseInsensitive(pattern: string): string {
  return `(?i:${pattern})`;
}

export const grepTool: McpToolDefinition = {
  name: 'grep',
  kind: 'read',
  description:
    '按正则逐行匹配文件内容。知道大概目录、要找符号或报错原文时用；不知道在哪用 find，只找文件名用 glob。pattern 是正则不是通配符，特殊字符要转义。uri 越窄越快，因为它逐个读文件。nodeLimit 是命中条数上限，不是文件数；返回 uri + 行号 + 命中行。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '搜索范围的目录 URI；~ 是当前身份的根' },
      pattern: { type: 'string', description: '正则表达式' },
      caseInsensitive: { type: 'boolean', default: false },
      nodeLimit: { type: 'integer', minimum: 1, default: DEFAULT_SEARCH_LIMIT },
    },
    required: ['uri', 'pattern'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'grep');
    const uri = Uri.parse(requiredString(args, 'uri', 'grep'));
    const pattern = requiredString(args, 'pattern', 'grep');
    // 空串是合法正则，`new RegExp('')` 匹配每一行：不拦的话调用方什么都不传也能拿
    // 回 nodeLimit 条命中，看起来像「搜索成功了」。HTTP 侧同样不接受空 pattern。
    if (pattern === '') {
      throw new ComemError('INVALID_ARGUMENT', 'grep 的 pattern 不能为空。', {
        tool: 'grep',
        field: 'pattern',
      });
    }
    const caseInsensitiveFlag = optionalBoolean(args, 'caseInsensitive', false, 'grep');
    const nodeLimit = positiveInteger(args, 'nodeLimit', DEFAULT_SEARCH_LIMIT, 'grep');

    // 出口清单（§12.4）：`SearchService.glob` 只做 filterReadable，不抛
    // PERMISSION_DENIED，所以范围本身必须先求权。
    await context.acl.assert(uri, READ_LEVEL, context.principals);

    const effective = caseInsensitiveFlag ? caseInsensitive(pattern) : pattern;
    const hits = await context.search.grep(effective, {
      scopes: [uri.toString()],
      subject: context.subject,
      principals: context.principals,
      limit: nodeLimit,
    });

    const lines = [`Found ${hits.length} match(es):`];
    for (const hit of hits) {
      lines.push(hit.uri);
      lines.push(`  L${hit.line} [${pattern}]: ${hit.text}`);
    }
    return textResult(lines.join('\n'));
  },
};
