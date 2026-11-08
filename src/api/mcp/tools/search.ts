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

import { ComemError } from '../../../domain/errors.js';
import type { SearchPlan } from '../../../domain/retrieval.js';
import type { ContextAssembly } from '../../../services/search.js';
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

/** `search` 的出参形态（§8.6）：`list` 是默认，`context` 返回可直接注入模型的文本。 */
type SearchMode = 'list' | 'context';

const SEARCH_MODES: readonly SearchMode[] = ['list', 'context'];

function parseMode(value: string | undefined): SearchMode {
  if (value === undefined) {
    return 'list';
  }
  const match = SEARCH_MODES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ComemError('INVALID_ARGUMENT', `search 的 mode 只能是 list / context。`, {
      tool: 'search',
      mode: value,
    });
  }
  return match;
}

/**
 * `context` 模式的文本：先一行统计，再是渲染好的条目。
 *
 * 统计行让人一眼看出「这次投了几条、花了多少预算、丢了几条」；正文是模型直接
 * 读的部分，与 §8.6 的渲染格式一致。
 */
function formatContext(result: ContextAssembly): string {
  const header = `Context: ${result.items.length} item(s), ${result.tokensUsed} token(s), ${result.dropped} dropped.`;
  return result.rendered === '' ? header : `${header}\n\n${result.rendered}`;
}

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
      mode: {
        type: 'string',
        enum: ['list', 'context'],
        default: 'list',
        description:
          'list（默认）返回命中列表；context 返回按 token 预算分层投放、可直接注入模型的文本',
      },
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
    const mode = parseMode(optionalString(args, 'mode', 'search'));
    const scopes = await readScopes(context, targetUri);

    if (mode === 'context') {
      // 跨轮去重：传了 sessionId 才有轮次时钟（见 `ContextOptions.sessionId`）。
      const assembled = await context.search.context(query, {
        scopes,
        subject: context.subject,
        principals: context.principals,
        limit,
        sessionId,
        levels: level === undefined ? undefined : [level],
        contextTypes: contextType === undefined ? undefined : [contextType],
      });

      context.logger.debug('MCP search（context）完成', {
        requestId: context.requestId,
        sessionId: sessionId ?? null,
        scopes,
        items: assembled.items.length,
        tokensUsed: assembled.tokensUsed,
        dropped: assembled.dropped,
      });

      return textResult(formatContext(assembled));
    }

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
