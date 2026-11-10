/**
 * 记忆复核路由（架构文档 §14、§11.6、§11.8、§12.4）。
 *
 * `experiences` / `rules` 写入时是 `pending`（§11.6）：它们在被 `approve` 之前不进
 * 检索结果。控制台的「记忆复核」页用这三个端点。
 *
 * `POST /consolidate` 是记忆合并（§11.8）：**破坏性操作**（会 `delete`），所以
 * 需要 `manage`、`dryRun` 默认 `true`、并且配置里没开启时明确拒绝。它**不进 MCP**
 * （§3：16 个工具，不多不少）。
 *
 * 路径里的 URI 是 **percent-encoded** 的（`comem%3A%2F%2Fuser%2Falice%2F...`）：
 * URI 含 `/`，不编码会被 Fastify 当成多段路径。Fastify 的路径参数默认已经
 * `decodeURIComponent`，这里直接 `Uri.parse`。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { MemoryLink } from '../../../domain/memory-link.js';
import type { NodeStatus } from '../../../domain/node.js';
import { Uri } from '../../../domain/uri.js';
import type {
  ConsolidationResult,
  ConsolidationTraceEntry,
} from '../../../services/consolidation.js';
import type { MemoryRecord } from '../../../services/memory.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  optionalString,
  requireRecord,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';
import {
  optionalBoolean, parseLinkDirection, parseMemoryUri, readableLinks, requireRecordReason, scopeOfSubject,
} from './memories-request.js';

/** §12.1：read = 1、write = 3、manage = 7。 */
const READ = 1;
const WRITE = 3;
const MANAGE = 7;

/** 复核列表的默认条数。经验值：一页 100 条已经够滚动。 */
const DEFAULT_PENDING_LIMIT = 100;

/** 复核队列里的一条记忆（§11.6、§11.11）。 */
interface SerializedMemoryRecord {
  readonly uri: string;
  /**
   * 记忆类型。读路径是开放字符串：类型由配置声明，收窄成字面量联合会让自定义
   * 类型写成 `pending` 之后在响应里「不存在」。
   */
  readonly memoryType: string;
  readonly status: NodeStatus;
  readonly updatedAt: string;
  /** 有效区间下界；`null` = 不知道从何时开始有效。键始终输出。 */
  readonly validFrom: string | null;
  /** 有效区间上界；`null` = 仍然有效。键始终输出。 */
  readonly validUntil: string | null;
  /** 顶替掉的版本文件 URI；没顶替过任何版本时是 `null`。 */
  readonly supersedes: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly sources: readonly string[];
}

/** `GET /memories/pending` 的响应体。 */
interface MemoryPendingResponse {
  readonly scope: string;
  readonly memories: readonly SerializedMemoryRecord[];
}

/** `POST /memories/{uri}/approve` 的响应体：通过后的状态。 */
interface MemoryApproveResponse {
  readonly uri: string;
  readonly status: NodeStatus;
  readonly subject: string;
}

/**
 * `POST /memories/{uri}/reject` 的响应体。
 *
 * 两个分支互斥：`restored` 带 `restoredFrom`（没有删除任何东西），`removed` 没有
 * 这个字段。与 `MemoryRejectResult` 同形，避免「恢复了」与「删除了」在响应上
 * 无法区分。
 */
type MemoryRejectResponse =
  | {
      readonly uri: string;
      readonly outcome: 'restored';
      readonly restoredFrom: string;
      readonly reason: string;
    }
  | { readonly uri: string; readonly outcome: 'removed'; readonly reason: string };

/** `GET /memories/{uri}/links` 的响应体。 */
interface MemoryLinksResponse {
  readonly uri: string;
  readonly direction: 'links' | 'backlinks';
  readonly links: readonly SerializedLink[];
}

function serializeRecord(record: MemoryRecord): SerializedMemoryRecord {
  return {
    uri: record.uri.toString(),
    memoryType: record.memoryType,
    status: record.status,
    updatedAt: record.updatedAt,
    // 有效区间与被顶替的版本（W98）。三个键**始终输出**：`null` 表示「这条记忆没有
    // 这个值」，省略键则让「旧数据缺字段」与「无有效期」在控制台里变成同一种状态。
    // 时间串原样带出：它们与 `updatedAt` 同为 frontmatter 里的 ISO 8601 UTC 形态，
    // 不在序列化层换一种格式。
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    supersedes: record.supersedes,
    fields: record.fields,
    // 溯源（W97）：复核页要能回答「这条经验从哪来」。缺键的旧记忆是空数组。
    sources: record.sources,
  };
}

