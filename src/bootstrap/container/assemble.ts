/**
 * 容器装配入口（架构文档 §4.4、§18、§6.5）。
 *
 * 整个后端只有这一处 `new` 适配器：`services/` 只允许 `import type` 引用适配层，
 * 运行期实例全部由 `container/` 下的阶段工厂构造并注入。装配顺序不是风格问题——
 * 每一步都可能被后一步依赖，顺序错了拿到的就是 `undefined`。
 *
 * ## 构造顺序
 *
 * ```
 * 配置 → 日志 → 数据库/迁移 → 适配器/仓储        （foundation）
 *      → 模型 / 嵌入 / 重排                      （models）
 *      → IdentityService → AclService → 命名空间 （access）
 *      → Summary → ContextAssembler → IndexObserver → FileSystemService
 *      → SearchService → TaskService → SessionService   （retrieval）
 *      → MemoryService → Consolidation → Resource → Reconcile → Skill （memory）
 *      → CommitRunner → TtlService → Scheduler → Observability    （background）
 *      → MCP → HTTP 路由                          （api）
 * ```
 *
 * 三处顺序容易踩：
 *
 * 1. **`TaskService` 必须在 `SessionService` 之前**：阶段一提交要建任务。
 * 2. **`IndexObserver` 必须在 `FileSystemService` 之前**：后者要 observers 数组。
 *    `SearchService` 又在 `FileSystemService` 之后——它的 `grep` 要读文件。
 * 3. **`AclService` 最先**：`FileSystemService` / `SearchService` / `ContextAssembler`
 *    的构造参数都是 `Authorizer`。
 *
 * `CommitRunner` 在 `MemoryService` 之后：五个步骤要用 `MemoryService`（预取、读写、
 * 删除）与 `SummaryService`（归档摘要、失效传播），构造位置比它们早只会拿到
 * `undefined`。
 *
 * ## 阶段之间只传值
 *
 * 每个阶段是一个纯工厂：收已构造好的前置对象，返回自己产出的对象。没有模块级可变
 * 状态，也没有阶段之间共享的 `let`。两个真实的前向引用（`userNamespace → acl`、
 * `createPipeline → observability`）留在同一函数作用域里，保持原来的求值时机。
 *
 * ## 没有循环依赖
 *
 * `IndexObserver` 不需要 `FileSystemService`（它直接用 `ContentStore`），所以
 * 「文件系统要观察者、观察者要摘要/ACL/索引」不构成环。`MemoryService` 的端口是
 * 「原样文档」，不能接 `FileSystemService`（后者会重新序列化 frontmatter），所以它
 * 直接用 `ContentStore` 的字节读写，并在写后手动通知观察者。
 */

import { createAccess } from './access.js';
import { createApi } from './api.js';
import { createBackground } from './background.js';
import { createFoundation } from './foundation.js';
import { createMemory } from './memory.js';
import { createModels } from './models.js';
import { createRetrieval } from './retrieval.js';
import type { Container, CreateContainerOptions } from './types.js';

/**
 * 构造整个后端。
 *
 * `await` 只用于启动自检（建目录、迁移、预置命名空间）；其余服务构造都是同步的。
 * 异步是为了给未来的异步适配器留接口，不是现在需要。
 */
export async function createContainer(
  options: CreateContainerOptions = {},
): Promise<Container> {
  const foundation = createFoundation(options);
  const models = createModels(foundation);
  const access = await createAccess(foundation, options);
  const retrieval = createRetrieval(foundation, models, access);
  const memoryStack = createMemory(foundation, models, access, retrieval);
  const background = createBackground(foundation, models, retrieval, memoryStack);
  const api = createApi(foundation, access, retrieval, memoryStack, background);

  const { config, logger, db, store, embeddings } = foundation;
  const { embedding } = models;
  const { commitRunner, scheduler, observability } = background;
  const { mcpRegistry, mcp, routes, resolveIdentity, services } = api;
  const { indexObserver } = retrieval;

  let closed = false;
  return {
    config,
    logger,
    db,
    vectorBackfill: { store, embeddings, embedding },
    observability,
    commitRunner,
    scheduler,
    services,
    mcpRegistry,
    mcp,
    routes,
    resolveIdentity,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      // 先停调度器：它会写 `.meta.json`（归档）、删会话目录、建归档任务。
      await scheduler.stop();
      // 再停在途提交任务：它们调模型、写归档与记忆，`db.close()` 之后写库会抛。
      // 与 `main.ts` 的退出路径都调 `stop()`，所以它必须幂等（它确实幂等）。
      await commitRunner.stop();
      // 再等后台的摘要失效跑完：`db.close()` 之后它们写库会抛。
      await indexObserver.drain();
      db.close();
      logger.info('数据库连接已关闭。');
    },
  };
}
