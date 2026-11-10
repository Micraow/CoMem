/**
 * 节点读模型仓储（架构文档 §8.1 的 `node` 表、§6 的路径语义）。
 *
 * 只负责 `node` 表的读取与状态维护：路径前缀匹配、子节点枚举、访问计数、TTL
 * 归档与物理删除候选。写入由 `SqliteFtsIndex.upsert` 负责（生产唯一写路径）。全文索引与
 * 物化权限分别在 `retrieval-index.ts` 与 `permission-repository.ts`，它们复用这里的
 * 两个 SQL 片段（`globPrefixPattern` / `placeholders`）——转义规则只能有一份，
 * 否则某个仓储漏转义 `*` 就会在「带星号的目录名」上产生越权候选。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { Level } from '../../domain/level.js';
import type { Logger } from '../../domain/log.js';
import { TTL_EXEMPT_MEMORY_TYPES } from '../../domain/memory-types/index.js';
import { VERSION_DIRECTORY, type ContextType, type NodeKind, type NodeStatus } from '../../domain/node.js';
import type { UriScope } from '../../domain/uri.js';
import { withWriteTransaction } from './database.js';

/** `node` 表的一行（架构文档 §8.1）。 */
export interface NodeRow {
  readonly uri: string;
  readonly parentUri: string;
  readonly scope: UriScope;
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly bodyDigest: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
}

export interface NodeRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/**
 * 热度衰减的输入（架构文档 §17.5、`0001_init.sql` 的 `node.access_count` /
 * `last_accessed_at`）。
 *
 * 与 `NodeRow` 分开：`NodeRow` 是检索的读模型（`uri` / `level` / `abstract` 这些
 * 一次查询就要的列），访问计数只在算热度时用。混进去会让「检索命中」这个热路径
 * 每次都多读两列，而它们只在控制台的统计页上有意义。
 */
export interface NodeAccessStats {
  readonly uri: string;
  /** 被检索命中并注入的次数。从没访问过是 0。 */
  readonly accessCount: number;
  /** ISO 8601；从没访问过是 `null`。 */
  readonly lastAccessedAt: string | null;
}

/** 列顺序与 `NodeRow` 字段顺序一致，映射函数只依赖这个常量。 */
const NODE_COLUMN_NAMES = [
  'uri',
  'parent_uri',
  'scope',
  'kind',
  'context_type',
  'memory_type',
  'level',
  'abstract',
  'body_digest',
  'size',
  'updated_at',
  'status',
] as const;

const NODE_COLUMNS = NODE_COLUMN_NAMES.join(', ');

/**
 * 「最后一次被使用」的时刻（架构文档 §11.7）：`max(updated_at, last_accessed_at)`。
 *
 * 两个操作都算「用过这条记忆」：正文被写入（`updated_at`）与检索命中
 * （`last_accessed_at`，由 `recordAccess` 写）。取最大值而不是 `COALESCE`：一条记忆
 * 可能先被访问、之后正文又被改写，`COALESCE` 会挑那条更早的访问时刻，让刚改过的
 * 记忆立刻出现在过期候选里。
 *
 * `COALESCE` 只为补 `last_accessed_at IS NULL`（从没被访问过）——SQL 标量 `max()`
 * 遇到 NULL 会返回 NULL，不过滤掉整行。
 *
 * 没有为这个表达式建索引（`0005_sliding_ttl.sql`）：表达式索引会在 `recordAccess`
 * 这条热路径上多维护一条索引项，且 `memory.ttl.defaultDays = 0`（默认）时完全不
 * 需要它。第一段清扫每轮最多只有一次顺序扫描，代价见 `sweepExpired` 的注释。
 */
const LAST_USED_AT_SQL = 'MAX(updated_at, COALESCE(last_accessed_at, updated_at))';

