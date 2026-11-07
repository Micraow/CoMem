/**
 * `search`：带查询计划的检索（架构文档 §8.4、§13.2）。
 *
 * 与 `find` 的区别是返回末尾附 `Query plan`：调用方能看到实际执行的范围与过滤
 * 条件，排查「为什么没命中」时不用猜。`sessionId` 只用于把这次查询归到某个会话，
 * 不改变检索结果——会话本身由 Hook 插件采集（§15）。
 */

import {
  asRecord,
  formatScoredHits,
  optionalContextType,
  optionalLevel,
  optionalString,
  positiveInteger,
  readScopes,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §13.2 的默认值：`limit=10`。 */
const DEFAULT_LIMIT = 10;

export const searchTool: McpToolDefinition = {
  name: 'search',
  kind: 'read',
  description:
    '需要看到查询计划、或想按会话归因时用这个；只想要结果用 find 更省 token。sessionId 不改变检索范围，只写进日志与计划。返回格式与 find 相同，末尾多一行 Query plan，用它确认 level / contextType 过滤是否吞掉了预期的命中。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
      targetUri: { type: 'string', description: '可选的路径范围，通常是目录 URI' },
      limit: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT },
      level: { type: 'string', enum: ['L0', 'L1', 'L2'] },
      contextType: { type: 'string', enum: ['memory', 'resource', 'skill', 'session'] },
      sessionId: { type: 'string', description: '可选：把这次查询归到某个会话' },
    },
    required: ['query'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'search');
    const query = requiredString(args, 'query', 'search');
    const targetUri = optionalString(args, 'targetUri', 'search');
    const limit = positiveInteger(args, 'limit', DEFAULT_LIMIT, 'search');
    const level = optionalLevel(args, 'level', 'search');
    const contextType = optionalContextType(args, 'contextType', 'search');
    const sessionId = optionalString(args, 'sessionId', 'search');
    const scopes = await readScopes(context, targetUri);

    const hits = await context.search.find(query, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit,
      levels: level === undefined ? undefined : [level],
      contextTypes: contextType === undefined ? undefined : [contextType],
    });

    context.logger.debug('MCP search 完成', {
      requestId: context.requestId,
      sessionId: sessionId ?? null,
      scopes,
      returned: hits.length,
    });

    const plan = [
      'Query plan:',
      `  scopes: ${scopes.join(', ')}`,
      `  limit: ${limit}`,
      `  level: ${level ?? 'any'}`,
      `  contextType: ${contextType ?? 'any'}`,
      `  sessionId: ${sessionId ?? 'none'}`,
    ].join('\n');
    return textResult(`${formatScoredHits(hits)}\n${plan}`);
  },
};
