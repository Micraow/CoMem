/**
 * 评估执行器（W23）。
 *
 * 一个变体 = 一套检索配置（引擎 + 重排 / 热度 / 层级权重）。执行器对每个变体做
 * 同一件事：起一个**独立的数据根**、把语料写进去、跑完所有查询、算出指标、
 * 清理。变体之间没有共享状态——一个变体的索引行、向量、权限表不能漏进下一个，
 * 否则「hybrid 比 fts5 好」可能只是「hybrid 跑在 fts5 已经建好的索引上」。
 *
 * ## 延迟只测 `find()`
 *
 * 建容器（迁移、建表、根预置）、播种语料（写文件 + 嵌入）、清理都发生在计时窗口
 * 之外。把建库时间算进延迟会让「第一次查询」看起来比真实慢几十倍，而用户感知的
 * 延迟里不包含建库——那是部署时的事，不是查询时的事。
 *
 * ## 为什么每个查询跑 3 次取中位数
 *
 * 第一次查询会带上冷缓存成本：SQLite 的页缓存、`sqlite-vec` 的向量缓存、FTS5
 * 的段缓存都是第一次才加载。取 3 次的中位数（而不是平均）是为了让一次性的 GC
 * 或调度抖动落在两端、不影响中心值；3 是「能算中位数」的最小奇数，再多次不会
 * 让中心值更稳，只会让评估更慢。命中取**最后一次**（热缓存）的结果——三次结果
 * 相同，取哪次都不改变指标，取最后一次是为了与「稳定态」的延迟对应。
 *
 * ## 变体之间必须重建容器
 *
 * 重排开关、热度权重、层级权重、检索引擎都是**容器级配置**（`SearchService`
 * 构造时读入）。`createContainer` 没有「热改配置」的入口，而绕过它去改服务实例
 * 又会让「配置真的生效」这个前提失效。所以变体切换只能重建容器——这是整个执行器
 * 里唯一需要重建的地方，重建成本已经用「延迟窗口之外」隔离掉了。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Container, createContainer } from '../bootstrap/container.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { RetrievalEngine } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';

import type { EvalDataset } from './dataset.js';
import {
  aggregateMetrics,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  type AggregateMetrics,
  type QueryMetrics,
} from './metrics.js';

/**
 * 一个变体的配置。
 *
 * `overrides` 里只放**容器级**配置：它们必须能通过 `createContainer` 的装配
 * 生效，否则评估的就是一份「看起来改了、实际没改」的配置（AGENTS.md §1）。
 */
export interface EvalVariant {
  /** 报告里的名字。同一份报告里必须唯一 */
  readonly name: string;
  readonly engine: RetrievalEngine;
  readonly overrides?: {
    readonly rerankEnabled?: boolean;
    readonly hotnessWeight?: number;
    readonly levelWeights?: { readonly l0: number; readonly l1: number; readonly l2: number };
  };
}

export interface EvalRunOptions {
  readonly dataset: EvalDataset;
  /** 跑哪些引擎；默认三个都跑 */
  readonly engines?: readonly RetrievalEngine[];
  /** top-k，默认 10 */
  readonly k?: number;
  /**
   * 每个引擎的额外配置覆盖（例如 rerank 开/关、hotness weight）。
   *
   * 传了它就忽略 `engines`：两者是「用默认变体列表」与「用我给的变体列表」的关系，
   * 同时传只会让「`--engines` 为什么没生效」变成一个需要读源码才能回答的问题。
   */
  readonly variants?: readonly EvalVariant[];
}

export interface EvalReport {
  readonly dataset: string;
  readonly k: number;
  readonly variants: readonly {
    readonly name: string;
    readonly engine: RetrievalEngine;
    readonly metrics: AggregateMetrics;
    readonly latency: { readonly p50Ms: number; readonly p95Ms: number; readonly meanMs: number };
  }[];
}

export interface EvalRunnerDeps {
  /**
   * 容器工厂。注入而不是直接 import：测试要用 `vi.fn` 观察「每个变体各建一次
   * 容器」，CLI 要绑定 `--config` 指定的配置文件。`src/eval` 本身不决定配置
   * 从哪来。
   */
  readonly createContainer: typeof createContainer;
  readonly logger: Logger;
}

/**
 * 默认 top-k。
 *
 * 10 就是 `DEFAULT_SEARCH_LIMIT`（`src/services/search.ts`）：§13.2 的 MCP `find`
 * 工具默认值，服务层 `resolveLimit` 与 HTTP / MCP 入口共用同一个常量，不存在
 * 「服务层多取、工具层截断」的余量。评估要报的是「用户实际拿到的前 k 条」，所以
 * 取这个数。
 */
