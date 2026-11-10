/**
 * 进程入口（架构文档 §18、§17.7、§10.4）。
 *
 * 这里只做五件事：装配容器、跑启动自检、起 HTTP、接退出信号、在监听之后启动存量
 * 向量回填。**没有业务逻辑**——一旦入口里出现「顺便做点什么」，它就成了第二个编排层，
 * 而测试永远只覆盖得到容器里的那一份。回填是这条规则的唯一例外，理由见
 * `startVectorBackfill`：它的触发点是「进程就绪」与「收到退出信号」，两者都只在这里。
 *
 * ## 启动自检
 *
 * 1. `mcpRegistry.validate()`：16 个工具的数量 / 重名 / 白名单（AGENTS.md 的硬约束）。
 *    演示时才发现多注册一个工具，代价比启动时崩掉大得多。
 * 2. 数据根可写：只读数据根时服务能起来，但第一次写入才失败——那时已经在处理
 *    用户请求了。
 * 3. `task.recover()`：回收租约过期的 `running` 任务（§10.4 的启动扫描）。
 * 4. `warnIfVectorsMissing()`：`retrieval.engine` 含向量时，存量记忆没有向量就提醒
 *    一次（监听之后由后台回填补齐，见 `startVectorBackfill`；`pnpm reindex` 是手工入口）。
 *
 * ## 优雅退出为什么需要超时兜底
 *
 * `app.close()` 等的是「在途请求全部结束」。一个卡住的请求（模型 120 秒超时、客户端
 * 半开连接）会让进程永不退出，Kubernetes 只能 SIGKILL 之后再收拾。10 秒后强退，
 * 把「优雅但可能不完成」换成「确定会结束」。
 */

import { pathToFileURL } from 'node:url';

import { startHttpServer } from '../api/http/server.js';
import {
  documentsMissingVectors,
  embedMissingNodes,
  hasDocumentsMissingVectors,
} from '../commands/reindex.js';
import type { Logger } from '../domain/log.js';
import { MILLISECONDS_PER_SECOND } from '../domain/time.js';

import { assertDataDirWritable, createContainer, type Container } from './container.js';

/**
 * 优雅退出的超时：10 秒。
 *
 * 经验值，来源未知：架构文档没给。取值依据是「够一个正常请求收尾，又短到编排系统
 * 的默认 grace period（K8s 30 秒）之前能结束」。超过它的请求本来就会被客户端放弃。
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** 优雅退出时要按序关闭的组件。生产传容器里的实例，测试传替身。 */
export interface ShutdownTargets {
  readonly server: { close(): Promise<void> };
  readonly commitRunner: { stop(): Promise<void> };
  /**
   * 后台的存量向量回填；没有启动时省略。
   *
   * 它写 `node_embedding`，所以必须在 `container.close()` 关数据库之前停下。
   * `stop()` 先发中止信号（在途的供应商请求会被取消）再等当前批次收尾。
   */
  readonly backfill?: { stop(): Promise<void> };
  readonly container: { close(): Promise<void> };
  readonly logger: Logger;
}

/**
 * 关闭序列：停收新请求 → 停在途任务 → 停后台回填 → 关容器（调度器 / 执行器 /
 * 数据库）→ 记最后一行 → 等日志队列落盘。
 *
 * **顺序不能换**：
 * - 先关 HTTP 再关数据库：反过来的话在途请求会撞上已关闭的连接，错误从「服务
 *   不可用」变成「内部错误」。
 * - `flush` 必须是最后一步：前面每一步都可能写日志（停调度器、关数据库），提前
 *   flush 只能保证那一刻之前的行落盘，后面的照样丢。
 * - `flush` 之后不再调用 `logger`：那句日志自己也没有落盘机会。
 *
 * `flush` 是 `Logger` 的可选方法：`ConsoleLogger` 同步写、`NullLogger` 丢弃，都不
 * 需要实现它。
 */
export async function shutdownGracefully(
  targets: ShutdownTargets,
  signal: NodeJS.Signals,
): Promise<void> {
  await targets.server.close();
  await targets.commitRunner.stop();
  // 回填在 `container.close()` 之前停：`db.close()` 之后它再写 `node_embedding` 会抛。
  await targets.backfill?.stop();
  await targets.container.close();
  targets.logger.info('CoMem 已退出。', { signal });
  await targets.logger.flush?.();
}

