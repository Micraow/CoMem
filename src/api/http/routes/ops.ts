/**
 * 运维路由（架构文档 §14、§17.1、§17.9）。
 *
 * 两个端点都**不认证**：探活与 Prometheus 抓取由运维系统发起，它们没有 CoMem 身份；
 * 要求一个 `x-comem-subject` 头只会让 `curl /health` 全部 401。两个端点也不读用户
 * 内容——`/health` 只做计数聚合，`/metrics` 只输出进程内累加器。
 *
 * `/health` 的 `status` 判定（§17.9）：
 *
 * - `degraded`：摘要生成器配成 `rule`（模型不可用时的降级路径），或存在降级摘要的
 *   目录。**降级必须可见**——静默降级等于骗人；
 * - `ok`：其余。
 *
 * 索引与文件系统对账不一致也是 `degraded` 的判定条件，v1 没有对账任务（backlog 的
 * `reindex`），所以这一条判不出来，不要假装能判。
 */

import type { FastifyInstance } from 'fastify';

import { ok } from '../envelope.js';
import { PROMETHEUS_CONTENT_TYPE, SERVICE_VERSION, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

type HealthStatus = 'ok' | 'degraded';

function statusOf(ruleGenerator: boolean, degradedSummaries: number): HealthStatus {
  return ruleGenerator || degradedSummaries > 0 ? 'degraded' : 'ok';
}

export function createOpsRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { observability, tasks, config } = services;

  return {
    // 空前缀 = 挂根路径（`/health`、`/metrics`），同时也会挂到 `/api/v1` 下。
    prefix: '',
    register(app: FastifyInstance): void {
      app.get('/health', async () => {
        const health = await observability.health();
        const ruleGenerator = config.summary.generator === 'rule';
        return ok({
          status: statusOf(ruleGenerator, health.degradedSummaries),
          index: { nodes: health.indexNodes },
          queue: {
            pending: tasks.countByStatus('pending'),
            processing: tasks.countByStatus('running'),
          },
          summary: {
            degraded: ruleGenerator,
            pendingDirs: health.staleSummaries,
            degradedDirs: health.degradedSummaries,
          },
          version: SERVICE_VERSION,
        });
      });

      app.get('/metrics', async (_request, reply) => {
        return reply
          .header('content-type', PROMETHEUS_CONTENT_TYPE)
          .send(observability.renderMetrics());
      });
    },
  };
}