/**
 * 「这个 URI 不在记忆版本快照目录下」的 SQL 判据（架构文档 §11.11）。
 *
 * 覆盖写把旧值快照到 `memories/{type}/.history/`，那份文件的 frontmatter 里 `status`
 * 仍是 `active`（设计如此：它是一条**旧值**，不是归档项），索引里只靠非空的
 * `valid_until` 被检索面滤掉。TTL 不看有效区间，只看最后使用时刻，所以不排除的话：
 *
 * - 第一段会把版本文件标成 `archived`。`glob` / `grep` / 向量候选集的 SQL 都带
 *   「只看 active」，于是路径工具再也列不出 `.history` 下的版本文件——而它们的契约
 *   是磁盘（§8.4）。
 * - 第二段会把它物理删除。`reject` 读 `supersedes` 指向的版本文件时只看到「文件不
 *   存在」，于是静默退化成删除：用户以为驳回回到了上一次正确值，实际这条记忆消失。
 *
 * **必须两条 GLOB，不能只写带 `/*` 的那一条。** 目录节点自身（
 * `memories/preferences/.history`）的 URI 在 `.history` 后面没有字符，`/*` 要求至少
 * 一个 `/` 加内容，匹配不到它。漏掉它会怎样：`pnpm reindex` 的 `walkDataDir` 会给
 * 磁盘上每个目录 upsert 一行（`kind = 'directory'`、`memory_type = NULL`、
 * `status = 'active'`），第一段把它当过期记忆归档；而路径工具按 `status = 'active'`
 * 取节点，从此 `.history` 目录在 `list` / `tree` 里消失，磁盘上却还在。
 *
 * **判定按路径段，不看子串。** `memories/preferences/.history.md` 是一条普通记忆
 * （`identity` 可以是 `.history`），必须照常过期。SQL 没有「切段」函数，用 GLOB 表达
 * 段边界：模式要求 `.history` 两侧都是 `/`。锚在 `memories/` 之后是因为记忆类型目录
 * 全部是 `memories/{type}`（含 `projects/{pid}/memories`）；GLOB 的 `*` 跨 `/`，所以
 * `rules` 镜像出来的 `.history/{scenario}/...` 同样命中。
 *
 * 第二段的查询也要带它，不只是第一段：存量库（修复前跑过 TTL）里已经有被归档的版本
 * 行，它们归档得最早，会一直排在 `ORDER BY archived_at ASC` 的队首——不排除的话，
 * 每轮批次的名额被它们占满，真正的记忆一条也轮不到。
 *
 * 目录名从领域层常量派生，不在这里再写一份字面量：判据散开之后，改一处就会漏一处。
 */
const VERSION_PATH_GLOB = `*/memories/*/${escapeGlobLiteral(VERSION_DIRECTORY)}`;
const NOT_VERSION_FILE_SQL = `uri NOT GLOB '${VERSION_PATH_GLOB}' AND uri NOT GLOB '${VERSION_PATH_GLOB}/*'`;

/**
 * 「节点自身那一行」的谓词（架构文档 §8.1、§8.5）。
 *
 * 一个目录在 `node` 里最多两行：L0 摘要行（节点自身）与 L1 概览行
 * （`0004_node_level_rows.sql`）。L1 是**附加的检索行**——它只携带概览正文，不携带
 * 节点身份。按 URI 读一个节点（`get` / `descendants` / 热度 / TTL）都必须带上这条
 * 谓词，否则一个目录会变成两条节点：
 * `tree` 里出现重复、计数翻倍、`sweepExpired` 把同一个目录返回两次。
 *
 * 条件是「目录 + L1」而不是「任何 L1」：附加行的定义就是「目录的概览行」（由
 * `SummaryService` 写）。文件不会出现在 L1（它只有 L2 原文），而把谓词写成纯层级
 * 会在将来出现「文件级概览」时把合法的节点行一起藏掉。
 *
 * `alias` 是 `node` 在外层查询里的别名；省略时不加前缀（`UPDATE` / 单表查询）。
 */
export function nodeSelfRowSql(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `NOT (${prefix}kind = 'directory' AND ${prefix}level = 'L1')`;
}

/** GLOB 里把字面量段内的元字符（`*` `?` `[` `]`）转义成字符类。 */
function escapeGlobLiteral(value: string): string {
  return value.replace(/[[\]*?]/g, (char) => `[${char}]`);
}