/**
 * 启动时提醒「存量记忆没有向量」。
 *
 * 把 `retrieval.engine` 从 `fts5` 改成 `vector` / `hybrid`（或第一次配好嵌入供应商）
 * 之后，旧记忆的正文没有嵌过，向量检索对它们一条都命中不了——用户看到的现象是
 * 「切了引擎之后老记忆全搜不到了」。补齐由监听之后的后台回填（`startVectorBackfill`）
 * 自动做，这一行 warn 让人知道「补齐之前搜不全」；`pnpm reindex` 是手工入口。
 *
 * 「什么算缺向量」的查询在 `commands/reindex.ts` 的 `hasDocumentsMissingVectors`，
 * 与后台回填的候选集（`documentsMissingVectors`）共用同一份 SQL 谓词（目录行、
 * 空正文、`model` / `content_digest` 对不上的旧向量）——写在这里会让 `main` 出现
 * 第二份口径。
 *
 * 只在 `retrieval.engine` 含向量且配了嵌入供应商时查；`fts5` 部署一次都不查。
 */
export function warnIfVectorsMissing(
  target: Pick<Container, 'config' | 'logger' | 'db'>,
): void {
  const { config, logger, db } = target;
  if (config.retrieval.engine === 'fts5') {
    return;
  }
  const embeddingConfig = config.providers.embedding;
  // `retrieval.engine` 不是 `fts5` 时配置校验已经要求嵌入供应商可用；这里再判一次
  // 是因为「没配嵌入」的部署里 `node_embedding` 表根本没有建，查它会报 no such table。
  if (embeddingConfig.type === 'disabled') {
    return;
  }
  if (!hasDocumentsMissingVectors(db, embeddingConfig.model)) {
    return;
  }
  logger.warn(
    '向量检索已启用，但存量记忆里还有节点没有向量：补齐之前这些记忆用向量检索搜不到。服务会在后台自动补齐（进度见日志），也可以跑 `pnpm reindex` 手工重建。',
    {
      engine: config.retrieval.engine,
      model: embeddingConfig.model,
      dimension: embeddingConfig.dimension,
    },
  );
}

/** 后台回填的句柄。`runMain` 把它交给关闭序列，测试用它等一个确定的完成点。 */
export interface VectorBackfillHandle {
  /** 回填结束（完成 / 中止 / 出错都算）后 resolve。从不 reject。 */
  readonly done: Promise<void>;
  /** 中止并等它真的停下；重复调用安全。 */
  stop(): Promise<void>;
}

/**
 * 每个容器最多一个在跑的回填。
 *
 * 键是容器而不是模块级单值：一个进程只有一个容器，所以效果就是进程内互斥（第二次
 * 启动没有意义，回填是幂等的，重复跑只是白扫一遍）；而测试里每个用例一份容器，
 * 不会被上一个用例已经在跑的 Promise 挡住。
 */
const backfills = new WeakMap<Container, VectorBackfillHandle>();

/**
 * 在监听之后启动存量向量回填（**不 await**）。
 *
 * 触发点只能在这里：`createContainer` 不知道 HTTP 什么时候就绪，而回填要读盘、打
 * 供应商，放到监听之前等于让「服务可用」等存量的大小。
 *
 * 关闭走 `ShutdownTargets.backfill`：`stop()` 中止在途的供应商调用并等当前批次收尾，
 * 之后 `container.close()` 才关数据库。
 *
 * ## 跨进程并发：不加锁，靠「单进程部署」这个既有假设
 *
 * 同一个 `dataDir` 起两个服务端进程本来就不在支持范围内（`docs/operations.md` 的已知
 * 限制「同一个 `dataDir` 只支持一个服务端进程」：会话轮次时钟、幂等索引、对账队列都是
 * 进程内状态）。仓库里唯一的跨进程锁是内容路径锁（`adapters/fs/lock.ts`，按 URI 保护
 * 文件写），它保护的是「谁在写这个节点」，覆盖不了「谁在给这个节点写向量」；任务租约
 * 只用于阶段二任务，也不提供数据根级的互斥。
 *
 * 所以这里**不新增**跨进程锁。两个进程同时回填的后果：`vec0` 没有 compare-and-set，
 * 两个进程各用自己读到的正文各自 `DELETE + INSERT`，最后写入者赢。不会写坏行（行里的
 * 摘要与向量由同一次读盘产出），但两次写入之间可能出现「向量对应 A、摘要对应 B」的
 * 短暂状态——前提是同一份文件在两次读盘之间被改了；下一次回填 / `pnpm reindex` 按磁盘
 * 重算会修正它，因为两者的输入都是磁盘正文，不是旧向量。
 */
