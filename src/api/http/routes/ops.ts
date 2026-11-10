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
 *   目录，或最近一次重排调用失败（已退回融合分）。**降级必须可见**——静默降级等于
 *   骗人；
 * - `ok`：其余。
 *
 * 判定与 MCP 的 `health` 工具共用 `api/health-status.ts`，枚举只有 `ok` / `degraded`：
 * 两个入口各写一份会让同一个部署用不同方式健康检查得到不同结论。
 *
 * `memoryExtract.skipped` 单独报告归档提交的记忆抽取是否被跳过（`providers.llm.default.type`
 * 是 `disabled` 时是）。它不参与 `status` 判定：同样的部署下 `summary.generator`
 * 必须是 `rule`，`status` 已经是 `degraded`；再加一个条件只是重复。
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
import type { ProfileFormatHealth } from '../../../services/observability/profile-format.js';
import type { RerankFailure } from '../../../services/retrieval/types.js';
import { healthStatus, type HealthStatus } from '../../health-status.js';
import { ok } from '../envelope.js';
import { PROMETHEUS_CONTENT_TYPE, SERVICE_VERSION, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

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
  principals: readonly string[],
): Promise<readonly string[]> {
  const scopes: string[] = [];
  for (const principal of principals) {
    const parsed = parsePrincipal(principal);
    // `user:*` 是通配主体，它不是一条可寻址的根——`comem://user/*` 不是合法 URI。
    if (parsed.id === '*') {
      continue;
    }
    const uri = Uri.parse(`comem://${parsed.kind}/${parsed.id}`);
    if (await acl.check(uri, 1, principals)) {
      scopes.push(uri.toString());
    }
  }
  return scopes;
}

/** `GET /health` 的响应体（§17.9）。字段口径见各查询的注释。 */
interface HealthResponse {
  /** `degraded` = 摘要 / 重排走了降级路径；静默降级等于骗人。 */
  readonly status: HealthStatus;
  /** 服务图绑定的主体（`config.server.subject`）。 */
  readonly subject: string;
  /** 绑定主体可寻址且可读的根；组根读不到就跳过。 */
  readonly scopes: readonly string[];
  readonly index: {
    /** **全库**条数（`node` 表全量），不是当前身份可见的条数。 */
    readonly totalNodes: number;
  };
  readonly queue: {
    readonly pending: number;
    readonly processing: number;
  };
  readonly summary: {
    readonly degraded: boolean;
    readonly pendingDirs: number;
    readonly degradedDirs: number;
  };
  /** 归档提交的记忆抽取是否被跳过（`providers.llm.default.type = disabled`）。 */
  readonly memoryExtract: {
    readonly skipped: boolean;
    readonly reason: 'llm_disabled' | null;
  };
  /** 重排健康度。`failures` 是累计值，`lastFailure` 成功一次后清空。 */
  readonly rerank: {
    readonly configured: boolean;
    readonly degraded: boolean;
    readonly failures: number;
    readonly lastFailure: RerankFailure | null;
  };
  /** §17.5 的记忆健康度。 */
  readonly memory: {
    readonly pendingReview: number;
    readonly orphanTasks: number;
    readonly oldestPendingAgeSeconds: number | null;
    readonly profileFormat: ProfileFormatHealth;
  };
  readonly version: string;
}

export function createOpsRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { acl, observability, tasks, config, subject, groups, search } = services;

  return {
    // 空前缀 = 挂根路径（`/health`、`/metrics`），同时也会挂到 `/api/v1` 下。
    prefix: '',
    register(app: FastifyInstance): void {
      app.get('/health', async () => {
        const health = await observability.health();
        const ruleGenerator = config.summary.generator === 'rule';
        // 没有可用模型时，归档提交会跳过 `memory_extract` / `memory_merge`（见
        // `bootstrap/container.ts` 的 `commitSkippedSteps`）。这两步不执行时归档
        // 仍然会写 `.done`，除了这条信息没有任何错误——降级必须可见。
        const memoryExtractSkipped = config.providers.llm.default.type === 'disabled';
        // 重排是「配了就必须能查」的质量增强：`degraded` 为真表示最近一次重排
        // 调用失败、这次检索用的是融合分。与 `summary.degraded` 同一个判定模式。
        const rerank = search.rerankHealth;
        return ok<HealthResponse>({
          status: healthStatus({
            ruleGenerator,
            degradedSummaries: health.degradedSummaries,
            rerankDegraded: rerank.degraded,
          }),
          // 控制台的身份引导读这两个字段（§16）；与 MCP `health` 的字段同名同义。
          subject,
          scopes: await readableScopes(acl, acl.resolvePrincipals(subject, groups)),
          // `totalNodes` 是**全库**条数（`node` 表全量），不是当前身份可见的条数。
          // MCP `health` 的 `index.visibleNodes` 是权限过滤后的那个数——两者不同名，
          // 因为它们是两个不同的问题：「库有多大」与「我能看到多少」。同名会让排查
          // 索引问题时把 19 和 12 当成同一个数在漂移。
          index: { totalNodes: health.indexNodes },
          queue: {
            pending: tasks.countByStatus('pending'),
            processing: tasks.countByStatus('running'),
          },
          summary: {
            degraded: ruleGenerator,
            pendingDirs: health.staleSummaries,
            degradedDirs: health.degradedSummaries,
          },
          // 归档提交的记忆抽取。形状与 `ingest` 报告的 `extraction` 一致
          // （`{ skipped, reason }`），两边说的是同一件事。
          memoryExtract: {
            skipped: memoryExtractSkipped,
            reason: memoryExtractSkipped ? 'llm_disabled' : null,
          },
          // 重排健康度。`failures` 是累计值（看得出间歇性失败），`lastFailure`
          // 在成功一次后清空（看得出「现在」还在不在跑）。
          rerank: {
            configured: rerank.configured,
            degraded: rerank.degraded,
            failures: rerank.failures,
            lastFailure: rerank.lastFailure,
          },
          // §17.5 的记忆健康度。`ObservabilityService.health()` 已经算出来了，
          // 不往封套里带的话控制台只能去 `GET /memories/pending` 拉一页再数，
          // 而那个端点需要认证、还只返回一页。
          memory: {
            pendingReview: health.pendingReview,
            orphanTasks: health.orphanTasks,
            oldestPendingAgeSeconds: health.oldestPendingAgeSeconds,
            // 画像格式契约自查（§11.1）：`warn` 级、不拒绝写入；`truncated` 为真时
            // 三个计数都是下界。
            profileFormat: health.profileFormat,
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
