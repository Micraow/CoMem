/**
 * `search`：带查询计划的检索（架构文档 §8.4、§13.2）。
 *
 * 与 `find` 的差别是**意图分析**：`find` 拿一条字面查询去检索，`search` 先把
 * query 重写成 0–5 条 TypedQuery，逐条检索再按 URI 合并（保留最高分）。
 *
 * 返回末尾附 `Query plan`：调用方能看到重写产出了几条查询、每条是什么意图、这次
 * 是不是降级了。`sessionId` 是重写的输入（用它解析指代），**不是**检索范围——
 * 范围由 `targetUri` 与调用方身份决定。
 */

import type { SearchPlan } from '../../../domain/retrieval.js';
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

interface PlanEnvelope {
  readonly scopes: readonly string[];
  readonly limit: number;
  readonly level: string | undefined;
  readonly contextType: string | undefined;
  readonly sessionId: string | undefined;
}

/**
 * `Query plan` 段。
 *
 * 「几条查询 / 是否降级 / 每条意图」三件事必须都能读出来：`analyzed: false` 时
 * 模型没有参与，命中来自原查询——不知道这一点，调用方会把「重写没生效」误判成
 * 「检索没命中」。
 */
function formatQueryPlan(plan: SearchPlan, envelope: PlanEnvelope): string {
  const status = plan.analyzed ? 'analyzed' : 'degraded';
  const lines = [
    'Query plan:',
    `  scopes: ${envelope.scopes.join(', ')}`,
    `  limit: ${envelope.limit}`,
    `  level: ${envelope.level ?? 'any'}`,
    `  contextType: ${envelope.contextType ?? 'any'}`,
    `  sessionId: ${envelope.sessionId ?? 'none'}`,
    `  queries: ${plan.queries.length} (${status}, ${plan.elapsedMs.toFixed(0)}ms)`,
  ];
  if (!plan.analyzed) {
    lines.push(`  reason: ${plan.reason ?? '原因未知'}`);
  }
  for (const query of plan.queries) {
    lines.push(`  - [${query.intent} ${query.confidence.toFixed(2)}] ${query.text}`);
  }
  return lines.join('\n');
}

export const searchTool: McpToolDefinition = {
  name: 'search',
  kind: 'read',
  description:
    '需要意图分析时用这个：query 会被重写成 0–5 条带意图的查询，逐条检索后合并去重。传 sessionId 让它读到最近几轮对话，把「那它呢」这类指代补全；不传也能检索，只是历史为空。返回格式与 find 相同，末尾多一段 Query plan，显示这次重写了几条查询、每条是什么意图、是否降级。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
      targetUri: { type: 'string', description: '可选的路径范围，通常是目录 URI' },
      limit: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT },
      level: { type: 'string', enum: ['L0', 'L1', 'L2'] },
      contextType: { type: 'string', enum: ['memory', 'resource', 'skill', 'session'] },
      sessionId: { type: 'string', description: '可选：提供最近消息用于解析指代' },
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

    const result = await context.search.search(query, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit,
      sessionId,
      levels: level === undefined ? undefined : [level],
      contextTypes: contextType === undefined ? undefined : [contextType],
    });

    context.logger.debug('MCP search 完成', {
      requestId: context.requestId,
      sessionId: sessionId ?? null,
      scopes,
      queries: result.plan.queries.length,
      analyzed: result.plan.analyzed,
      returned: result.hits.length,
    });

    return textResult(
      `${formatScoredHits(result.hits)}\n${formatQueryPlan(result.plan, {
        scopes,
        limit,
        level,
        contextType,
        sessionId,
      })}`,
    );
  },
};