const DEFAULT_K = 10;

/**
 * 默认变体：三个引擎各一个，不加任何覆盖。
 *
 * 顺序是「关键词 → 语义 → 融合」，与 `domain/retrieval.ts` 的 `RetrievalEngine`
 * 联合顺序一致：报告从上往下读就是「单路基线 → 另一路基线 → 融合」。
 */
const DEFAULT_ENGINES: readonly RetrievalEngine[] = ['fts5', 'vector', 'hybrid'];

/**
 * 每个查询重复次数。
 *
 * 3 是「能算中位数」的最小奇数（见文件头）。改大只会线性增加运行时间（每条查询
 * 都要一次嵌入调用），不会提高中心值的精度。
 */
const REPEATS = 3;

/**
 * 延迟分位数。
 *
 * p50 是典型用户感知，p95 是尾延迟——两个一起看才知道「平均还行」是不是被少数
 * 慢查询掩盖了。50 / 95 是 SRE 领域最常用的两个分位，不是本项目的测量值。
 */
const P50 = 0.5;
const P95 = 0.95;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * 评估强制覆盖的配置。
 *
 * 这几项与「检索质量」无关，但会让每次运行变慢、变不确定、或者让不同变体之间
 * 的差异被别的东西污染：
 *
 * - `summary.generator=rule`：摘要生成会调模型（一次约 10 秒），评估只关心检索；
 *   规则摘要同时保证 L0 文本可复现。
 * - `session.autoCommit.enabled=false`：不启动后台调度器，避免「评估跑到一半
 *   调度器开始提交会话」这种与检索无关的写入。
 * - `session.expiry.idleTimeoutSeconds=0`：同上。
 * - `logging.level=fatal`：容器内的日志走 `ConsoleLogger`，默认写 **stdout**，
 *   会把表格 / JSON 割裂。评估命令的 stdout 只放结果，容器日志没有别的去处
 *   （`createContainer` 不接受 logger 注入），所以在这里整体静默。代价是
 *   「嵌入供应商不可用」这类告警也看不到——执行器在变体零命中时补一条自己的
 *   告警（见 `#runVariant`），把最严重的那类静默失败捞回来。
 *
 * 这些覆盖在 `eval/README.md` 里对用户可见，不是隐藏行为。
 */
const FIXED_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  COMEM_SUMMARY_GENERATOR: 'rule',
  COMEM_SESSION_AUTO_COMMIT_ENABLED: 'false',
  COMEM_SESSION_EXPIRY_IDLE_TIMEOUT_SECONDS: '0',
  COMEM_LOGGING_LEVEL: 'fatal',
});

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 语料的根必须是唯一的 `user` 根；执行器把它绑成服务图身份。 */
function resolveScope(dataset: EvalDataset): { readonly subject: string; readonly scope: string } {
  const roots = new Set<string>();
  for (const uri of Object.keys(dataset.corpus)) {
    const parsed = Uri.parse(uri);
    if (parsed.scope !== 'user') {
      throw invalid('评估语料的根必须是 user 作用域：group 作用域的权限依赖组成员关系，评估容器没有。', {
        field: 'corpus',
        uri,
      });
    }
    roots.add(parsed.rootId);
  }

  const ids = [...roots];
  const rootId = ids[0];
  if (ids.length !== 1 || rootId === undefined) {
    throw invalid('评估语料必须属于同一个 user 根，实际跨越了多个根。', {
      field: 'corpus',
      roots: ids,
    });
  }
  return { subject: `user:${rootId}`, scope: `comem://user/${rootId}` };
}

function resolveVariants(options: EvalRunOptions): readonly EvalVariant[] {
  const variants =
    options.variants ??
    (options.engines ?? DEFAULT_ENGINES).map((engine): EvalVariant => ({ name: engine, engine }));

  if (variants.length === 0) {
    throw invalid('至少需要一个变体。', { field: 'variants' });
  }

  const names = new Set<string>();
  for (const variant of variants) {
    if (variant.name.trim() === '') {
      throw invalid('变体名不能为空。', { field: 'variants' });
    }
    if (names.has(variant.name)) {
      throw invalid(`变体名重复：${variant.name}`, { field: 'variants', name: variant.name });
    }
    names.add(variant.name);

    const hotnessWeight = variant.overrides?.hotnessWeight;
    if (
      hotnessWeight !== undefined &&
      (!Number.isFinite(hotnessWeight) || hotnessWeight < 0 || hotnessWeight > 1)
    ) {
      // 与 `config/schema.ts` 的 `telemetry.hotness.weight` 值域一致（0–1）。
      // 在这里挡掉是为了给出「变体配置错了」而不是「配置文件校验失败」的报错。
      throw invalid(`变体的 hotnessWeight 必须在 [0, 1] 内：${String(hotnessWeight)}`, {
        field: 'variants.overrides.hotnessWeight',
        name: variant.name,
      });
    }
    for (const [level, weight] of Object.entries(variant.overrides?.levelWeights ?? {})) {
      if (!Number.isFinite(weight) || weight <= 0) {
        throw invalid(`变体的层级权重必须是正数：${level} = ${String(weight)}`, {
          field: 'variants.overrides.levelWeights',
          name: variant.name,
        });
      }
    }
  }
  return variants;
}