export function createMemoryRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { memory, memoryLink, authorizer, consolidation, config } = services;

  return {
    prefix: '/memories',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/pending', async (request) => {
        const query = requireRecord(request.query, 'memories/pending');
        const context = requestContextOf(request);
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_PENDING_LIMIT, { min: 1 });
        const scopeUri = optionalString(query, 'scopeUri') ?? scopeOfSubject(context.subject);
        const scope = Uri.parse(scopeUri);
        await authorizer.assert(scope, READ, context.principals);
        const records = await memory.listPending(scope, { limit });
        // §12.4：scope 根可读不代表子树可读。`listPending` 走的是**不传 principals**
        // 的 `rawFilesystem`，`restricted` 切断或显式 deny 的子目录照样会被递归列出；
        // 而一条待复核记录的 URI、`fields`、`sources` 全都是内容。所以按**记录自己的
        // URI** 逐条求 read，无权限的整条不返回——不返回空字段，也不打码。
        //
        // `limit` 约束的是扫描条数（`listPending` 在服务层），不是返回条数：被过滤掉
        // 的条目不会换成更深处的记录。
        //
        // 不逐条 `assert` + try/catch：那会把 SQL / 物化表 / IO 故障也归成「无权限」，
        // 把真实的存储问题静默隐藏成「这里没有记录」。
        const readable = await authorizer.filterReadable(
          records.map((record) => record.uri),
          context.principals,
        );
        return ok<MemoryPendingResponse>({
          scope: scope.toString(),
          memories: records
            .filter((record) => readable.has(record.uri.toString()))
            .map(serializeRecord),
        });
      });

      app.post<{ Body: unknown }>('/consolidate', async (request) => {
        const context = requestContextOf(request);
        const body = requireRecord(request.body, 'memories/consolidate');
        const scope = requireUri(body, 'scope');
        const dryRun = optionalBoolean(body, 'dryRun');

        // **不展开组**：合并是写操作，scope 必须显式指定（§11.8）。
        await authorizer.assert(scope, MANAGE, context.principals);

        if (!config.memory.consolidation.enabled) {
          // 不返回空结果：那会让「没开」看起来像「没有可合并的记忆」。
          throw new ComemError(
            'PERMISSION_DENIED',
            '记忆合并未开启：它是一次会删除记忆的破坏性操作，需要显式把 memory.consolidation.enabled 设为 true。',
            { field: 'memory.consolidation.enabled' },
          );
        }

        const result = await consolidation.consolidate(scope, {
          // 不传就是预览：合并会 delete，误点的代价不可逆。
          dryRun: dryRun ?? true,
          subject: context.subject,
          principals: context.principals,
        });
        return ok(serializeConsolidation(result));
      });

      app.post<{ Params: { uri: string } }>('/:uri/approve', async (request) => {
        const context = requestContextOf(request);
        const uri = parseMemoryUri(request.params.uri);
        await authorizer.assert(uri, WRITE, context.principals);
        await memory.approve(uri);
        return ok<MemoryApproveResponse>({
          uri: uri.toString(),
          status: 'active',
          subject: context.subject,
        });
      });

      app.post<{ Params: { uri: string }; Body: unknown }>('/:uri/reject', async (request) => {
        const context = requestContextOf(request);
        const body = requireRecord(request.body, 'memories/reject');
        const uri = parseMemoryUri(request.params.uri);
        const reason = requireRecordReason(body);
        await authorizer.assert(uri, WRITE, context.principals);
        // 拒绝有两种终态（§11.11）：把被顶替的版本写回规范 URI，或者删掉文件。
        // 响应如实说哪一种——恢复时**没有删除任何东西**，不能回 `removed: true`。
        // `restoredFrom` 只在恢复时出现，值是那份版本文件的 URI。
        const rejected = await memory.reject(uri, reason);
        return ok<MemoryRejectResponse>(
          rejected.outcome === 'restored'
            ? {
                uri: uri.toString(),
                outcome: rejected.outcome,
                restoredFrom: rejected.restoredFrom.toString(),
                reason,
              }
            : { uri: uri.toString(), outcome: rejected.outcome, reason },
        );
      });

      // 记忆关联边（§11.10）。**只读**：`links` 是派生/关联数据，产生端在写入路径上。
      // `direction` 决定返回正向（谁指向别人）还是派生（谁指向我）。
      //
      // 两条方向都只返回**另一端也可读**的边（§12.4）：URI 本身就是内容，
      // `backlinks` 列出的 `comem://user/bob/memories/profile/health-condition.md`
      // 已经说出了 Bob 有哪些记忆。
      app.get<{ Params: { uri: string }; Querystring: Record<string, unknown> }>(
        '/:uri/links',
        async (request) => {
          const context = requestContextOf(request);
          const uri = parseMemoryUri(request.params.uri);
          const query = requireRecord(request.query, 'memories/links');
          const direction = parseLinkDirection(query['direction']);
          await authorizer.assert(uri, READ, context.principals);
          const links =
            direction === 'backlinks' ? memoryLink.backlinksOf(uri) : memoryLink.linksOf(uri);
          const readable = await readableLinks(
            authorizer,
            links,
            direction,
            context.principals,
          );
          return ok<MemoryLinksResponse>({
            uri: uri.toString(),
            direction,
            links: readable.map(serializeLink),
          });
        },
      );
    },
  };
}

/** 一条关联边的响应形状（§11.10）。 */
interface SerializedLink {
  readonly from: string;
  readonly to: string;
  readonly linkType: string;
  readonly weight: number;
  readonly matchText: string;
  readonly description: string;
}

function serializeLink(link: MemoryLink): SerializedLink {
  return {
    from: link.fromUri.toString(),
    to: link.toUri.toString(),
    linkType: link.linkType,
    weight: link.weight,
    matchText: link.matchText,
    description: link.description,
  };
}

/**
 * 合并结果就是响应体：`adds` / `updates` / `deletes` 是 URI 列表，`trace` 是每一轮
 * 模型输出的摘要。**不返回正文**：正文在 `read` 里拿，响应体只说明「谁被改了」。
 */
interface SerializedConsolidation {
  readonly adds: readonly string[];
  readonly updates: readonly string[];
  readonly deletes: readonly string[];
  readonly trace: readonly ConsolidationTraceEntry[];
}

function serializeConsolidation(result: ConsolidationResult): SerializedConsolidation {
  return {
    adds: result.adds,
    updates: result.updates,
    deletes: result.deletes,
    trace: result.trace,
  };
}
