/**
 * 分析型统计（架构文档 §17.1、§17.5）。
 *
 * `GET /api/v1/stats/memories`：回答「哪些记忆冷了、哪些很久没碰、最老的多久」。
 * 这是治理指标，不是检索指标——热度不参与排序（§17.5），只有清理判断用得上。
 *
 * ## 为什么走端口而不是直接查 SQL
 *
 * `api/` 不能 import `adapters/`（架构文档 §4.2）。这里声明 `MemoryStatsAccess`
 * 端口，SQL 与 ACL 谓词留在 `bootstrap/container.ts` 里实现——与 `AdminAccess`
 * 同一个模式（§17.5 的聚合、§8.2 的权限物化表都在那一层读）。
 *
 * ## 权限：只统计当前身份**可见**的记忆
 *
 * 跨用户统计是信息泄露。可见性由 `node_permission` 物化表判定（allow 且无 deny），
 * 与 `retrieval-index` 的 `permissionPredicate` 同源（§12.3 的代价转移）。全库视角
 * 只有 `GET /health` 的 `index.totalNodes` 提供，那是运维的「库有多大」，与「我能
 * 看到多少、冷热如何」是两个问题，不能混。
 *
 * ## 热度复用现有定义
 *
 * 分档与打分**不另造一套**：`domain/hotness.ts` 的 `hotnessScore` / `hotnessTier`
 * 是 W14a / W17 定下的热度衰减与 `telemetry.hotness.*` 配置的共同实现。SQL 无法算
 * 指数衰减，所以端口只把可见记忆的原始列取回来，打分与分桶在本层完成。
 */

import type { FastifyInstance } from 'fastify';

import { hotnessScore, hotnessTier, type HotnessTier } from '../../../domain/hotness.js';
import type { HttpRouteGroup } from '../server.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';

import type { HttpRouteServices } from './index.js';

/** 一条可见记忆的原始热度输入（端口返回，未打分）。 */
export interface MemoryStatsRow {
  /** `node.memory_type`：profile / preferences / ... ；非记忆文件为 `null`。 */
  readonly memoryType: string | null;
  /** `node.access_count`：被检索命中并注入的次数。 */
  readonly accessCount: number;
  /** `node.last_accessed_at`：ISO 8601；从没访问过是 `null`。 */
  readonly lastAccessedAt: string | null;
  /** `node.updated_at`：ISO 8601。用于「最老记忆有多久」。 */
  readonly updatedAt: string;
  /** `node.size`：正文字节数，用于 `avgSizeBytes`。 */
  readonly size: number;
}

/**
 * 记忆统计的读取端口。SQL 与 ACL 谓词在 `bootstrap/container.ts` 实现。
 *
 * `principals` 是当前请求的主体集合（含 `user:*` 通配与组展开，见 §12.1）。返回
 * **只含可见记忆**的行，调用方不再做权限过滤。
 */
export interface MemoryStatsAccess {
  rowsFor(principals: readonly string[]): readonly MemoryStatsRow[];
}

/**
 * 陈旧线（天）。7 天 = 一周的自然节奏，与热度的默认半衰期（`DEFAULT_HALF_LIFE_DAYS`，
 * 168 小时）对齐：过了半衰期权重减半，正好是「该被想起来」的临界。30 天 = 一个月，
 * 是运维决定「这条还没用就该清」的常见保守线。两者都是可向用户解释的经验值，
 * 不是测量结果——真要调，改这里的常数。
 */
const STALE_DAYS_7 = 7;
const STALE_DAYS_30 = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** 分档结果的完整形状：三档一个不少，缺的补 0（空库也要返回 `{cold:0,warm:0,hot:0}`）。 */
type HotnessBuckets = Record<HotnessTier, number>;

function emptyBuckets(): HotnessBuckets {
  return { cold: 0, warm: 0, hot: 0 };
}

/** 记忆类型分布。`memory_type` 为 `null` 的行不进 `byCategory`（它不是记忆分类）。 */
function byCategoryOf(rows: readonly MemoryStatsRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.memoryType === null) {
      continue;
    }
    counts[row.memoryType] = (counts[row.memoryType] ?? 0) + 1;
  }
  return counts;
}

interface StalenessReport {
  readonly notAccessed7d: number;
  readonly notAccessed30d: number;
  /** 最老记忆距今天数；空库为 `null`。从没过期的记忆按 `updated_at` 算。 */
  readonly oldestMemoryAgeDays: number | null;
}

function stalenessOf(rows: readonly MemoryStatsRow[], now: Date): StalenessReport {
  const nowMs = now.getTime();
  let notAccessed7d = 0;
  let notAccessed30d = 0;
  let oldestMs: number | null = null;

  for (const row of rows) {
    // 「多久没碰」只看得见的访问时间。从没访问过的记忆不是「很早就没碰」——
    // 它从未被检索命中，按 `last_accessed_at = null` 计入全部两条阈值（最陈旧）。
    // 这符合运维语义：「这条从没被用过」比「30 天没碰」更需要清理。
    const lastMs = row.lastAccessedAt === null ? null : Date.parse(row.lastAccessedAt);
    const referenceMs = lastMs ?? Date.parse(row.updatedAt);
    if (Number.isNaN(referenceMs)) {
      // 时间串坏了不能当「刚访问」——那会让一条烂数据看起来最热。跳过它的陈旧
      // 统计，但它的「年龄」仍由 updated_at 参与 oldest 计算（若 updated_at 合法）。
      continue;
    }
    const ageDays = Math.max(0, (nowMs - referenceMs) / MILLISECONDS_PER_DAY);
    if (row.lastAccessedAt === null || ageDays >= STALE_DAYS_30) {
      notAccessed30d += 1;
    }
    if (row.lastAccessedAt === null || ageDays >= STALE_DAYS_7) {
      notAccessed7d += 1;
    }

    const updatedMs = Date.parse(row.updatedAt);
    if (!Number.isNaN(updatedMs)) {
      if (oldestMs === null || updatedMs < oldestMs) {
        oldestMs = updatedMs;
      }
    }
  }

  return {
    notAccessed7d,
    notAccessed30d,
    oldestMemoryAgeDays:
      oldestMs === null ? null : Math.floor(Math.max(0, nowMs - oldestMs) / MILLISECONDS_PER_DAY),
  };
}

export function createStatsRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { memoryStats, config } = services;
  // 半衰期：与 `telemetry.hotness.halfLifeHours` 同一个配置项（§17.5）。单位小时，
  // `hotnessScore` 的输入是天。
  const halfLifeDays = config.telemetry.hotness.halfLifeHours / 24;

  return {
    prefix: '/stats',
    register(app: FastifyInstance): void {
      app.get('/memories', async (request) => {
        const context = requestContextOf(request);
        const now = new Date();
        const rows = memoryStats.rowsFor(context.principals);

        const buckets = emptyBuckets();
        let sizeTotal = 0;
        for (const row of rows) {
          const score = hotnessScore({
            activeCount: row.accessCount,
            lastAccessedAt: row.lastAccessedAt,
            now,
            halfLifeDays,
          });
          buckets[hotnessTier(score)] += 1;
          sizeTotal += row.size;
        }

        const total = rows.length;
        return ok({
          total,
          byCategory: byCategoryOf(rows),
          hotness: buckets,
          staleness: stalenessOf(rows, now),
          // 与 §17.5 示例一致的附带指标：平均大小帮助判断「清理能省多少磁盘」。
          avgSizeBytes: total === 0 ? 0 : Math.round(sizeTotal / total),
        });
      });
    },
  };
}