export function startVectorBackfill(container: Container): VectorBackfillHandle {
  const running = backfills.get(container);
  if (running !== undefined) {
    return running;
  }
  const abort = new AbortController();
  // 回填自己处理每个节点的失败；走到这里的是全局故障（磁盘满、表被外部改坏）。
  // 记 error 后照常 resolve：启动不应该因为回填失败而挂掉，`done` 也从不对调用方抛。
  const done = backfillMissingVectors(container, abort.signal).catch((error: unknown) => {
    container.logger.error('存量向量回填中断：已补齐的保留，剩下的下次启动再补。', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const handle: VectorBackfillHandle = {
    done,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
  backfills.set(container, handle);
  return handle;
}

/**
 * 把「切到 `vector` / `hybrid` 之前就存在、从来没有嵌过」的记忆补上向量。
 *
 * 候选集是 `documentsMissingVectors` 的 SQL 存在性判定（与 `warnIfVectorsMissing`
 * 共用同一份谓词），所以「没事可做」的启动只多一次 `NOT EXISTS` 扫描；正文与摘要
 * 仍然由 `embedMissingNodes` 从磁盘读。
 *
 * **失败处理是「记 warn、跳过、继续下一批」。** 理由：
 * 1. `EmbeddingService` 已经有熔断（连续 5 次失败后短路 30 秒）。供应商真挂了，
 *    继续下一批只是让每个批次立即降级，不会猛打请求；停下来反而让「恢复之后要
 *    重启一次才继续补」变成新的运维动作。
 * 2. 证书 / 坏文件这类单节点故障是终局的：一旦「第一个失败就停」，一个读不出来的
 *    文件会让它后面所有记忆永远没有向量，而每次启动都从它开始从头失败。
 * 3. 进度是批级的、幂等的：下一次启动重新查一遍，只补还没补上的那些。
 *
 * `fts5` 部署与未配置嵌入时一次都不查库：没有 `node_embedding` 表的库查它会报
 * no such table（与 `warnIfVectorsMissing` 同一约定）。
 */
async function backfillMissingVectors(container: Container, signal: AbortSignal): Promise<void> {
  const { config, logger, db } = container;
  if (config.retrieval.engine === 'fts5') {
    return;
  }
  const embeddingConfig = config.providers.embedding;
  if (embeddingConfig.type === 'disabled') {
    return;
  }

  const { store, embeddings, embedding } = container.vectorBackfill;
  const model = embedding.model;
  if (model === null) {
    return;
  }

  const uris = documentsMissingVectors(db, model);
  if (uris.length === 0) {
    return;
  }
  logger.info('存量节点没有向量，开始在后台补齐。', {
    engine: config.retrieval.engine,
    model,
    missing: uris.length,
  });

  const result = await embedMissingNodes(uris, {
    store,
    embeddings,
    embedding,
    logger,
    signal,
    // 一批 = 供应商的一次调用（服务内部还会按同一上限再切片，见 `EmbeddingService`）。
    batchSize: embedding.maxBatchSize,
    onBatch: (progress) => {
      logger.info('向量回填进度。', {
        embedded: progress.embedded,
        skipped: progress.skipped,
        failed: progress.failed,
        remaining: progress.remaining,
        total: uris.length,
      });
    },
  });

  logger.info(result.aborted ? '存量向量回填已中止（进程正在退出）。' : '存量向量回填完成。', {
    embedded: result.embeddedUris.length,
    skipped: result.skipped,
    failed: result.failedUris.length,
    aborted: result.aborted,
  });
}

/**
 * 启动服务，等待退出信号。
 *
 * `argv` 默认取进程参数：`loadConfig` 只识别 `--config` 与 `--data-dir`（§18），
 * 其它参数被忽略而不是报错——`pnpm dev -- --config x.yaml` 里的 `--` 也会落到
 * 这里。
 */
export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const container = await createContainer({ argv });
  const { logger, config } = container;

  // 启动自检。任一步失败都让进程带非零码退出——一个「起来了但索引是空的」服务比
  // 起不来更难查。
  container.mcpRegistry.validate();
  await assertDataDirWritable(config.dataDir);

  const recovered = container.services.task.recover();
  logger.info('启动扫描完成。', {
    recovered,
    note: recovered === 0 ? '没有需要回收的任务。' : '租约过期的任务已回到 pending。',
  });

  // 索引双写补偿的启动重放（§10.6）：文件已经落盘但索引 / 权限没写成时，先把派生
  // 数据追上来再开始服务。放在监听之前——重放会写索引与 `node_permission`，与用户
  // 请求并发时会在 SQLite 写事务上排队；而且监听之后再修意味着第一批请求可能读到
  // 「文件在、检索不到」的旧状态。代价是一次日志读取 + 每条记录一次 upsert，
  // 记录为 0 时只是一次 `readFile` 的 ENOENT。
  await container.services.reconcile.replay();

  // 重放会把「文件已落盘但索引没写成」的节点补进 `node`，所以探测放在它之后：
  // 补进来的节点同样没有向量，先查会漏掉它们。
  warnIfVectorsMissing(container);

  // 阶段二执行器（§10.1、§10.4）：`recover()` 之后再启动，回收出来的任务第一轮
  // 就会被认领。没有它，`commit` 建的归档任务永远停在 `pending`。
  container.commitRunner.start();

  const server = await startHttpServer({
    config,
    logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
  logger.info('CoMem 已启动', { url: server.url, dataDir: config.dataDir });

  // 存量向量回填：监听之后启动，不等它。`fts5` / 未配置嵌入时它立即返回（一次库都
  // 不查），所以这里不需要再判一遍引擎。
  const backfill = startVectorBackfill(container);

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('收到退出信号，正在关闭。', { signal });

    // 兜底：超时强退。`unref()` 让这个定时器不阻止进程正常结束。
    const timer = setTimeout(() => {
      logger.error('优雅退出超时，强制退出。', {
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
        timeoutSeconds: SHUTDOWN_TIMEOUT_MS / MILLISECONDS_PER_SECOND,
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    void (async () => {
      try {
        // 先停收新请求（`app.close()`），再停在途提交任务，最后关数据库：反过来的
        // 话在途请求会撞上已关闭的连接，错误从「服务不可用」变成「内部错误」。
        // `container.close()` 里也会 `stop()`，两处都调要幂等（它确实幂等）。
        //
        // 最后一行日志与 `flush` 在 `shutdownGracefully` 里：flush 之后不再打日志，
        // 否则那一行会留在写队列里随进程退出丢掉。
        await shutdownGracefully(
          {
            server,
            commitRunner: container.commitRunner,
            backfill,
            container,
            logger,
          },
          signal,
        );
        process.exit(0);
      } catch (error) {
        logger.error('关闭失败，强制退出。', {
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
        // 关闭序列中途失败时也尽力把已排队的日志写出去；失败原因已经记过，这里
        // 不再覆盖退出码。
        await logger.flush?.();
        process.exit(1);
      }
    })();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * 作为入口执行时启动服务。
 *
 * `runMain` 是导出的（测试要能直接调），所以不能让模块一被 import 就起服务——
 * 那样任何 `import './main.js'` 的测试都会占住端口。判断方式是「`process.argv[1]`
 * 指向本文件」，`tsx` 与 `node dist/...` 都走这条路径。
 *
 * **不写这个判断的后果**：`pnpm dev` 静默退出，日志里只有一行启动命令，没有任何
 * 报错。`pnpm test` 全绿、`pnpm verify` 全绿，只有真的把服务跑起来才会发现。
 */
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runMain().catch((error: unknown) => {
    // 启动阶段的错误还没有 logger（容器可能没建成），只能走 stderr。
    process.stderr.write(`CoMem 启动失败：${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
