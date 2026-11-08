/**
 * `find`：单条查询的语义检索（架构文档 §8.4、§13.2）。
 *
 * 这是「不知道内容在哪个目录」时的入口。已经知道路径的调用方应该用 `read`——多走
 * 一次检索只会更慢，而且 `read` 的报错更直接。
 */

import {
  optionalContextType,
  optionalLevel,
  optionalString,
  positiveInteger,
  readScopes,
  requiredString,
  asRecord,
  formatScoredHits,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §13.2 的默认值：`limit=10`。 */
const DEFAULT_LIMIT = 10;

export const findTool: McpToolDefinition = {
  name: 'find',
  kind: 'read',
  description:
    '不确定内容在哪个目录时用这个；如果你已经知道路径，用 read 更快。query 会先过滤掉斜杠命令、代码块和 URL；targetUri 传目录可以收窄范围，传文件没有意义。返回按相关度降序；分数只在同一次检索的同一引擎内可比（fts5 的 bm25、vector 的余弦、hybrid 的融合分量纲不同），不要拿它当跨引擎的绝对相关度阈值。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
      targetUri: { type: 'string', description: '可选的路径范围，通常是目录 URI' },
      limit: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT, description: '最多返回条数' },
      level: { type: 'string', enum: ['L0', 'L1', 'L2'], description: '只看某一层级' },
      contextType: {
        type: 'string',
        enum: ['memory', 'resource', 'skill', 'session'],
        description: '只看某类上下文',
      },
    },
    required: ['query'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'find');
    const query = requiredString(args, 'query', 'find');
    const targetUri = optionalString(args, 'targetUri', 'find');
    const limit = positiveInteger(args, 'limit', DEFAULT_LIMIT, 'find');
    const level = optionalLevel(args, 'level', 'find');
    const contextType = optionalContextType(args, 'contextType', 'find');
    const scopes = await readScopes(context, targetUri);

    const hits = await context.search.find(query, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit,
      levels: level === undefined ? undefined : [level],
      contextTypes: contextType === undefined ? undefined : [contextType],
    });
    return textResult(formatScoredHits(hits));
  },
};