/**
 * 变体 → `createContainer` 的环境变量。
 *
 * 走环境变量而不是临时配置文件，是因为 `loadConfig` 的实现里「环境变量 > 配置文件」，
 * 而且 `collectLeaves(defaults)` 保证了每个叶子都有对应的 `COMEM_*` 名字。用临时
 * 配置文件也行，但要多一次「先读用户的 YAML、再合并、再写回」——多一份实现就多
 * 一个与 `loadConfig` 漂移的机会。
 */
function variantEnvironment(variant: EvalVariant): NodeJS.ProcessEnv {
  const overrides = variant.overrides;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...FIXED_OVERRIDES,
    COMEM_RETRIEVAL_ENGINE: variant.engine,
    // 必须显式写死：不写就会继承用户 config.yaml 的 `retrieval.rerank.enabled`，
    // 「hybrid」变体就可能在用户开了重排时偷偷变成 hybrid+rerank。
    COMEM_RETRIEVAL_RERANK_ENABLED: overrides?.rerankEnabled === true ? 'true' : 'false',
  };

  if (overrides?.hotnessWeight !== undefined) {
    env['COMEM_TELEMETRY_HOTNESS_WEIGHT'] = String(overrides.hotnessWeight);
  }
  if (overrides?.levelWeights !== undefined) {
    env['COMEM_RETRIEVAL_LEVEL_WEIGHTS_L0'] = String(overrides.levelWeights.l0);
    env['COMEM_RETRIEVAL_LEVEL_WEIGHTS_L1'] = String(overrides.levelWeights.l1);
    env['COMEM_RETRIEVAL_LEVEL_WEIGHTS_L2'] = String(overrides.levelWeights.l2);
  }
  return env;
}

/**
 * 把语料写进临时数据根。
 *
 * 先建目录再写文件：文件路径上的每一级目录都要在索引里有一行，否则 `glob` /
 * 权限过滤会看不到它们（`IndexObserver` 只物化祖先的 ACL，不建索引行）。
 * 目录去重后按字符串排序，父目录先于子目录被创建。
 */
async function seedCorpus(
  container: Container,
  dataset: EvalDataset,
  scope: string,
  principals: readonly string[],
): Promise<void> {
  const directories = new Set<string>();
  for (const uri of Object.keys(dataset.corpus)) {
    let parent = Uri.parse(uri).parent();
    while (parent !== null && parent.toString() !== scope) {
      directories.add(parent.toString());
      parent = parent.parent();
    }
  }
  for (const directory of [...directories].sort()) {
    await container.services.filesystem.mkdir(Uri.parse(directory), principals);
  }
  for (const [uri, text] of Object.entries(dataset.corpus)) {
    await container.services.filesystem.write(Uri.parse(uri), text, principals);
  }
  // 写操作的索引是同步的，嵌入是排期的。不等它跑完，第一条查询会撞上一个
  // 「文档行在、向量还没写」的中间态，语义检索的召回率会随机偏低。
  await container.services.indexObserver.drain();
}

/** 一条查询的中位数延迟（毫秒），输入是 `REPEATS` 次测量。 */
function medianLatency(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[middle - 1] ?? 0;
    const right = sorted[middle] ?? 0;
    return (left + right) / 2;
  }
  return sorted[middle] ?? 0;
}

/**
 * 最近秩（nearest-rank）分位数。
 *
 * 不使用插值：延迟样本是「这次查询花了多少毫秒」的离散观测，插出来的分位数
 * 不对应任何一次真实请求，报告里写「p95 = 12.34ms」会让人以为真的有一次
 * 12.34ms 的请求。最近秩取的是「至少 95% 的样本不超过这个值」，可以直接在
 * 原始数据里找到。
 */
function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** 标注 → 分级相关度。`relevant` 里没在 `graded` 出现的算 1。 */
function gradedOf(dataset: EvalDataset, index: number): Map<string, number> {
  const evalCase = dataset.cases[index];
  if (evalCase === undefined) {
    return new Map();
  }
  const graded = new Map<string, number>();
  for (const uri of evalCase.relevant) {
    graded.set(uri, 1);
  }
  for (const [uri, relevance] of Object.entries(evalCase.graded ?? {})) {
    graded.set(uri, relevance);
  }
  return graded;
}

