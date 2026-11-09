/**
 * 进程入口（架构文档 §18、§17.7、§10.4）。
 *
 * 这里只做四件事：装配容器、跑启动自检、起 HTTP、接退出信号。**没有业务逻辑**——
 * 一旦入口里出现「顺便做点什么」，它就成了第二个编排层，而测试永远只覆盖得到
 * 容器里的那一份。
 *
 * ## 启动自检
 *
 * 1. `mcpRegistry.validate()`：16 个工具的数量 / 重名 / 白名单（AGENTS.md 的硬约束）。
 *    演示时才发现多注册一个工具，代价比启动时崩掉大得多。
 * 2. 数据根可写：只读数据根时服务能起来，但第一次写入才失败——那时已经在处理
 *    用户请求了。
 * 3. `task.recover()`：回收租约过期的 `running` 任务（§10.4 的启动扫描）。
 *
 * ## 优雅退出为什么需要超时兜底
 *
 * `app.close()` 等的是「在途请求全部结束」。一个卡住的请求（模型 120 秒超时、客户端
 * 半开连接）会让进程永不退出，Kubernetes 只能 SIGKILL 之后再收拾。10 秒后强退，
 * 把「优雅但可能不完成」换成「确定会结束」。
 */

import { pathToFileURL } from 'node:url';

import { startHttpServer } from '../api/http/server.js';

import { assertDataDirWritable, createContainer } from './container.js';

/**
 * 优雅退出的超时：10 秒。
 *
 * 经验值，来源未知：架构文档没给。取值依据是「够一个正常请求收尾，又短到编排系统
 * 的默认 grace period（K8s 30 秒）之前能结束」。超过它的请求本来就会被客户端放弃。
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** 1 秒 = 1000 毫秒；日志里换算成秒更直观。 */
const MILLISECONDS_PER_SECOND = 1000;

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
        await server.close();
        await container.commitRunner.stop();
        await container.close();
        logger.info('CoMem 已退出。', { signal });
        process.exit(0);
      } catch (error) {
        logger.error('关闭失败，强制退出。', {
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
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
