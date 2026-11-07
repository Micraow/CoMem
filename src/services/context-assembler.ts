/**
 * 上下文组装的端口实现（架构文档 §8.6）。
 *
 * `domain/assembly.ts` 的 `assembleContext` 是**纯编排**：它只回答「给多少、给多细、
 * 重复几次」，读文件的动作通过 `AssemblyPorts` 注入。本文件实现这两个读方法，并把
 * `skeletonOverview` 接进降级链。
 *
 * ## 三层各挡什么
 *
 * | 层 | 挡的失败 | 手段 |
 * |---|---|---|
 * | `assembly.ts` | 预算、分层、去重、配额 | 纯逻辑，可用假数据穷举 |
 * | 本文件 | 真实文件 IO：权限、fd 上限、摘要缺失 | 有界并发 + 逐 URI 记忆化 |
 * | `MetadataFileStore` | 字节怎么安全落盘 | 原子写 |
 *
 * 并发上限不是「防御性编程」：一次组装最多几十个候选，`Promise.all` 会把它们全部
 * 同时发出去，每个文件占的 fd 不止一个（`open` + `stat`），同一进程还有 SQLite、
 * 日志、socket 在抢（`local/notes/comparison.md` 第 1 条）。
 *
 * ## 权限
 *
 * 两个读方法都先过 `authorizer.check(uri, read)`。候选来自索引，索引侧已经按
 * `node_permission` 过滤过（§8.2），但**组装层不能依赖索引实现的自觉**——§12.4 的
 * 出口清单里 `abstract` / `overview` 与 `read` 同级，漏一个就是泄露。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import {
  assembleContext,
  type AssemblyCandidate,
  type AssemblyOptions,
  type AssemblyPorts,
  type AssemblyResult,
} from '../domain/assembly.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { skeletonOverview } from '../domain/summary.js';
import { Uri } from '../domain/uri.js';

import type { AclAction, Authorizer } from './authorizer.js';

/** §12.1：read = 1。概览与原文都只需要 read。 */
const READ: AclAction = 1;

/**
 * 默认并发上限（`local/notes/comparison.md` 第 1 条）。
 *
 * 8：经验值，来源未知。与 `domain/assembly.ts` 的 `READ_CONCURRENCY` 取同一个数，
 * 但两者挡的不是同一层：那边是「同时发起多少个读」，这边是「同时打开多少个文件
 * 描述符」。8 足够把 IO 延迟藏在其它条目的计算后面，又不会让 fd 数量失控。
 */
const DEFAULT_READ_CONCURRENCY = 8;

/**
 * 字符数 → token 数的默认估算：`Math.ceil(length / 4)`。
 *
 * 4：经验值，来源未知（英文约 4 字符/token 的常见估计）。中文按 1–2 字符/token，
 * 这个估算会**低估**中文预算，所以生产装配应该注入真实的 tokenizer（`domain/ranking.ts`
 * 的 `TokenEstimator` 就是为此留的注入点：不同模型的分词器不一样，领域层不硬编码）。
 */
const CHARS_PER_TOKEN = 4;

/** 1 毫秒 = 1e6 纳秒，用于把 `hrtime` 差值换算成毫秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export interface ContextAssemblerDeps {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly authorizer: Authorizer;
  readonly logger: Logger;
  /** 读原文的并发上限，默认 8（`assembly.ts` 内部也有一层；这里挡的是文件 IO） */
  readonly readConcurrency?: number;
  /** token 估算，默认按 4 字符/token 近似 */
  readonly estimateTokens?: (text: string) => number;
}

/**
 * 一次 `assemble` 内的读缓存。缓存的是 **Promise**：并发的两次读同一个 URI 会被
 * 合并成一次 IO，而不仅是「第二次命中缓存」。
 */
interface ReadCache {
  readonly overview: Map<string, Promise<string | null>>;
  readonly body: Map<string, Promise<string | null>>;
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 有界并发信号量。
 *
 * 直接在 `ports` 的每个读方法上取许可，而不是在外面套一层 `mapWithConcurrency`：
 * 调用方（`assembly.ts` 的升级轮次）自己决定并发形态，这一层只保证「同时打开的
 * 文件描述符不超过上限」。
 */
class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    // 直接把手上的许可交给下一个等待者，不先加回去再减——否则 `#available` 在
    // 「唤醒」与「新来者抢许可」之间会出现一个虚假的可用位。
    if (next === undefined) {
      this.#available += 1;
      return;
    }
    next();
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
}

export class ContextAssembler {
  readonly #store: ContentStore;
  readonly #metadata: MetadataFileStore;
  readonly #authorizer: Authorizer;
  readonly #logger: Logger;
  readonly #estimateTokens: (text: string) => number;
  readonly #semaphore: Semaphore;

  /**
   * 给外部直接用的端口。不做跨调用缓存：概览与原文都会随写入变化，长期缓存等于
   * 返回过期内容。`assemble` 走的是每次新建的那一份（见 `assemble`）。
   */
  readonly ports: AssemblyPorts;

  constructor(deps: ContextAssemblerDeps) {
    const concurrency = deps.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ComemError('INVALID_ARGUMENT', 'readConcurrency 必须是正整数。', {
        readConcurrency: concurrency,
      });
    }

    this.#store = deps.store;
    this.#metadata = deps.metadata;
    this.#authorizer = deps.authorizer;
    this.#logger = deps.logger;
    this.#estimateTokens = deps.estimateTokens ?? defaultEstimateTokens;
    this.#semaphore = new Semaphore(concurrency);

