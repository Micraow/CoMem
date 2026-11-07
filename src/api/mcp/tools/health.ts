/**
 * `health`：服务状态（架构文档 §17.9、§13.2）。
 *
 * 与 `GET /health` 返回同样的字段。降级必须可见——静默降级等于骗人（§17.9）。
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
    '怀疑检索结果不对、或想知道后台任务是否堆积时先调这个，它不读内容也不改状态。它统计的是当前身份可见的索引条数，不是全库总量。summary.degraded 为 true 表示摘要走的是规则降级，此时摘要质量会下降。',
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

    return textResult(
      [
        `status: ${status}`,
        `index.nodes: ${nodes}`,
        `queue: pending=${pending} running=${running}`,
        `summary.degraded: ${String(degraded)}`,
        `version: ${SERVICE_VERSION}`,
      ].join('\n'),
    );
  },
};
