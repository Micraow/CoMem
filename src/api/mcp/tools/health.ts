/**
 * `health`：服务状态（架构文档 §17.9、§13.2）。
 *
 * 与 `GET /health` 返回同样的字段，外加**当前绑定主体与可寻址的根**：MCP 工具之间
 * 没有状态，Agent 拿不到「我是谁」就拼不出绝对 URI；`~` 别名（§6.1）的展开目标
 * 也来自这里。没有 `subject` / `scopes` 时，空库上的 Agent 只能猜一个默认根。
 *
 * 索引条数按「当前身份可见的根」统计：`RetrievalIndex` 没有全库计数方法，而 MCP
 * 工具不应该绕过权限去数别人的节点。
 */

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
    '怀疑检索结果不对、或想知道后台任务是否堆积时先调这个，它不读内容也不改状态。返回里的 subject 是当前身份（拼绝对 URI 用），scopes 是它能看到的根（`~` 展开的目标）。它统计的是当前身份可见的索引条数，不是全库总量。summary.degraded 为 true 表示摘要走的是规则降级，此时摘要质量会下降。rerank.degraded 为 true 表示最近一次重排调用失败、这次检索用的是融合分；rerank.failures 是进程启动以来的累计失败次数。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(input, context) {
    asRecord(input, 'health');
    const scopes = await readScopes(context);

    let nodes = 0;
    let status = context.config.summary.generator === 'rule' ? 'degraded' : 'ok';
    try {
      const indexed = await context.index.glob({
        pattern: '**',
        scopes,
        principals: context.principals,
        limit: HEALTH_INDEX_LIMIT,
      });
      nodes = indexed.length;
    } catch (error) {
      status = 'error';
      context.logger.error('MCP health 统计索引失败。', {
        requestId: context.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const pending = context.tasks.countByStatus('pending');
    const running = context.tasks.countByStatus('running');
    const degraded = context.config.summary.generator === 'rule';
    // 重排降级与摘要降级是同一类「配了但没生效」：必须在 status 与明细里同时可见。
    const rerank = context.search.rerankHealth;
    if (rerank.degraded) {
      status = 'degraded';
    }

    return textResult(
      [
        `status: ${status}`,
        `subject: ${context.subject}`,
        `scopes: ${scopes.join(', ')}`,
        `index.nodes: ${nodes}`,
        `queue: pending=${pending} running=${running}`,
        `summary.degraded: ${String(degraded)}`,
        `rerank.degraded: ${String(rerank.degraded)}`,
        `rerank.failures: ${rerank.failures}`,
        `version: ${SERVICE_VERSION}`,
      ].join('\n'),
    );
  },
};
