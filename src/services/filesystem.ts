/**
 * 文件系统服务（架构文档 §5、§10.6、§12.4）。
 *
 * P2 的验收对象：`read` / `write` / `list` / `tree` / `edit` / `mkdir` / `remove` /
 * `move` 八个入口，每个都先求权、再拿路径锁、最后才碰 `ContentStore`。
 *
 * 为什么求权在锁外：权限判定是纯读，先拒绝掉无权请求比先排队再拒绝便宜；为什么锁
 * 在存储外：`edit` 是「读正文 → 应用补丁 → 写回」，中间被别的写者插进来就是丢更新。
 *
 * 锁模式（§10.6 的表格）：
 *
 * | 方法 | 模式 | 理由 |
 * |---|---|---|
 * | `write` / `edit` | `EXACT` | 只涉及单路径 |
 * | `mkdir` / `remove` | `TREE` | 涉及整棵子树 |
 * | `move` | `TREE`（源与目标各一把） | 两端都要独占 |
 * | `read` / `readBytes` / `stat` / `list` / `tree` | **不拿锁** | 读快照，见下 |
 *
 * ## 为什么只读操作不拿锁
 *
 * 路径锁是**写者之间**的互斥（§10.6）：它的存在是为了让「读正文 → 应用补丁 →
 * 写回」不被插进来。只读操作不参与这个不变量，所以不该排队。
 *
 * 内容写入本身就是原子的（`ContentStore.writeText`：同目录临时文件 → `fsync` →
 * `rename`），任何时刻被读到的都是完整的旧版本或完整的新版本。锁对读**不提供**
 * 额外的一致性，只提供阻塞：后台摘要重建在持有根目录锁的那 9.4 秒里调了一次模型，
 * 这段时间内 `GET /fs/tree` 会一直等到 `acquire` 超时再返回 409——读请求被一个与
 * 它无关的 LLM 调用打断，是纯粹的可用性损失。
 *
 * 代价是遍历期间子树可能被并发删除。这不是错误：节点真的没了，正确的回答是
 * 「它不存在」，而不是把它当成服务端故障。所以 `tree` 把**后代**目录的
 * `NOT_FOUND` 当成「这棵子树已经消失」跳过（根不存在仍然抛 `NOT_FOUND`），
 * `ContentStore.list` 跳过读到一半消失的子项。读到的是**快照**，不是加锁的一致
 * 视图——区别在于「可能少几个刚被删掉的条目」，不在于「可能读到写了一半的文件」。
 */

