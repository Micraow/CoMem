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
  optionalStringArray,
  positiveInteger,
  readScopes,
  requiredString,
  asRecord,
  formatDegradations,
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
      memoryTypes: {
        type: 'array',
        items: { type: 'string' },
        description: '只看这些记忆类型（如 rules / preferences / entities）；省略表示不限',
      },
      updatedAfter: {
        type: 'string',
        format: 'date-time',
        description: '只返回该时刻之后（含）更新的节点，ISO 8601',
      },
      updatedBefore: {
        type: 'string',
        format: 'date-time',
        description: '只返回该时刻之前（含）更新的节点，ISO 8601',
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

    // 本地索引 / ACL 阶段：超时归因要说得出「卡在本地」，不能笼统写「工具超时」。
    context.deadline?.mark('index');
    const result = await context.search.findWithDiagnostics(query, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit,
      levels: level === undefined ? undefined : [level],
      contextTypes: contextType === undefined ? undefined : [contextType],
      memoryTypes: optionalStringArray(args, 'memoryTypes', 'find'),
      updatedAfter: optionalString(args, 'updatedAfter', 'find'),
      updatedBefore: optionalString(args, 'updatedBefore', 'find'),
      deadlineAt: context.deadline?.deadlineAt,
      onUpstream: (upstream) => context.deadline?.mark(upstream),
    });
    // 降级必须写进结果：`Found 0` 不说明原因时，调用方会把它读成「记忆里没有」。
    return textResult(
      [formatHits(result.hits), ...formatDegradations(context.config.retrieval.engine, result)].join(
        '\n',
      ),
    );
  },
};
