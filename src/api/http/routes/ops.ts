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

import { ComemError } from '../../../domain/errors.js';
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
          // §17.5 的记忆健康度。`ObservabilityService.health()` 已经算出来了，
          // 不往封套里带的话控制台只能去 `GET /memories/pending` 拉一页再数，
          // 而那个端点需要认证、还只返回一页。
          memory: {
            pendingReview: health.pendingReview,
            orphanTasks: health.orphanTasks,
            oldestPendingAgeSeconds: health.oldestPendingAgeSeconds,
          },
          version: SERVICE_VERSION,
        });
      });

      app.get('/metrics', async (_request, reply) => {
        // 关闭时明确 404，而不是输出空文本：空文本会被抓取端当成「指标全为 0」，
        // 运维看不到「这个开关被关掉了」（AGENTS.md §1 的「假配置」）。
        if (!config.telemetry.metrics.enabled) {
          throw new ComemError(
            'NOT_FOUND',
            '指标已关闭（telemetry.metrics.enabled = false）。',
          );
        }
        return reply
          .header('content-type', PROMETHEUS_CONTENT_TYPE)
          .send(observability.renderMetrics());
      });
    },
  };
}