// 架构文档 §4.4 明确「没有 ContentStore 接口」：内容存储就是适配层里的一个具体类，
// 分层靠「node:fs 只允许出现在 adapters/」保证。这里用 `import type` 引用具体类型，
// 运行期实例由 bootstrap 注入，本服务不 new 适配器（§4.2 的 type-only 例外）。
import type {
  ContentStore,
  StoredStat,
  TextDocument,
  WriteTextOptions,
} from '../adapters/fs/content-store.js';
import type { PathLockManager } from '../adapters/fs/lock.js';
import { MANAGE_LEVEL, READ_LEVEL, WRITE_LEVEL } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { stableDigest } from '../domain/node.js';
import { applyPatch, type PatchBlock } from '../domain/patch.js';
import type { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import { assertNotVersionTarget } from './version-directory.js';

/**
 * `tree` 的默认深度。来源：架构文档 §13.2 的 `tree` 工具契约 `levelLimit=3`。
 */
const DEFAULT_TREE_DEPTH = 3;

/**
 * `tree` 的默认节点上限。来源：架构文档 §8.1 举的例子就是「`tree` 一个 1000
 * 节点的目录」，再深用户也读不完，截断比返回十万条更有用。
 */
const DEFAULT_TREE_LIMIT = 1000;

/** 补丁失败原因的中文说明，只用于错误消息。 */
const PATCH_REASON_LABEL: Readonly<Record<'not_found' | 'ambiguous', string>> = Object.freeze({
  not_found: '没有命中',
  ambiguous: '命中多处',
});

export interface TreeEntry {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
  readonly size: number;
}

export interface TreeResult {
  readonly root: Uri;
  readonly entries: readonly TreeEntry[];
  /** 是否因为 depth 或 limit 被截断 */
  readonly truncated: boolean;
}

export interface WriteResult {
  readonly uri: Uri;
  readonly stat: StoredStat;
  readonly created: boolean;
}

export interface EditResult {
  readonly uri: Uri;
  readonly stat: StoredStat;
  readonly applied: number;
}

export interface RemoveResult {
  readonly removedFiles: number;
}

/**
 * 节点写入观察者（架构文档 §8.2 的物化增量入口）。
 *
 * `FileSystemService` 是内容的唯一写入口，索引与 `node_permission` 都是派生数据。
 * 节点落盘后必须通知它们：没有通知就没有 `node_permission` 行，检索永远看不到
 * 新节点（「写成功了但读不到」）。
 *
 * 实现方负责幂等：同一个 URI 可能被通知多次（覆盖写、重复 mkdir）。
 */
export interface NodeWriteObserver {
  /** 节点被创建或更新后调用。`kind` 是落盘后的实际形态。 */
  onNodeWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void>;

  /** 节点被删除、或 move 后源路径消失时调用。实现方负责清掉派生行。 */
  onNodeRemoved(uri: Uri): Promise<void>;

  /**
   * 节点被移动 / 改名后调用。
   *
   * **为什么不是一次删除 + 一次写入**：`move` 一个非空目录时，源路径的派生行要
   * 整棵清掉，目标路径的每一层都要重建。拆成 `onNodeRemoved(from)` +
   * `onNodeWritten(to, kind)` 只会重建目标节点自己，子项一条都不出现——文件在
   * 磁盘上还在，`tree` 却只剩一个空目录。
   *
   * 一次通知让实现方在**一次遍历**里重建整棵子树：1000 个文件不该产生 1000 次
   * 索引事务，也不该产生 1000 次摘要失效。
   */
  onNodeMoved(from: Uri, to: Uri): Promise<void>;
}

export interface FileSystemServiceDeps {
  readonly store: ContentStore;
  readonly locks: PathLockManager;
  readonly authorizer: Authorizer;
  readonly logger: Logger;
  /** 派生数据的写入通知；顺序即调用顺序，实现方之间不应有依赖。 */
  readonly observers?: readonly NodeWriteObserver[];
  /**
   * 按 URI 读到内容时累加访问计数（`NodeRepository.recordAccess`，§17.5 / §11.7）。
   *
   * 这是「用户通过公开接口读到了这个节点」的边界：HTTP `GET /content/read` 与 MCP
   * `read` 都走 `read`。不记在 `stat` / `list` / `tree` 上——浏览目录不等于读了
   * 正文，`last_accessed_at` 不能因为控制台刷了一次列表就刷新。
   *
   * 省略时不记（只读部署没有这个写端口）。生产装配注入，见 `container.ts`。
   */
  readonly recordAccess?: (uris: readonly string[]) => unknown;
}

export class FileSystemService {
  readonly #store: ContentStore;
  readonly #locks: PathLockManager;
  readonly #authorizer: Authorizer;
  readonly #logger: Logger;
  readonly #observers: readonly NodeWriteObserver[];
  readonly #recordAccess: FileSystemServiceDeps['recordAccess'];

  constructor(deps: FileSystemServiceDeps) {
    this.#store = deps.store;
    this.#locks = deps.locks;
    this.#authorizer = deps.authorizer;
    this.#logger = deps.logger;
    this.#observers = deps.observers ?? [];
    this.#recordAccess = deps.recordAccess;
  }

  /** 读正文。**不拿路径锁**：写入是原子的，锁只会让读等后台写者（见文件头）。 */
  async read(uri: Uri, principals: readonly string[]): Promise<TextDocument> {
    await this.#authorizer.assert(uri, READ_LEVEL, principals);
    const document = await this.#store.readText(uri);
    this.#touchAccess(uri);
    return document;
  }

  /**
   * 读成功之后累加访问计数。**不 await**：`read` 是热路径，一次 UPDATE 的写事务
   * 不该让读等它；写失败只记 warn，访问统计不是读取正确性的一部分。
   *
   * 只记 `read`，不记 `readBytes`：TTL 只作用于 `context_type = 'memory'` 的
   * 文本记忆，二进制资源没有滑动窗口语义。
   */
  #touchAccess(uri: Uri): void {
    const record = this.#recordAccess;
    if (record === undefined) {
      return;
    }
    void (async () => {
      try {
        await record([uri.toString()]);
      } catch (error) {
        this.#logger.warn('读取访问计数写入失败', {
          uri: uri.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  async readBytes(uri: Uri, principals: readonly string[]): Promise<Uint8Array> {
    await this.#authorizer.assert(uri, READ_LEVEL, principals);
    return this.#store.readBytes(uri);
  }

  async stat(uri: Uri, principals: readonly string[]): Promise<StoredStat | null> {
    await this.#authorizer.assert(uri, READ_LEVEL, principals);
    return this.#store.stat(uri);
  }

  /**
   * 直接子项，逐条求 read 权限（§12.4）。无权限的节点完全不出现：文件名和摘要
   * 本身就是信息，返回「存在但无权」的占位等于泄露。
   */
  async list(uri: Uri, principals: readonly string[]): Promise<readonly TreeEntry[]> {
    await this.#authorizer.assert(uri, READ_LEVEL, principals);
    return this.#listChildren(uri, principals);
  }

  /**
   * 深度优先的子树，同层按 name 升序（`ContentStore.list` 已排序）。
   *
   * 超 `depth` 或 `limit` 时置 `truncated: true` 并停止。`depth` 边界上的目录只有
   * 「有可读子项」才算截断——空目录没有省略任何东西。**不拿路径锁**（见文件头）：
   * 遍历读的是一份快照，并发 `rm -r` 删掉的子树直接跳过；根不存在时仍抛
   * `NOT_FOUND`。
   */
  async tree(
    uri: Uri,
    principals: readonly string[],
    options: { readonly depth?: number; readonly limit?: number } = {},
  ): Promise<TreeResult> {
    const depth = options.depth ?? DEFAULT_TREE_DEPTH;
    const limit = options.limit ?? DEFAULT_TREE_LIMIT;
    await this.#authorizer.assert(uri, READ_LEVEL, principals);

    const entries: TreeEntry[] = [];
    let truncated = false;

    const visit = async (directory: Uri, remainingDepth: number): Promise<void> => {
      if (truncated) {
        return;
      }
      let visible: readonly StoredStat[];
      try {
        visible = await this.#visibleChildren(directory, principals);
      } catch (error) {
        // 根不存在 = 404；后代目录在遍历期间被删掉 = 这棵子树已经没了，跳过。
        if (
          error instanceof ComemError &&
          error.code === 'NOT_FOUND' &&
          !directory.equals(uri)
        ) {
          this.#logger.debug('遍历期间子树已消失，跳过。', {
            root: uri.toString(),
            directory: directory.toString(),
          });
          return;
        }
        throw error;
      }
      if (remainingDepth <= 0) {
        if (visible.length > 0) {
          truncated = true;
        }
        return;
      }
      for (const child of visible) {
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        entries.push(toTreeEntry(child));
        if (child.kind === 'directory') {
          await visit(child.uri, remainingDepth - 1);
        }
      }
    };

    await visit(uri, depth);
    if (truncated) {
      this.#logger.debug('目录树被截断。', { root: uri.toString(), depth, limit });
    }
    return { root: uri, entries, truncated };
  }

  /**
   * 写正文。`created` 表示写入前目标不存在。`options` 原样透传：`expectedDigest`
   * 由 `ContentStore` 做乐观并发；不传 `frontmatter` 时保留磁盘上现有的（§10.6）。
   */
  async write(
    uri: Uri,
    text: string,
    principals: readonly string[],
    options: WriteTextOptions = {},
  ): Promise<WriteResult> {
    assertNotVersionTarget(uri);
    await this.#authorizer.assert(uri, WRITE_LEVEL, principals);
    // 写者建立父目录：目标父目录不存在时锁文件没有地方放，而写者会**创建**目标
    // ——不建目录的话「同一时刻只有一个写者」对新路径不成立。
    return this.#locks.withLock(
      uri,
      'exact',
      async () => {
        const created = !(await this.#store.exists(uri));
        const stat = await this.#store.writeText(uri, text, options);
        await this.#notifyWritten(uri, 'file');
        return { uri, stat, created };
      },
      { createParentDirectory: true },
    );
  }

  /**
   * 应用 SEARCH/REPLACE 补丁（§11.2、§11.5）。
   *
   * 失败时抛 `INVALID_ARGUMENT`，**不写文件**：块命中零处或多处时，任何部分应用
   * 都会把正文改成模型没预期的样子。写入用 `expectedDigest` 做乐观并发，保证
   * 「读到的正文」与「写回的正文」之间没有被别人插过。
   *
   * 落盘后与 `write` 走**同一条**派生数据通知：正文变了，索引里的 `body_digest` /
   * `node_fts` / 摘要 / 物化权限都要跟着变。少了这一步，`edit` 之后 `find` 仍然返回
   * 旧正文，而工具还会回报 `Index: indexed`（那一列只判断行存在）。
   */
  async edit(
    uri: Uri,
    blocks: readonly PatchBlock[],
    principals: readonly string[],
  ): Promise<EditResult> {
    assertNotVersionTarget(uri);
    await this.#authorizer.assert(uri, WRITE_LEVEL, principals);
    return this.#locks.withLock(uri, 'exact', async () => {
      const document = await this.#store.readText(uri);
      const result = applyPatch(document.text, blocks);
      if (!result.ok) {
        this.#logger.warn('补丁应用失败，未写入文件。', {
          uri: uri.toString(),
          reason: result.reason,
          blockIndex: result.blockIndex,
          matches: result.matches,
        });
        throw new ComemError(
          'INVALID_ARGUMENT',
          `补丁应用失败：第 ${result.blockIndex} 块${PATCH_REASON_LABEL[result.reason]}（${result.reason}）。`,
          {
            uri: uri.toString(),
            reason: result.reason,
            blockIndex: result.blockIndex,
            matches: result.matches,
          },
        );
      }
      const stat = await this.#store.writeText(uri, result.content, {
        expectedDigest: stableDigest(document.text),
      });
      // 通知在文件真正落盘之后、且只在成功时：`writeText` 抛错时不会走到这里，
      // 补丁未命中时更早就抛了。与 `write` 一样在路径锁内通知（观察者自己把摘要
      // 失效推到锁释放之后，见 `IndexObserver` 文件头）。
      await this.#notifyWritten(uri, 'file');
      return { uri, stat, applied: result.appliedCount };
    });
  }

  /** 建目录，父目录不存在时一并建（`recursive`），已存在不报错。 */
  async mkdir(uri: Uri, principals: readonly string[]): Promise<void> {
    assertNotVersionTarget(uri);
    await this.#authorizer.assert(uri, WRITE_LEVEL, principals);
    await this.#locks.withLock(uri, 'tree', async () => {
      await this.#store.mkdir(uri, { recursive: true });
      await this.#notifyWritten(uri, 'directory');
    });
  }

  /** 删除。不存在的路径返回 `{ removedFiles: 0 }`，不报错。 */
  async remove(uri: Uri, principals: readonly string[]): Promise<RemoveResult> {
    assertNotVersionTarget(uri);
    await this.#authorizer.assert(uri, MANAGE_LEVEL, principals);
    return this.#locks.withLock(uri, 'tree', async () => {
      const removedFiles = await this.#store.remove(uri, { recursive: true });
      await this.#notifyRemoved(uri);
      return { removedFiles };
    });
  }

  /**
   * 移动 / 改名。源与目标各持一把 `TREE` 锁。
   *
   * 按 URI 字符串排序后获取，避免两个相反方向的 `move` 互相等；互为祖先的路径直接
   * 拒绝——`move a → a/b` 会在拿第二把锁时等自己，报一个误导性的超时。同一路径只拿
   * 一把锁，让 `ContentStore.move` 抛它自己的 `ALREADY_EXISTS`。
   */
  async move(from: Uri, to: Uri, principals: readonly string[]): Promise<void> {
    assertNotVersionTarget(from);
    assertNotVersionTarget(to);
    await this.#authorizer.assert(from, MANAGE_LEVEL, principals);
    await this.#authorizer.assert(to, MANAGE_LEVEL, principals);

    if (from.isAncestorOf(to) || to.isAncestorOf(from)) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `不能在互为祖先的路径之间移动：${from.toString()} → ${to.toString()}。`,
        { from: from.toString(), to: to.toString() },
      );
    }
    if (from.equals(to)) {
      await this.#locks.withLock(from, 'tree', () => this.#store.move(from, to));
      return;
    }

    const ordered =
      from.toString() < to.toString()
        ? { first: from, second: to }
        : { first: to, second: from };
    await this.#locks.withLock(ordered.first, 'tree', () =>
      this.#locks.withLock(ordered.second, 'tree', async () => {
        await this.#store.move(from, to);
        // 移动 = 源路径消失 + 目标路径出现。**一次**通知：源路径的整棵子树要清掉，
        // 目标路径的整棵子树要重建，拆成两次通知会让子项全部丢失（见
        // `NodeWriteObserver.onNodeMoved`）。
        await this.#notifyMoved(from, to);
      }),
    );
  }

  /**
   * 通知「节点已写入」。
   *
   * **observer 抛错不能让写操作失败**：文件已经落盘，回滚反而丢数据；索引与权限是
   * 派生数据，靠对账修复（架构文档 §7）。逐个捕获，一个 observer 失败不影响其余。
   */
  async #notifyWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    for (const observer of this.#observers) {
      try {
        await observer.onNodeWritten(uri, kind);
      } catch (error) {
        this.#logger.error('节点写入观察者失败，已忽略。', {
          uri: uri.toString(),
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 通知「节点已删除」，失败语义与 `#notifyWritten` 相同。 */
  async #notifyRemoved(uri: Uri): Promise<void> {
    for (const observer of this.#observers) {
      try {
        await observer.onNodeRemoved(uri);
      } catch (error) {
        this.#logger.error('节点删除观察者失败，已忽略。', {
          uri: uri.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 通知「节点已移动」，失败语义与 `#notifyWritten` 相同。 */
  async #notifyMoved(from: Uri, to: Uri): Promise<void> {
    for (const observer of this.#observers) {
      try {
        await observer.onNodeMoved(from, to);
      } catch (error) {
        this.#logger.error('节点移动观察者失败，已忽略。', {
          from: from.toString(),
          to: to.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 有 read 权限的直接子项。 */
  async #visibleChildren(
    directory: Uri,
    principals: readonly string[],
  ): Promise<readonly StoredStat[]> {
    const children = await this.#store.list(directory);
    const readable = await this.#authorizer.filterReadable(
      children.map((child) => child.uri),
      principals,
    );
    return children.filter((child) => readable.has(child.uri.toString()));
  }

  async #listChildren(
    directory: Uri,
    principals: readonly string[],
  ): Promise<readonly TreeEntry[]> {
    return (await this.#visibleChildren(directory, principals)).map(toTreeEntry);
  }
}

function toTreeEntry(stat: StoredStat): TreeEntry {
  return { uri: stat.uri, kind: stat.kind, size: stat.size };
}
