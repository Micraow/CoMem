/**
 * 节点写入后的索引维护（Observer 模式，架构文档 §9.3、§12.3）。
 *
 * `FileSystemService` 是内容的唯一写入口，`node` / `node_fts` / `node_permission` 都是
 * 派生数据（§7：文件是真相，索引是派生）。节点落盘后必须通知它们，否则「写成功了
 * 但读不到」。三件事按固定顺序执行：
 *
 * 1. **写检索索引**（`write.ts`）——不写检索看不到；
 * 2. **物化权限**（`permissions.ts`）——不物化则默认 deny，节点对所有人不可见；
 * 3. **摘要失效**（`summary.ts`）——正文变了，父目录摘要要重算。
 *
 * 两条后台链路也挂在这里：写失败的对账记录（`replay.ts`）与嵌入批次
 * （`embedding.ts`）。这个类只保留**编排**与需要跨文件汇合的可变状态（待完成的
 * 摘要 / 嵌入任务、嵌入队列），各步的实现都在同目录的模块里。
 *
 * 物化要在索引之后：`materializeNode` 从 `node` 表读 kind 决定链的起点。摘要失效
 * 必须在两者之后，且用 `markStale` 而不是 `invalidate`（原因见 `summary.ts`）：
 * 等它被调用时索引里已经是新的 `body_digest`，`invalidate` 的比较必然相等，整条
 * 传播链会被静默跳过。
 *
 * `onNodeWritten` 再自己 try/catch 的目的不是兜底（`FileSystemService` 已经捕获
 * 了异常），而是让日志能定位到 URI——上层只有一个「观察者失败」的泛化消息，串不起
 * 是哪条路径。文件已经落盘，回滚反而丢数据；派生数据靠对账修复（§7）。
 */

import { stableDigest } from '../../domain/node.js';
import type { Uri } from '../../domain/uri.js';

import type { NodeWriteObserver } from '../filesystem.js';
import { embedRecords, type PendingEmbedding } from './embedding.js';
import { moveNodeDerived, removeNodeDerived } from './events.js';
import { materializeAncestors, materializePermission } from './permissions.js';
import { errorMessage } from '../../domain/errors.js';

import type { IndexObserverDeps } from './ports.js';
import { markSummaryStale } from './summary.js';
import { writeNodeIndex } from './write.js';

/** 嵌入队列的合并窗口，毫秒。窗口的职责与 50 毫秒的来源见 `embedding.ts`。 */

const EMBED_COALESCE_MS = 50;

export class IndexObserver implements NodeWriteObserver {
  readonly #ports: IndexObserverDeps;
  /** 已排期但未完成的摘要失效 / 嵌入任务（见 `summary.ts` 的「延后」）。 */
  readonly #pending = new Set<Promise<void>>();
  /** 等待 flush 的嵌入记录。见 `#scheduleEmbedding`。 */
  readonly #embedQueue: PendingEmbedding[] = [];
  /** 合并窗口的定时器；`drain()` 会提前触发它。 */
  #embedTimer: NodeJS.Timeout | null = null;
  /** 正在跑的 flush；同一时刻只有一个（见 `#startEmbeddingFlush`）。 */
  #embedFlush: Promise<void> | null = null;

  constructor(deps: IndexObserverDeps) {
    // 拷贝一份：调用方之后修改自己的依赖对象，不影响已经构造的观察者。
    this.#ports = { ...deps };
  }