/** 一条查询的指标。 */
function queryMetrics(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  graded: ReadonlyMap<string, number>,
  k: number,
): QueryMetrics {
  const topK = retrieved.slice(0, k);
  const hits = new Set(topK.filter((uri) => relevant.has(uri))).size;
  return {
    recallAtK: recallAtK(retrieved, relevant, k),
    reciprocalRank: reciprocalRank(retrieved, relevant),
    ndcgAtK: ndcgAtK(retrieved, graded, k),
    hits,
  };
}

export class EvalRunner {
  readonly #createContainer: typeof createContainer;
  readonly #logger: Logger;

  constructor(deps: EvalRunnerDeps) {
    this.#createContainer = deps.createContainer;
    this.#logger = deps.logger;
  }

  async run(options: EvalRunOptions): Promise<EvalReport> {
    const k = options.k ?? DEFAULT_K;
    if (!Number.isInteger(k) || k <= 0) {
      throw invalid('k 必须是正整数。', { k });
    }
    const variants = resolveVariants(options);
    const { subject, scope } = resolveScope(options.dataset);

    const reports: EvalReport['variants'][number][] = [];
    for (const variant of variants) {
      reports.push(await this.#runVariant(options.dataset, variant, k, subject, scope));
    }

    return { dataset: options.dataset.name, k, variants: reports };
  }

  /**
   * 跑一个变体。
   *
   * 临时数据根在 `finally` 里删：变体失败（配置错、供应商不可用）时不能留下
   * 一个几百 MB 的目录。`container` 可能还没建出来（配置校验失败），所以先判空。
   */
  async #runVariant(
    dataset: EvalDataset,
    variant: EvalVariant,
    k: number,
    subject: string,
    scope: string,
  ): Promise<EvalReport['variants'][number]> {
    const dataDir = await mkdtemp(join(tmpdir(), 'comem-eval-'));
    let container: Container | null = null;
    try {
      container = await this.#createContainer({
        argv: ['--data-dir', dataDir],
        env: variantEnvironment(variant),
        subject,
      });

      await seedCorpus(container, dataset, scope, [subject, 'user:*']);

      const perQuery: QueryMetrics[] = [];
      const medians: number[] = [];
      let totalHits = 0;
      for (const [index, evalCase] of dataset.cases.entries()) {
        const relevant = new Set(evalCase.relevant);
        const graded = gradedOf(dataset, index);
        const latencies: number[] = [];
        let retrieved: readonly string[] = [];

        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
          const startedAt = process.hrtime.bigint();
          const hits = await container.services.search.find(evalCase.query, {
            scopes: [scope],
            subject,
            principals: [subject, 'user:*'],
            limit: k,
          });
          latencies.push(
            Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND,
          );
          // 最后一次是热缓存下的稳定态（见文件头「为什么跑 3 次」）。
          retrieved = hits.map((hit) => hit.uri);
        }

        medians.push(medianLatency(latencies));
        const metrics = queryMetrics(retrieved, relevant, graded, k);
        totalHits += metrics.hits;
        perQuery.push(metrics);
      }

      // 容器日志被静默成 fatal（见 `FIXED_OVERRIDES`）。一个需要嵌入的变体如果
      // 一条都没命中，最可能的原因是嵌入供应商不可用——那会让报告看起来像
      // 「语义检索很差」而不是「这次评估坏了」。在这里说出来。
      if (variant.engine !== 'fts5' && totalHits === 0 && dataset.cases.length > 0) {
        this.#logger.warn('变体没有任何命中，检查嵌入供应商是否可用。', {
          dataset: dataset.name,
          variant: variant.name,
          engine: variant.engine,
          queries: dataset.cases.length,
        });
      }

      const metrics = aggregateMetrics(perQuery);
      const meanMs =
        medians.reduce((total, value) => total + value, 0) / Math.max(1, medians.length);
      this.#logger.info('评估变体完成', {
        dataset: dataset.name,
        variant: variant.name,
        engine: variant.engine,
        queries: perQuery.length,
        recallAtK: metrics.recallAtK,
        mrr: metrics.mrr,
        ndcgAtK: metrics.ndcgAtK,
        p50Ms: percentile(medians, P50),
        p95Ms: percentile(medians, P95),
      });

      return {
        name: variant.name,
        engine: variant.engine,
        metrics,
        latency: {
          p50Ms: percentile(medians, P50),
          p95Ms: percentile(medians, P95),
          meanMs,
        },
      };
    } finally {
      if (container !== null) {
        await container.close();
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}