/**
 * 子树前缀模式：把前缀里的 GLOB 元字符转义后补 `/*`。
 *
 * 用 `GLOB` 而不是 `LIKE`：URI 的根标识与大写敏感（§6.2 只做 NFC，不做大小写折叠），
 * `comem://user/Alice` 与 `comem://user/alice` 是两个不同用户。`LIKE` 对 ASCII
 * 大小写不敏感，会把前者的子树算进后者的范围；`GLOB` 是二进制比较，与主键的排序
 * 规则一致。
 *
 * 转义是必须的：URI 的路径段允许 `*` `?` `[` `]` `_` `%`（§6.2 只禁控制字符、
 * 反斜杠、斜杠与保留名），不转义时 `comem://user/alice/a*b` 的前缀会匹配
 * `comem://user/alice/aXb` 的子树。GLOB 用「字符类里放字面量」转义（`*` → `[*]`，
 * `[` → `[[]`）。
 *
 * 补 `/*` 而不是 `*` 是为了段边界：`comem://user/alice` 不能命中
 * `comem://user/alice2`。
 *
 * 三个仓储共用这一份实现（`node` / `node_permission` / `node_fts` 的前缀过滤），
 * 保证转义规则不会各写一遍。
 */
export function globPrefixPattern(prefix: string): string {
  return `${escapeGlobLiteral(prefix)}/*`;
}

/** `IN (?, ?, ...)` 的占位符列表。`count` 由调用方按已校验的数组长度传入。 */
export function placeholders(count: number): string {
  return new Array<string>(count).fill('?').join(', ');
}

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

/**
 * 数据库行 → `NodeRow`。
 *
 * 枚举列用 `as` 收窄：写入路径（`SqliteFtsIndex.upsert`）只接受领域类型，表里出现的值一定是枚举
 * 成员；这里再写一遍校验只会给每个字段加一个不可能走到的分支。
 */
function toNodeRow(row: Record<string, SQLOutputValue>): NodeRow {
  return {
    uri: text(row['uri']),
    parentUri: text(row['parent_uri']),
    scope: text(row['scope']) as UriScope,
    kind: text(row['kind']) as NodeKind,
    contextType: text(row['context_type']) as ContextType,
    memoryType: nullableText(row['memory_type']),
    level: text(row['level']) as Level,
    abstract: nullableText(row['abstract']),
    bodyDigest: text(row['body_digest']),
    size: integer(row['size']),
    updatedAt: text(row['updated_at']),
    status: text(row['status']) as NodeStatus,
  };
}

