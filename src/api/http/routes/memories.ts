/**
 * 记忆复核路由（架构文档 §14、§11.6、§11.8、§12.4）。
 *
 * `experiences` / `rules` 写入时是 `pending`（§11.6）：它们在被 `approve` 之前不进
 * 检索结果。控制台的「记忆复核」页用这三个端点。
 *
 * `POST /dreamer` 是记忆合并（§11.8）：**破坏性操作**（会 `delete`），所以
 * 需要 `manage`、`dryRun` 默认 `true`、并且配置里没开启时明确拒绝。它**不进 MCP**
 * （§3：16 个工具，不多不少）。
 *
 * 路径里的 URI 是 **percent-encoded** 的（`comem%3A%2F%2Fuser%2Falice%2F...`）：
 * URI 含 `/`，不编码会被 Fastify 当成多段路径。Fastify 的路径参数默认已经
 * `decodeURIComponent`，这里直接 `Uri.parse`。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { MemoryLink } from '../../../domain/memory-link.js';
import type { NodeStatus } from '../../../domain/node.js';
import { MILLISECONDS_PER_SECOND } from '../../../domain/time.js';
import { Uri } from '../../../domain/uri.js';
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
  /** 当前身份在该 scope 内可读的待复核总数，不受 `limit` 影响。 */
  readonly total: number;
  /** 上述记录中最老一条的年龄；没有记录或 `updatedAt` 不可解析时为 `null`。 */
  readonly oldestPendingAgeSeconds: number | null;
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

/** 与 `/health` 同口径：以 `updatedAt` 计算，时钟回拨时按 0 秒报。 */
function oldestPendingAgeSecondsOf(
  records: readonly MemoryRecord[],
  now = Date.now(),
): number | null {
  let oldestTimestamp: number | null = null;
  for (const record of records) {
    const timestamp = Date.parse(record.updatedAt);
    if (!Number.isNaN(timestamp) && (oldestTimestamp === null || timestamp < oldestTimestamp)) {
      oldestTimestamp = timestamp;
    }
  }
  return oldestTimestamp === null
    ? null
    : Math.max(0, Math.floor((now - oldestTimestamp) / MILLISECONDS_PER_SECOND));
}

export function createMemoryRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { memory, memoryLink, authorizer } = services;

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
        // 先取完整队列再过滤、计数，最后才截页。若把 limit 传给底层扫描，无权记录或
        // 更深处的记录会先占掉名额，total 与 oldest 也都只能看到前 100 条。
        const records = await memory.listPending(scope);
        // §12.4：scope 根可读不代表子树可读。`listPending` 走的是**不传 principals**
        // 的 `rawFilesystem`，`restricted` 切断或显式 deny 的子目录照样会被递归列出；
        // 而一条待复核记录的 URI、`fields`、`sources` 全都是内容。所以按**记录自己的
        // URI** 逐条求 read，无权限的整条不返回——不返回空字段，也不打码。
        //
        // 不逐条 `assert` + try/catch：那会把 SQL / 物化表 / IO 故障也归成「无权限」，
        // 把真实的存储问题静默隐藏成「这里没有记录」。
        const readable = await authorizer.filterReadable(
          records.map((record) => record.uri),
          context.principals,
        );
        const visible = records.filter((record) => readable.has(record.uri.toString()));
        return ok<MemoryPendingResponse>({
          scope: scope.toString(),
          total: visible.length,
          oldestPendingAgeSeconds: oldestPendingAgeSecondsOf(visible),
          memories: visible.slice(0, limit).map(serializeRecord),
        });
      });

      // `/consolidate` 是破坏性操作的旧名称，继续作为同一契约的兼容别名。
      app.post<{ Body: unknown }>('/dreamer', (request) => runDreamer(services, request));
      app.post<{ Body: unknown }>('/consolidate', (request) => runDreamer(services, request));
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

async function runDreamer({ authorizer, config, dreamer }: HttpRouteServices, request: FastifyRequest) {
  const { subject, principals } = requestContextOf(request);
  const body = requireRecord(request.body, 'memories/dreamer');
  const scope = requireUri(body, 'scope');
  const dryRun = optionalBoolean(body, 'dryRun');
  if (!scope.isRoot && !scope.isProject) throw new ComemError('INVALID_ARGUMENT', 'Dreamer 需要用户、组或项目作用域。');
  await authorizer.assert(scope, MANAGE, principals);
  if (!config.memory.dreamer.manualConsolidation) {
    throw new ComemError('PERMISSION_DENIED', '记忆合并未开启，请启用 Dreamer 手动整理。', { field: 'memory.dreamer.manualConsolidation' });
  }
  return ok(await dreamer.run(scope, {
    dryRun, subject, principals,
    canRead: (uri) => authorizer.check(uri, READ, principals),
    authorize: (uri, kind) => authorizer.assert(uri, kind === 'delete' ? MANAGE : WRITE, principals),
  }));
}
