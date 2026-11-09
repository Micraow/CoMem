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
  formatDegradations,
  formatHits,
  optionalContextType,
  optionalLevel,
  optionalString,
  optionalStringArray,
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
  if (plan.reason !== null) {
    // 降级原因与「是否 analyzed」是两件事：向量后端不可用时 `analyzed` 仍然是
    // `true`，只打印 reason（旧实现把它藏起来了，调用方看不出这次结果来自 FTS）。
    lines.push(`  degraded: ${plan.reason}`);
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
    '与 find 同一份索引，但先把 query 重写成 0–5 条带意图的查询再合并去重，代价是一次模型调用。find 没命中、或 prompt 里有「它 / 继续 / 上面那个」这类指代时用；传 sessionId 才有对话历史可解析。返回格式同 find，末尾多一段 Query plan（几条查询、是否降级）。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
      targetUri: {
        type: 'string',
        description: '可选的目录 URI，用来收窄范围；~ 是当前身份的根',
      },
      limit: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT },
      level: { type: 'string', enum: ['L0', 'L1', 'L2'] },
      contextType: { type: 'string', enum: ['memory', 'resource', 'skill', 'session'] },
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
    // 记忆类型 / 时间范围是**过滤维度**，不是新的检索面：两种 mode 都下推给索引。
    const memoryTypes = optionalStringArray(args, 'memoryTypes', 'search');
    const updatedAfter = optionalString(args, 'updatedAfter', 'search');
    const updatedBefore = optionalString(args, 'updatedBefore', 'search');
    const scopes = await readScopes(context, targetUri);
    // 本地索引阶段；随后的意图分析 / 嵌入 / 重排由服务层上报（`onUpstream`）。
    context.deadline?.mark('index');
    const deadline = {
      deadlineAt: context.deadline?.deadlineAt,
      onUpstream: (upstream: 'llm' | 'embedding' | 'rerank') =>
        context.deadline?.mark(upstream),
    };

    if (mode === 'context') {
      // 跨轮去重：传了 sessionId 才有轮次时钟（见 `ContextOptions.sessionId`）。
      const diagnostics = await context.search.contextWithDiagnostics(query, {
        scopes,
        subject: context.subject,
        principals: context.principals,
        limit,
        sessionId,
        levels: level === undefined ? undefined : [level],
        contextTypes: contextType === undefined ? undefined : [contextType],
        memoryTypes,
        updatedAfter,
        updatedBefore,
        ...deadline,
      });

      const assembled = diagnostics.assembly;
      context.logger.debug('MCP search（context）完成', {
        requestId: context.requestId,
        sessionId: sessionId ?? null,
        scopes,
        items: assembled.items.length,
        tokensUsed: assembled.tokensUsed,
        dropped: assembled.dropped,
      });

      // `mode=context` 也可能在向量 / 重排上降级：只给条目数的话，
      // `Context: 0 item(s)` 会被读成「记忆里没有」。
      return textResult(
        [formatContext(assembled), ...formatDegradations(context.config.retrieval.engine, diagnostics)].join(
          '\n',
        ),
      );
    }

    const result = await context.search.search(query, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit,
      sessionId,
      levels: level === undefined ? undefined : [level],
      contextTypes: contextType === undefined ? undefined : [contextType],
      memoryTypes,
      updatedAfter,
      updatedBefore,
      ...deadline,
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
      `${formatHits(result.hits)}\n${formatQueryPlan(result.plan, {
        scopes,
        limit,
        level,
        contextType,
        sessionId,
      })}`,
    );
  },
};