export class NodeRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: NodeRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  get(uri: string): NodeRow | null {
    const row = this.#db
      .prepare(`SELECT ${NODE_COLUMNS} FROM node WHERE uri = ? AND ${nodeSelfRowSql()}`)
      .get(uri);
    return row === undefined ? null : toNodeRow(row);
  }

  descendants(uri: string): readonly NodeRow[] {
    return this.#db
      .prepare(
        `SELECT ${NODE_COLUMNS} FROM node
          WHERE uri GLOB ? AND ${nodeSelfRowSql()}
          ORDER BY uri ASC`,
      )
      .all(globPrefixPattern(uri))
      .map(toNodeRow);
  }

  /**
   * 批量累加访问计数。**不走 `updated_at`**——访问不是修改。
   *
   * 一次检索命中 50 条，逐个 UPDATE 是 50 次事务（每次 `BEGIN IMMEDIATE` 都要拿
   * 写锁并落盘）。这里一条事务 + 一条预编译语句，50 条是 50 次 `run`。
   *
   * **不存在的 URI 静默跳过**：索引与磁盘不同步是正常状态（文件被外部删除、
   * 重建索引前），为它抛错会让一次正常的检索失败。返回的是实际命中的行数。
   *
   * **不去重**：同一个 URI 在入参里出现两次就是两次访问。合并检索结果时按 URI
   * 去重是调用方的职责（§8.4 的合并规则），这里再做一次会让「命中两次」这件事
   * 在计数上消失。
   *
   * **只记节点自身那一行**：目录的 L1 概览行不是独立节点，命中它也是命中那个目录；
   * 两行各加一次会让 `readAccessStats` 的取值依赖行序（L0 已加、L1 还是 0）。
   */
  recordAccess(uris: readonly string[], at: Date): number {
    if (uris.length === 0) {
      return 0;
    }
    if (Number.isNaN(at.getTime())) {
      // 非法 Date 调 `toISOString()` 抛的是 `RangeError: Invalid time value`，
      // 消息里没有字段名，上层只能看到一个内部错误。
      throw new ComemError('INVALID_ARGUMENT', '访问时间不是合法的 Date。', { at: at.toString() });
    }

    const timestamp = at.toISOString();
    const updated = withWriteTransaction(this.#db, () => {
      const statement = this.#db.prepare(
        `UPDATE node SET access_count = access_count + 1, last_accessed_at = ?
          WHERE uri = ? AND ${nodeSelfRowSql()}`,
      );
      let changes = 0;
      for (const uri of uris) {
        changes += Number(statement.run(timestamp, uri).changes);
      }
      return changes;
    });

    this.#logger.debug('节点访问计数累加', { uris: uris.length, updated });
    return updated;
  }

  /**
   * 清扫第一段：**最后一次被使用**早于 `cutoff` 的记忆 `status` 置 `archived`，
   * 这里不删文件（软过期，架构文档 §11.7）。物理删除是第二段
   * （`selectPurgeable` + 文件/索引删除），由 `TtlService` 编排——仓储不碰文件系统，
   * 删文件需要 `FileSystemService`。
   *
   * **判据是滑动窗口，不是写入时间**：`max(updated_at, last_accessed_at)` 早于
   * `cutoff` 才算过期。天天被检索命中的记忆会不断把窗口往后推；`updated_at` 参与
   * 取最大值，是为了让「先被访问、之后正文又被改写」的记忆从改写时刻重新计时——
   * 只用 `COALESCE(last_accessed_at, updated_at)` 会在这种情况下用一条更早的访问
   * 时刻去判一条刚写过的记忆。
   *
   * 两个时间串都是 `Date#toISOString()` 形态（定长、UTC、带毫秒），TEXT 的字典序
   * 与时间顺序一致，所以 SQL 的 `max()` 与 `<` 直接对字符串成立。
   *
   * **豁免稳定身份与约束**：`TTL_EXEMPT_MEMORY_TYPES`（领域层）里的类型永不过期。
   * 其余 `context_type = 'memory'` 的**文件**行按最后使用时刻过期，但必须有
   * `memory_type`：没有它说明这份文件不是可解析的记忆（用户手放的 Markdown、
   * `memory_type` 键丢失的历史行）。**TTL 是记忆的回收站，不是文件系统的回收站**
   * ——看不懂的文件不动它，免得把用户手写的东西静默归档/删除。目录行没有
   * frontmatter，不适用这一条（它只承载一个 URI 与概览行，第一段只改 `status`，
   * 可逆），仍按最后使用时刻过期。
   *
   * **只对 `context_type = 'memory'` 生效**：`memory.ttl` 描述记忆的存活时间，
   * `resources` / `skills` 不该被套上它。
   *
   * 为什么第一段仍是软过期：TTL 配错（把 30 天写成 1 天）时，`archived` 还能改回来；
   * 物理删除没有回滚。两段式让「配错」在 `retentionDays` 的宽度里可观测、可撤销。
   *
   * **同时写 `archived_at`**（`0002_archived_at.sql`）：第二段靠它算「归档了多久」。
   * 归档是「内容状态的时间戳」，不是内容写入，所以**不动 `updated_at`**。
   *
   * **不动 `node_permission`**：归档节点仍要能按权限查到——「这条记忆归档了」是内容
   * 状态，不是「这个人失去了访问权」。删权限行会让「归档」变成「对所有人消失」。
   *
   * **幂等**：`status <> 'archived'` 让重复调用不重复计数（第二次返回空）。
   *
   * **选候选排除 L1 概览行、改状态不排除**：选候选时不带 `nodeSelfRowSql()` 会让
   * 一个目录在返回列表里出现两次（第二段清扫与调用方计数都按 URI 解释它）；而归档
   * 本身是按 URI 的状态转移，同一个 URI 的两行必须一起改，否则目录还能从概览正文里
   * 被检索到。
   *
   * `ORDER BY <最后使用时刻> ASC LIMIT ?` 让「积压很多」时先清最久没用的，同时给每轮
   * 一个上界（`memory.ttl.sweepBatchSize`）——一次更新整表会长时间持有写锁，把并发
   * 请求卡在 `busy_timeout` 上。
   *
   * `archivedAt` 单独传入而不是复用 `cutoff`：`archived_at` 是第二段算保留期的起点，
   * 用 `cutoff`（= 现在 - `defaultDays`）会让保留期提前 `defaultDays` 天走完——配了
   * 「30 天过期、再保留 30 天」时，一条记忆归档当天就可能被物理删除。
   */
  sweepExpired(cutoff: Date, archivedAt: Date, limit: number): readonly string[] {
    const cutoffIso = cutoff.toISOString();
    const archivedIso = archivedAt.toISOString();
    const exempt = TTL_EXEMPT_MEMORY_TYPES;
    const expired = withWriteTransaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          `SELECT uri FROM node
            WHERE context_type = 'memory'
              AND (kind = 'directory' OR memory_type IS NOT NULL)
              AND COALESCE(memory_type, '') NOT IN (${placeholders(exempt.length)})
              AND ${LAST_USED_AT_SQL} < ?
              AND status <> 'archived'
              AND ${nodeSelfRowSql()}
              AND ${NOT_VERSION_FILE_SQL}
            ORDER BY ${LAST_USED_AT_SQL} ASC
            LIMIT ?`,
        )
        .all(...exempt, cutoffIso, limit);
      const uris = rows.map((row) => text(row['uri']));
      if (uris.length === 0) {
        return uris;
      }
      const statement = this.#db.prepare(
        `UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?`,
      );
      for (const uri of uris) {
        statement.run(archivedIso, uri);
      }
      return uris;
    });
    if (expired.length > 0) {
      this.#logger.info('TTL 清扫：过期节点已归档。', { count: expired.length, uris: expired });
    }
    return expired;
  }

  /**
   * 清扫第二段的候选：已归档且归档时刻早于 `cutoff`（`archived_at < cutoff`）的节点。
   *
   * 只返回 `kind = 'document'` 的叶子节点。目录节点不入选：目录里可能还有子项，
   * 整棵删掉会顺手删掉别人没归档的兄弟记忆；目录行随最后一条子项被删而残留为空行，
   * 由后续重建索引清掉（与 §6.5「索引是派生」一致）。物理删除文件是逐文件的动作，
   * 目标是「这条记忆」而不是「这个目录」。
   *
   * `archived_at IS NOT NULL` 是硬条件：`NULL` 表示「不知道归档时刻」（本迁移之前
   * 的 archived 行、或非 TTL 途径产生的 archived 行），不把未知当成「很久以前」——
   * 物理删除不可逆，宁可永远不删。
   *
   * `memory_type IS NOT NULL` 与第一段同一判据：没有类型的文档不是可解析的记忆，
   * 不归 TTL 的回收站管。第二段还要 `kind = 'document'`（目录行不删）。
   *
   * `ORDER BY archived_at ASC LIMIT ?` 与第一段同一理由：先删最老的、每轮一个上界。
   */
  selectPurgeable(cutoff: Date, limit: number): readonly string[] {
    const cutoffIso = cutoff.toISOString();
    const rows = this.#db
      .prepare(
        `SELECT uri FROM node
          WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?
            AND kind = 'document'
            AND memory_type IS NOT NULL
            AND ${NOT_VERSION_FILE_SQL}
          ORDER BY archived_at ASC
          LIMIT ?`,
      )
      .all(cutoffIso, limit);
    return rows.map((row) => text(row['uri']));
  }

  /**
   * 读热度所需的两个字段，**按入参顺序**返回。
   *
   * 不在索引里的 URI 不返回（不是补一条 `accessCount: 0`）：补零会让「这条记忆
   * 不在索引里」和「这条记忆从没被访问过」变成同一件事，而前者是数据不一致，
   * 排查时需要的正是这个区别。
   */
  readAccessStats(uris: readonly string[]): readonly NodeAccessStats[] {
    if (uris.length === 0) {
      // 空 IN () 是语法错误。调用方在「一条都没命中」时不该产生一次查询。
      return [];
    }

    const rows = this.#db
      .prepare(
        `SELECT uri, access_count, last_accessed_at FROM node
          WHERE uri IN (${placeholders(uris.length)}) AND ${nodeSelfRowSql()}`,
      )
      .all(...uris);

    const byUri = new Map<string, NodeAccessStats>();
    for (const row of rows) {
      const uri = text(row['uri']);
      byUri.set(uri, {
        uri,
        accessCount: integer(row['access_count']),
        lastAccessedAt: nullableText(row['last_accessed_at']),
      });
    }

    return uris
      .map((uri) => byUri.get(uri))
      .filter((stats): stats is NodeAccessStats => stats !== undefined);
  }
}
