/**
 * `health`：服务状态（架构文档 §17.9、§13.2）。
 *
 * 与 `GET /health` 返回同样的字段，外加**当前绑定主体与可寻址的根**：MCP 工具之间
 * 没有状态，Agent 拿不到「我是谁」就拼不出绝对 URI；`~` 别名（§6.1）的展开目标
 * 也来自这里。没有 `subject` / `scopes` 时，空库上的 Agent 只能猜一个默认根。
 *
 * 索引条数按「当前身份可见的根」统计：`RetrievalIndex` 没有全库计数方法，而 MCP
 * 工具不应该绕过权限去数别人的节点。字段名因此是 `index.visibleNodes`，与
 * `GET /health` 的 `index.totalNodes`（`node` 表全量）区分开——两个数回答的是两个
 * 问题，同名会让排查索引问题时把「库有多大」误判成「索引少了一半」。
 *
 * 统计有上限（`HEALTH_INDEX_LIMIT`），达到上限时 `index.visibleNodesTruncated`
 * 为 true，此时 `visibleNodes` 只是下界。
 *
 * `status` 的判定与 `GET /health` 共用 `api/health-status.ts`，降级摘要数也来自
 * 同一个 `ObservabilityService.health()`：同一个部署用哪种方式健康检查，结论必须
 * 一样。
 */

import { healthStatus } from '../../health-status.js';

import {
  asRecord,
  readScopes,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** 索引计数上限。经验值：再大的库用控制台看总量，MCP 只需要知道「有东西」。 */
const HEALTH_INDEX_LIMIT = 100_000;

/** 与 `package.json` 的版本一致。 */
const SERVICE_VERSION = '0.1.0';

export const healthTool: McpToolDefinition = {
  name: 'health',
  kind: 'read',
  description:
    '服务与身份自检，不改状态。要拼绝对 URI 时先调它拿 subject（形如 user:alice）与 scopes。index.visibleNodes 是当前身份可见的条数（最多 100000 条，visibleNodesTruncated=true 时只是下界）；全库总量看 GET /health 的 index.totalNodes。summary.degraded / rerank.degraded 为 true 表示对应环节降级。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(input, context) {
    asRecord(input, 'health');
    const scopes = await readScopes(context);

    // 计数失败不冒充 0：`visibleNodes: 0` 会让调用方以为「库里什么都没有」。
    let nodes: number | null = null;
    let nodesTruncated = false;
    try {
      const indexed = await context.index.glob({
        pattern: '**',
        scopes,
        principals: context.principals,
        limit: HEALTH_INDEX_LIMIT,
      });
      nodes = indexed.length;
      // 取满上限时不能断言「这就是全部」：多取一条会多一次全量枚举，代价不对等。
      nodesTruncated = indexed.length >= HEALTH_INDEX_LIMIT;
    } catch (error) {
      context.logger.error('MCP health 统计索引失败。', {
        requestId: context.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 与 `GET /health` 同一份取数：降级摘要只能逐个目录读 `.abstract.md`，
    // 在 MCP 侧重算会变成第二份实现（以及第二个上限）。
    const memory = await context.observability.health();
    const pending = context.tasks.countByStatus('pending');
    const running = context.tasks.countByStatus('running');
    const summaryDegraded = context.config.summary.generator === 'rule';
    // 重排降级与摘要降级是同一类「配了但没生效」：必须在 status 与明细里同时可见。
    const rerank = context.search.rerankHealth;
    const status = healthStatus({
      ruleGenerator: summaryDegraded,
      degradedSummaries: memory.degradedSummaries,
      rerankDegraded: rerank.degraded,
      indexUnavailable: nodes === null,
    });

    return textResult(
      [
        `status: ${status}`,
        `subject: ${context.subject}`,
        `scopes: ${scopes.join(', ')}`,
        `index.visibleNodes: ${nodes === null ? 'unavailable' : String(nodes)}`,
        `index.visibleNodesTruncated: ${String(nodesTruncated)}`,
        `queue: pending=${pending} processing=${running}`,
        `summary.degraded: ${String(summaryDegraded)}`,
        `summary.degradedDirs: ${memory.degradedSummaries}`,
        `rerank.degraded: ${String(rerank.degraded)}`,
        `rerank.failures: ${rerank.failures}`,
        `version: ${SERVICE_VERSION}`,
      ].join('\n'),
    );
  },
};