  async onNodeWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    try {
      await this.#indexNode(uri, kind);
      await materializeAncestors(this.#ports, uri);
    } catch (error) {
      // 写操作已经成功，异常不能往上传（§7：文件是真相）。索引写失败与权限物化
      // 失败分别由 `write.ts` / `permissions.ts` 记了对账记录（重放器都能修）；
      // 走到这里的是**读盘失败**——连 `IndexRecord` 都构造不出来，重放同样没有
      // 输入，只能留日志。
      this.#ports.logger.error('节点写入后维护派生数据失败，已忽略。', {
        uri: uri.toString(),
        kind,
        error: errorMessage(error),
      });
    }
  }

  async onNodeRemoved(uri: Uri): Promise<void> {
    for (const parent of await removeNodeDerived(this.#ports, uri)) {
      // 删子项同样是「父目录的 L0 变了」，摘要要重算（延后到锁释放后）。
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /**
   * 移动 / 改名后的派生数据重建（实现见 `events.ts`）。
   *
   * `FileSystemService.move` 只调这一个通知。分两次通知时子项一条都不会重建：
   * 删除把整棵子树的派生行删掉，写入只写回目标节点自己。目标是重建整棵子树，
   * 摘要失效只投给源与目标的父目录。
   */
  async onNodeMoved(from: Uri, to: Uri): Promise<void> {
    for (const parent of await moveNodeDerived(this.#ports, from, to)) {
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /**
   * 等全部已排期的摘要失效与嵌入完成。
   *
   * 测试要一个确定点（写完之后摘要到底是「已重算」还是「已标脏」）；`close()` 要它
   * 来保证 `db.close()` 之后没有任务还在写库。
   *
   * **嵌入队列的契约**：返回时队列已空，每个排队项要么写进了 `node_embedding`，
   * 要么已降级（记了日志）。所以这里要**提前触发**合并窗口，而不是等 50 毫秒。
   * 循环里再触发一次是因为 `await` 期间可能又有新的写入进队列。
   */
  async drain(): Promise<void> {
    for (;;) {
      this.#flushEmbeddingsNow();
      if (this.#pending.size === 0) {
        return;
      }
      await Promise.all([...this.#pending]);
    }
  }

  async #indexNode(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    const record = await writeNodeIndex(this.#ports, uri, kind);
    if (record === null) {
      return;
    }

    // 物化要在索引之后：`materializeNode` 从 `node` 表读 kind 决定链的起点。
    await materializePermission(this.#ports, uri);

    // 嵌入是派生数据的派生（§7）：正文变了才重算，且推到锁释放之后（见
    // `summary.ts` 的「为什么延后」——嵌入要打网络，更不能在锁里做）。
    if (kind === 'file') {
      this.#scheduleEmbedding(uri, record.content);
    }

    // 摘要失效的目标是父目录：新增 / 修改一个子项（文件或目录）都会改变父目录的 L1
    // 输入。根节点没有父目录，但它自己的 L0 也不需要重算（没有上级摘要用它）。
    const parent = uri.parent();
    if (parent !== null) {
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /** 排期一次摘要失效；任务记进 `#pending`，`drain()` 因此能等它。 */
  #scheduleSummaryInvalidation(directory: Uri): void {
    const task = markSummaryStale(this.#ports, directory);
    this.#pending.add(task);
    void task.then(() => {
      this.#pending.delete(task);
    });
  }

  /**
   * 一条记录进嵌入队列。
   *
   * **为什么不在这里直接调模型。** 一次导入是「写一条 → await → 写一条」，
   * 每条各调一次供应商就是「单条 1140ms × N」。集中到 `#flushEmbeddings` 之后，
   * 一个合并窗口里排队的 N 条按 `maxBatchSize` 切成 `ceil(N / maxBatchSize)` 次
   * 请求（见 `EMBED_COALESCE_MS` 与 `embedding.ts`）。
   *
   * **为什么先算 digest。** 它同时承担两件事：`node_embedding` 的「正文没变就
   * 跳过」，以及「同一段正文出现在两个 URI 下只嵌一次」（见 `embedding.ts`）。
   *
   * 没配供应商（`type: disabled`，默认值）时静默跳过：这是「不做语义检索」的
   * 正常配置，不是降级。每次写都记 warn 只会把真正的故障淹掉。
   */
  #scheduleEmbedding(uri: Uri, text: string): void {
    const embedding = this.#ports.embedding;
    const embeddings = this.#ports.embeddings;
    if (embedding === undefined || embeddings === undefined || text === '') {
      return;
    }
    if (embedding.model === null) {
      return;
    }

    this.#embedQueue.push({ uri: uri.toString(), text, digest: stableDigest(text) });
    // 已经有 flush 在跑：`#flushEmbeddings` 的循环会吃掉新到的记录。
    if (this.#embedFlush !== null) {
      return;
    }
    // 攒满一批立刻发。这是「N 条记录 → ceil(N / maxBatchSize) 次请求」的直接
    // 来源；只靠定时器时，一次导入会在窗口边界上切出很多不满的批。
    if (this.#embedQueue.length >= embedding.maxBatchSize) {
      this.#flushEmbeddingsNow();
      return;
    }
    // 不满一批：等合并窗口，把零散写入攒成一批。
    if (this.#embedTimer !== null) {
      return;
    }
    this.#embedTimer = setTimeout(() => {
      this.#embedTimer = null;
      this.#startEmbeddingFlush();
    }, EMBED_COALESCE_MS);
  }

  /**
   * 把合并窗口提前到此刻（`drain()` 用）。
   *
   * 没有排期时是空操作；有排期时取消定时器并立刻开始 flush。
   */
  #flushEmbeddingsNow(): void {
    if (this.#embedTimer !== null) {
      clearTimeout(this.#embedTimer);
      this.#embedTimer = null;
    }
    this.#startEmbeddingFlush();
  }

  /**
   * 启动一次 flush。同一时刻只有一个。
   *
   * 任务进 `#pending`，`drain()` 因此能等它；失败的日志要带得上「哪一批」，所以
   * 这里只兜住「flush 自己抛了」——**单个记录**的失败在 `embedding.ts` 里已经
   * 降级成日志，不会再往上抛。
   */
  #startEmbeddingFlush(): void {
    if (this.#embedFlush !== null || this.#embedQueue.length === 0) {
      return;
    }
    const task = this.#flushEmbeddings();
    this.#embedFlush = task;
    this.#pending.add(task);
    void task.then(
      () => {
        this.#pending.delete(task);
      },
      (error: unknown) => {
        this.#pending.delete(task);
        this.#ports.logger.error('嵌入批次失败，已忽略。', { error: errorMessage(error) });
      },
    );
  }

  /**
   * 排空队列。
   *
   * 循环是必需的：`await` 期间写路径可能继续入队（`#scheduleEmbedding` 看到
   * `#embedFlush !== null` 就不会再开定时器，只能由这里接着吃）。`finally` 里清
   * `#embedFlush` 而不是在 `.then` 里清，是为了让「while 退出」与「允许新 flush」
   * 之间没有 await——否则这段时间入队的记录会永远留在队列里。
   */
  async #flushEmbeddings(): Promise<void> {
    try {
      while (this.#embedQueue.length > 0) {
        const records = this.#embedQueue.splice(0, this.#embedQueue.length);
        await embedRecords(this.#ports, records);
      }
    } finally {
      this.#embedFlush = null;
    }
  }
}
