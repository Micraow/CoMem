/**
 * 运维路由（架构文档 §14、§17.1、§17.9）。
 *
 * 两个端点都**不认证**：探活与 Prometheus 抓取由运维系统发起，它们没有 CoMem 身份；
 * 要求一个 `x-comem-subject` 头只会让 `curl /health` 全部 401。两个端点也不读用户
 * 内容——`/health` 只做计数聚合与绑定身份，`/metrics` 只输出进程内累加器。
 *
 * `/health` 的 `status` 判定（§17.9）：
 *
 * - `degraded`：摘要生成器配成 `rule`（模型不可用时的降级路径），或存在降级摘要的
 *   目录。**降级必须可见**——静默降级等于骗人；
 * - `ok`：其余。
 *
 * 索引与文件系统对账不一致也是 `degraded` 的判定条件，v1 没有对账任务（backlog 的
 * `reindex`），所以这一条判不出来，不要假装能判。
 *
 * ## `subject` / `scopes` 为什么在 `/health` 里
 *
 * 控制台必须知道服务端绑定的主体，才能拼出可用的 `x-comem-subject`（§18）。让它在
 * 构建期注入或读一个 `NUXT_PUBLIC_SUBJECT` 只是把硬编码换成第二处配置：运维改
 * `server.subject` 时还要改控制台，漏改的症状是每个请求 401。
 *
 * MCP 的 `health` 工具从 W28 起就返回这两个字段（§13.2），HTTP 侧补齐后两边一致。
 * 公开端点因此多暴露一个部署身份（`user:alice`）——v1 没有认证，`/health` 的调用方
 * 不带请求头时会被当成绑定主体，这个值本来就不是秘密。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { AclService } from '../../../services/acl.js';
import { ok } from '../envelope.js';
import { PROMETHEUS_CONTENT_TYPE, SERVICE_VERSION, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

type HealthStatus = 'ok' | 'degraded';

function statusOf(ruleGenerator: boolean, degradedSummaries: number): HealthStatus {
  return ruleGenerator || degradedSummaries > 0 ? 'degraded' : 'ok';
}

/**
 * 绑定主体可寻址且可读的根（§12.1、§12.5）。
 *
 * 个人根排在前面：控制台用它当默认作用域（`useScopeRoot`）。组根按装配顺序追加，
 * 读不到就跳过——组根还没预置 ACL 只说明「这个组没有可查的内容」，不是健康检查失败。
 *
 * 与 MCP `health` 的 `readScopes` 同一套语义（§12.4 的出口清单）。那边对个人根
 * `assert`，是因为 MCP 请求带身份、读不到自己的空间属于装配错误；`/health` 是公开
 * 端点，没有请求身份，只能报告绑定主体读得到的根，不能因为 ACL 缺失就 500。
 */
async function readableScopes(
  acl: AclService,
  subject: string,
  groups: readonly string[],
): Promise<readonly string[]> {
  const scopes: string[] = [];
  for (const principal of [subject, ...groups]) {
    const parsed = parsePrincipal(principal);
    const uri = Uri.parse(`comem://${parsed.kind}/${parsed.id}`);
    if (await acl.check(uri, 1)) {
      scopes.push(uri.toString());
    }
  }
  return scopes;
}

export function createOpsRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { acl, observability, tasks, config, subject, groups } = services;

  return {
    // 空前缀 = 挂根路径（`/health`、`/metrics`），同时也会挂到 `/api/v1` 下。
    prefix: '',
    register(app: FastifyInstance): void {
      app.get('/health', async () => {
        const health = await observability.health();
        const ruleGenerator = config.summary.generator === 'rule';
        return ok({
          status: statusOf(ruleGenerator, health.degradedSummaries),
          // 控制台的身份引导读这两个字段（§16）；与 MCP `health` 的字段同名同义。
          subject,
          scopes: await readableScopes(acl, subject, groups),
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