    this.ports = {
      readOverview: (uri) => this.#readOverview(uri, null),
      readBody: (uri) => this.#readBody(uri, null),
      estimateTokens: this.#estimateTokens,
      logger: this.#logger,
    };
  }

  /**
   * 便捷入口：拿候选 → 组装 → 返回结果。
   *
   * 缓存的作用域是一次调用：`assembleContext` 内部也会记忆化，两层都留是因为
   * 那一层是纯逻辑的（它不知道一次读有多贵），这一层挡的是真实 IO。任何一层被
   * 绕过，另一层都还能把重复读挡掉。
   */
  async assemble(
    candidates: readonly AssemblyCandidate[],
    options: AssemblyOptions,
  ): Promise<AssemblyResult> {
    const cache: ReadCache = { overview: new Map(), body: new Map() };
    const ports: AssemblyPorts = {
      readOverview: (uri) => this.#readOverview(uri, cache),
      readBody: (uri) => this.#readBody(uri, cache),
      estimateTokens: this.#estimateTokens,
      logger: this.#logger,
    };
    return assembleContext(candidates, options, ports);
  }

  /**
   * 读 L1 概览：先看摘要文件，没有再拿「标题树 + 首段」合成。
   *
   * 摘要文件里的 L1 是别人（模型或规则）压缩过的概览，质量高于骨架；骨架是
   * 「摘要还没生成」时的降级产物，不是替代品。两者都拿不到（正文也读不到）返回
   * `null`，由 `assembly.ts` 继续降到 L0 摘要。
   */
  async #readOverview(value: string, cache: ReadCache | null): Promise<string | null> {
    const memoized = cache?.overview.get(value);
    if (memoized !== undefined) {
      return memoized;
    }
    const pending = this.#loadOverview(value);
    cache?.overview.set(value, pending);
    return pending;
  }

  async #loadOverview(value: string): Promise<string | null> {
    const startedAt = process.hrtime.bigint();
    const uri = Uri.tryParse(value);
    if (uri === null) {
      // 索引里不该出现非法 URI；出现了也只影响这一条，不打断整次组装。
      this.#logger.warn('检索候选的 URI 无法解析，概览按缺失处理', { uri: value });
      return null;
    }

    const allowed = await this.#authorizer.check(uri, READ);
    if (!allowed) {
      this.#logger.debug('概览读取无权限', {
        uri: value,
        detail: 'overview',
        durationMs: elapsedMs(startedAt),
      });
      return null;
    }

    // 摘要是**目录级**文件（`.overview.md` 是保留名，不能作为普通路径段）。
    //
    // 候选可能是目录也可能是文件：目录读自己的 `.overview.md`，文件那条路径下没有
    // 摘要文件（`a.md/.overview.md` 必然 ENOENT），落到下面的骨架降级。**不能**改成
    // 读父目录——那样同一目录下所有文件会拿到同一段 L1 正文，§8.6 的去重会把它们
    // 判成重复，只留分数最高的一条，其余全部丢弃。
    const summary = await this.#metadata.readSummary(uri);
    if (summary.overview !== '') {
      this.#logger.debug('概览命中摘要文件', {
        uri: value,
        detail: 'overview',
        degraded: false,
        durationMs: elapsedMs(startedAt),
      });
      return summary.overview;
    }

    const body = await this.#readText(uri);
    if (body === null) {
      this.#logger.debug('概览与原文都读不到', {
        uri: value,
        detail: 'overview',
        degraded: true,
        durationMs: elapsedMs(startedAt),
      });
      return null;
    }

    const skeleton = skeletonOverview(body);
    this.#logger.debug('概览降级为骨架', {
      uri: value,
      detail: 'overview',
      degraded: true,
      chars: skeleton.length,
      durationMs: elapsedMs(startedAt),
    });
    return skeleton === '' ? null : skeleton;
  }

  /** 读 L2 原文。读不到（不存在、是目录、无权限）返回 `null`，不抛错。 */
  async #readBody(value: string, cache: ReadCache | null): Promise<string | null> {
    const memoized = cache?.body.get(value);
    if (memoized !== undefined) {
      return memoized;
    }
    const pending = this.#loadBody(value);
    cache?.body.set(value, pending);
    return pending;
  }

  async #loadBody(value: string): Promise<string | null> {
    const startedAt = process.hrtime.bigint();
    const uri = Uri.tryParse(value);
    if (uri === null) {
      this.#logger.warn('检索候选的 URI 无法解析，原文按缺失处理', { uri: value });
      return null;
    }

    const allowed = await this.#authorizer.check(uri, READ);
    if (!allowed) {
      this.#logger.debug('原文读取无权限', {
        uri: value,
        detail: 'full',
        durationMs: elapsedMs(startedAt),
      });
      return null;
    }

    const text = await this.#readText(uri);
    this.#logger.debug('读取原文', {
      uri: value,
      detail: 'full',
      found: text !== null,
      chars: text?.length ?? 0,
      durationMs: elapsedMs(startedAt),
    });
    return text;
  }

  /**
   * 真实的一次文件读，受并发上限约束。
   *
   * 只吞 `ComemError`：`NOT_FOUND`（不存在）与 `INVALID_ARGUMENT`（目标是目录）
   * 都是「这条候选没有原文」，属于正常降级。其余异常是程序缺陷，不能悄悄变成
   * 「没有原文」——那会让整次组装看起来正常，实际少了一半条目。
   */
  async #readText(uri: Uri): Promise<string | null> {
    try {
      const document = await this.#semaphore.run(() => this.#store.readText(uri));
      return document.text;
    } catch (error) {
      if (error instanceof ComemError) {
        return null;
      }
      throw error;
    }
  }
}
