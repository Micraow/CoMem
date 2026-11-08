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
  formatHits,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §13.2 的默认值：`limit=10`。 */
const DEFAULT_LIMIT = 10;

export const findTool: McpToolDefinition = {
  name: 'find',
  kind: 'read',
  description:
    '语义召回：按相关度降序返回摘要列表。不知道内容在哪、或要按「意思」找时用；已知路径用 read，正则匹配用 grep，要规则的完整正文用 rule_search。targetUri 传目录收窄范围，传文件只会命中它自己。返回不带分数：FTS5 / 向量 / 融合 / 重排四种引擎的分数量纲互不相同，跨引擎比数字没有意义，只有顺序可用。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
      targetUri: {
        type: 'string',
        description: '可选的目录 URI，用来收窄范围；~ 是当前身份的根',
      },
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
    return textResult(formatHits(hits));
  },
};
