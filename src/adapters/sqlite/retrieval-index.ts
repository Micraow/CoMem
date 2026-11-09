/**
 * FTS5 检索实现（架构文档 §8.1–§8.5）。
 *
 * 索引侧：`upsert` 把 `abstract` 与 `content` 用 `segmentCjk` 切分后写进 `node_fts`，
 * 同时维护 `node` 读模型。查询侧：`search` 把查询串同样切分、包成 FTS5 短语，
 * 一次 SQL 完成「匹配 + 路径范围 + 元数据过滤 + 状态 + 权限」。
 *
 * **分数约定**：FTS5 的 `bm25()` 返回负数，越负越相关。这一层把分数取负后返回，
 * 于是「越大越相关」与 `domain/ranking.ts` 的排序方向一致，调用方不需要记住符号。
 * 取负之后**不做层级加权**——加权是 `domain/ranking.ts` 的职责（§8.5），索引层只
 * 提供原始分，否则同一份分数会被乘两次。
 *
 * **`grep` 不在这里**：FTS5 索引的是词，`grep` 匹配的是任意正则，两者是不同的访问
 * 路径。`grep` 由 `services/search.ts` 实现——先用本索引拿到权限过滤后的候选 URI，
 * 再逐个读文件做行匹配。
 *
 * **权限判断是 deny 优先**（架构文档 §12.2 不变量 2）：可读 = 主体集合里有人拿到
 * `level >= read` 的 allow，且没有人在同一节点上有 deny 行。索引层与仓储层
 * （`PermissionRepository.readableUris`）必须用同一套谓词，否则同一次请求里
 * `search` 与 `grep` 会给出不同的可见集合。两处都收在 `permissionPredicate`。
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import type { ContextType } from '../../domain/node.js';
import type { Level } from '../../domain/level.js';
import type { Logger } from '../../domain/log.js';
import {
  canonicalInstant,
  validateGlobQuery,
  validateSearchQuery,
  type GlobQuery,
  type IndexRecord,
  type NodeStat,
  type RetrievalIndex,
  type SearchHit,
  type SearchQuery,
} from '../../domain/retrieval.js';
import { segmentCjk } from '../../domain/text.js';
import { withWriteTransaction } from './database.js';
import { globPrefixPattern, nodeSelfRowSql, placeholders } from './node-repository.js';

export interface SqliteFtsIndexOptions {
  readonly db: DatabaseSync;
  readonly logger: Logger;
  /** §18 的 `retrieval.candidateMultiplier`，默认 4 */
  readonly candidateMultiplier?: number;
}

/**
 * §12.1：read = 1。检索只要求 read；写级别（3）与 manage（7）在服务层求权。
 * 用常量而不是字面量，避免「SQL 里的 1」和「ACL 位值」各改一处。
 */
const READ_LEVEL = 1;

/**
 * §18 `retrieval.candidateMultiplier` 的默认值。
 *
 * 来源是 §8.2 的代价分析：权限过滤在 SQL 里做，但候选仍可能因路径/元数据过滤掉
 * 一部分，先取 `limit × 4` 再截断，给「过滤后不足」留余量。这个系数没有实测数据
 * 支撑，调参时应该用真实查询对比「返回条数」与「查询成本」。
 */
const DEFAULT_CANDIDATE_MULTIPLIER = 4;

/**
 * 归档只影响检索面（§11.7）。`search` 与 `glob` 的 SQL 都带这条谓词。
 *
 * 收成一个常量而不是各写一份字面量：`glob` 同时是 `grep` 与向量检索的候选集来源
 * （`services/search.ts` 的两条路径都调 `index.glob`），「已归档不出现」必须由
 * 同一条谓词保证，否则三个检索面会漂移。
 */
const ACTIVE_STATUS_PREDICATE = "n.status = 'active'";

const URI_SCHEME = 'comem://';

/** 正则元字符转义表，`globToRegExp` 用。 */
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

interface GlobAlternative {
  /** 交给 SQLite `GLOB` 的**过近似**模式 */
  readonly sqlPattern: string;
  /** 精确匹配用的正则，在 SQL 结果上再过滤一遍 */
  readonly exact: RegExp;
}

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * 一行索引记录的 FTS `abstract` 列原文。
 *
 * 目录的 L1 概览行（`kind = 'directory'` 且 `level = 'L1'`）返回空串：L0 是从 L1 正文里提取的
 * （`domain/summary.ts` 的 `extractAbstract`），概览正文**已经包含**同一段文字。
 * 再把它写进 `abstract` 列，FTS5 会把同一处匹配的词频算两遍（`bm25()` 按列累加
 * 词频），这一行仅凭「摘要里出现过」就能压过真正的原文命中，层级权重（1.05）也
 * 就失去意义。
 *
 * 展示用的摘要不受影响：`node.abstract` 仍然存 L0 原文，`search` 返回的是那一列。
 */
function ftsAbstract(record: IndexRecord): string {
  const isOverviewRow = record.kind === 'directory' && record.level === 'L1';
  return isOverviewRow ? '' : (record.abstract ?? '');
}

/**
 * 查询串 → FTS5 短语。
 *
 * 整串包成短语是唯一安全做法：`"` `*` `(` `)` `-` `:` `^` `+` 与 `AND` / `OR` / `NOT`
 * 都会改变 FTS5 的查询语义，用户输入里完全可能出现（`a*b`、`(x)`、`AND`）。包成短语
 * 之后这些字符全部按字面量参与匹配；内部双引号双写是 FTS5 的转义规则。
 */
function toMatchExpression(textQuery: string): string {
  return `"${segmentCjk(textQuery).replace(/"/g, '""')}"`;
}

/**
 * 路径范围 → `(column = ? OR column GLOB ?)` 的 OR 组合。
 *
 * 用「等值 + GLOB 前缀」而不是裸 `GLOB 前缀 + '*'`：后者会命中 `alice2` 这类兄弟
 * 节点（段边界，§8.1 的路径 scope 过滤）。GLOB 而不是 LIKE 的理由见
 * `globPrefixPattern`：URI 大小写敏感，LIKE 会把 `Alice` 的子树算进 `alice`。
 */
function scopeClause(
  column: string,
  scopes: readonly string[],
): { readonly sql: string; readonly params: readonly string[] } {
  const params: string[] = [];
  const clauses = scopes.map((scope) => {
    params.push(scope, globPrefixPattern(scope));
    return `(${column} = ? OR ${column} GLOB ?)`;
  });
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * glob → SQLite `GLOB` 的**过近似**模式。
 *
 * GLOB 只有一个 `*`（跨 `/`），表达不了「不跨 `/` 的 `*`」，也没有反向字符类重复
 * （`[^/]*` 是「一个非斜杠字符 + 任意序列」，不是「任意个非斜杠字符」）。所以这里
 * 把 `*` 与 `**` 都当 GLOB 的 `*`，`?` 当 GLOB 的 `?`——只保证「不比精确语义更窄」。
 * 精确性由 `globToRegExp` 在结果上补一刀（见 `glob` 的惰性迭代）。
 *
 * `[` `]` 是 GLOB 的元字符，用「字符类里放字面量」转义（`[` → `[[]`，`]` → `[]]`）。
 */
function globToSqlGlob(pattern: string): string {
  return pattern.replace(/[[\]]/g, (char) => `[${char}]`);
}

/**
 * glob → 精确正则。
 *
 * - `**` → `.*`：跨 `/`
 * - `*` → `[^/]*`：不跨 `/`
 * - `?` → `[^/]`：单个非 `/` 字符（GLOB 的 `?` 自己也匹配 `/`，这一层必须收紧）
 *
 * 这里只负责「一条已经展开好的 pattern → 正则」。`**\/` 的零层含义由
 * `expandGlobstars` 先展开成两条 pattern，本函数对每条各自精确匹配——`.*` 无法
 * 表达「可有可无」，硬塞进一条正则会让边界判定变得不可读。
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(REGEXP_SPECIAL, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * 记忆类型 + 更新时间范围 → SQL 条件（架构文档 §8.3 的过滤维度）。
 *
 * 这三个条件**必须在 `LIMIT` 之前进 `WHERE`**：先取候选再在 JS 里过滤，会把
 * 「类型 / 时间匹配、但 bm25（或向量距离）排在 `limit × candidateMultiplier`
 * 之后」的节点整批丢掉——`rule_search` 曾经就是这样把规则全筛没的。
 *
 * `updated_at` 归一化成 `Date#toISOString()` 形态后与 `node.updated_at` 同形，
 * TEXT 比较即时间比较（`canonicalInstant` 的注释）。两端都是**闭区间**。
 *
 * 空 `memoryTypes` 与省略同义；`memory_type` 为 `NULL` 的行不命中任何 `IN` 列表，
 * 因此给了类型就自动排除非记忆节点。
 */
function metadataConditions(query: {
  readonly memoryTypes?: readonly string[];
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}): { readonly sql: readonly string[]; readonly params: readonly string[] } {
  const sql: string[] = [];
  const params: string[] = [];
  if (query.memoryTypes !== undefined && query.memoryTypes.length > 0) {
    sql.push(`n.memory_type IN (${placeholders(query.memoryTypes.length)})`);
    params.push(...query.memoryTypes);
  }
  if (query.updatedAfter !== undefined) {
    sql.push('n.updated_at >= ?');
    params.push(canonicalInstant(query.updatedAfter, 'updatedAfter'));
  }
  if (query.updatedBefore !== undefined) {
    sql.push('n.updated_at <= ?');
    params.push(canonicalInstant(query.updatedBefore, 'updatedBefore'));
  }
  return { sql, params };
}

/**
 * 权限谓词：节点对主体集合可读。
 *
 * 主体集合在 SQL 里出现两次（外层 allow、内层 deny 的排除），占位符复用同一个
 * 局部变量，绑定时按出现顺序展开成两段。`search` 与 `glob` 共用这一份。
 */
function permissionPredicate(principals: readonly string[]): {
  readonly sql: string;
  readonly params: readonly string[];
} {
  const principalList = placeholders(principals.length);
  return {
    sql: `EXISTS (
         SELECT 1 FROM node_permission p
         WHERE p.node_uri = n.uri
           AND p.principal IN (${principalList})
           AND p.level >= ${READ_LEVEL}
           AND p.effect = 'allow'
           AND NOT EXISTS (
             SELECT 1 FROM node_permission d
             WHERE d.node_uri = p.node_uri
               AND d.principal IN (${principalList})
               AND d.effect = 'deny'
           )
       )`,
    params: [...principals, ...principals],
  };
}

/**
 * `**\/` 最多展开几处。
 *
 * 每处 `**\/` 有两种含义（零层目录 / 至少一层），组合数是指数的。三处以内（8 条
 * GLOB）够用；超过就放弃精确化，退化成「整个子树」的过近似，由正则做最终判定。
 * 这条上限的代价只是多扫几行，不影响正确性。
 */
const MAX_GLOBSTAR_EXPANSIONS = 3;

/**
 * 把 `**\/` 展开成全部「零层 / 多层」组合。
 *
 * globstar 的标准语义是**零个或更多目录**：`**\/*.md` 必须能匹配直接子文件
 * `a.md`，也要能匹配 `x/y/a.md`。只保留「多层」那一种会让调用方以为工具坏了——
 * 它拿到的结果里恰好缺了最显眼的那批文件。
 */
function expandGlobstars(pattern: string): readonly string[] {
  const heads: string[] = [''];
  let rest = pattern;
  let expansions = 0;

  while (true) {
    const index = rest.indexOf('**/');
    if (index < 0) {
      break;
    }
    if (expansions >= MAX_GLOBSTAR_EXPANSIONS) {
      // 放弃精确化：过近似用子树通配，正则仍然会挡掉不匹配的节点。
      return [pattern];
    }
    expansions += 1;
    const prefix = rest.slice(0, index);
    rest = rest.slice(index + '**/'.length);
    const expanded = heads.flatMap((head) => [`${head}${prefix}`, `${head}${prefix}**/`]);
    heads.length = 0;
    heads.push(...expanded);
  }

  return heads.map((head) => `${head}${rest}`);
}

/**
 * 把 pattern 展开成 SQL 过近似 + 精确正则的备选集合。
 *
 * 绝对 pattern（`comem://...`）只生成一条，scope 由单独的路径范围子句约束；相对
 * pattern 相对每个 scope 展开，`comem://user/alice` + `**\/*.md` 会生成
 * `comem://user/alice/**\/*.md`。
 *
 * 每个 `**\/` 额外产出一条「零层」变形，所以一条 pattern 可能对上一个 scope 展开成
 * 多条 GLOB。GLOB 只是过近似（它的 `*` 跨 `/`），最终判定一律走 `exact`。
 */
function globAlternatives(pattern: string, scopes: readonly string[]): readonly GlobAlternative[] {
  const isAbsolute = pattern.toLowerCase().startsWith(URI_SCHEME);
  const bases = isAbsolute ? [''] : scopes.map((scope) => `${scope}/`);
  const patterns = expandGlobstars(pattern);
  return bases.flatMap((base) =>
    patterns.map((expanded) => {
      const full = `${base}${expanded}`;
      return { sqlPattern: globToSqlGlob(full), exact: globToRegExp(full) };
    }),
  );
}

export class SqliteFtsIndex implements RetrievalIndex {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #candidateMultiplier: number;

  constructor(options: SqliteFtsIndexOptions) {
    this.#db = options.db;
    this.#logger = options.logger;
    this.#candidateMultiplier = options.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
  }

  /**
   * 批量 upsert，单事务。
   *
   * FTS5 虚拟表不支持 `ON CONFLICT`，所以 `node_fts` 先按 `(uri, level)` 删再插。
   * 两条语句在同一事务里，中途失败会一起回滚，不会留下「node 有、fts 没有」的空洞。
   *
   * 冲突键是 `(uri, level)`：目录的 L0 摘要行与 L1 概览行是两个独立的检索行
   * （`0004_node_level_rows.sql`），写一行不能覆盖另一行。
   *
   * `abstract` 与 `content` 都写切分后的文本（§8.1）；`node` 表的 `abstract` 存原文，
   * 检索返回值取的是后者，所以摘要里的空格不会出现在用户可见内容里。
   */
  async upsert(records: readonly IndexRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    withWriteTransaction(this.#db, () => {
      const upsertNode = this.#db.prepare(
        `INSERT INTO node (
           uri, parent_uri, scope, kind, context_type, memory_type, level,
           abstract, body_digest, size, updated_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri, level) DO UPDATE SET
           parent_uri = excluded.parent_uri,
           scope = excluded.scope,
           kind = excluded.kind,
           context_type = excluded.context_type,
           memory_type = excluded.memory_type,
           level = excluded.level,
           abstract = excluded.abstract,
           body_digest = excluded.body_digest,
           size = excluded.size,
           updated_at = excluded.updated_at,
           status = excluded.status`,
      );
      const deleteFts = this.#db.prepare('DELETE FROM node_fts WHERE uri = ? AND level = ?');
      const insertFts = this.#db.prepare(
        'INSERT INTO node_fts (uri, level, abstract, content) VALUES (?, ?, ?, ?)',
      );

      for (const record of records) {
        upsertNode.run(
          record.uri,
          record.parentUri,
          record.scope,
          record.kind,
          record.contextType,
          record.memoryType,
          record.level,
          record.abstract,
          record.bodyDigest,
          record.size,
          record.updatedAt,
          record.status,
        );
        deleteFts.run(record.uri, record.level);
        insertFts.run(
          record.uri,
          record.level,
          segmentCjk(ftsAbstract(record)),
          segmentCjk(record.content),
        );
      }
    });
    this.#logger.debug('FTS5 索引写入', { count: records.length });
  }

  /**
   * 删除索引行。`recursive` 为真时按段边界删整棵子树。
   *
   * `node` 与 `node_fts` 都要删，单事务。返回 `void`（接口约定），删除行数只进日志——
   * 调用方要么删成功要么收到异常，不需要分支。
   */
  async deleteByUri(uri: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    const recursive = options.recursive ?? false;
    // 段边界：`uri = ?` 命中自身，`GLOB 前缀 + '/*'` 命中子树。
    const clause = recursive ? `uri = ? OR uri GLOB ?` : 'uri = ?';
    const params: SQLInputValue[] = recursive ? [uri, globPrefixPattern(uri)] : [uri];
    const deleted = withWriteTransaction(this.#db, () => {
      this.#db.prepare(`DELETE FROM node_fts WHERE ${clause}`).run(...params);
      return Number(this.#db.prepare(`DELETE FROM node WHERE ${clause}`).run(...params).changes);
    });
    this.#logger.debug('FTS5 索引删除', { uri, recursive, deleted });
  }

  /**
   * 全文检索。
   *
   * 过滤顺序：FTS5 匹配 → 路径范围（段边界）→ `contextTypes` / `levels` /
   * `memoryTypes` → 更新时间范围 → 状态 `active` → 权限 `EXISTS`。权限用相关子查询
   * 而不是先取候选再过滤，避免「取回的候选全无权限，最终返回不足 limit 条」（§8.2）。
   *
   * 排序用 `bm25()` 升序（越负越相关），返回时取负。`LIMIT` 是
   * `limit × candidateMultiplier`（§18）。
   */
  async search(query: SearchQuery): Promise<SearchHit[]> {
    validateSearchQuery(query);

    const phrase = toMatchExpression(query.text);
    // 纯空白查询切分后是空串，包出来就是 `""`。FTS5 对空短语返回空集，但对纯空格
    // 会抛语法错误，所以在这里提前返回，不依赖 SQL 的宽容度。
    if (phrase === '""') {
      return [];
    }

    const conditions: string[] = ['node_fts MATCH ?', ACTIVE_STATUS_PREDICATE];
    const params: SQLInputValue[] = [phrase];

    const scopes = scopeClause('n.uri', query.scopes);
    conditions.push(scopes.sql);
    params.push(...scopes.params);

    if (query.contextTypes !== undefined && query.contextTypes.length > 0) {
      conditions.push(`n.context_type IN (${placeholders(query.contextTypes.length)})`);
      params.push(...query.contextTypes);
    }
    if (query.levels !== undefined && query.levels.length > 0) {
      conditions.push(`n.level IN (${placeholders(query.levels.length)})`);
      params.push(...query.levels);
    }
    const metadata = metadataConditions(query);
    conditions.push(...metadata.sql);
    params.push(...metadata.params);

    const permission = permissionPredicate(query.principals);
    conditions.push(permission.sql);
    params.push(...permission.params);

    // `level` 也要参与 join：一个 URI 现在可能有两行 FTS（目录的 L0 与 L1），
    // 只按 `uri` 关联会让匹配行与另一层的行交叉成两条结果（同一次匹配被报两次，
    // 其中一条的 level / abstract 还是另一层的）。
    const sql = `SELECT n.uri, n.level, n.abstract, n.context_type, n.memory_type, bm25(node_fts) AS rank
       FROM node_fts
       JOIN node n ON n.uri = node_fts.uri AND n.level = node_fts.level
       WHERE ${conditions.join('\n         AND ')}
       ORDER BY bm25(node_fts) ASC
       LIMIT ?`;

    const candidateLimit = query.limit * this.#candidateMultiplier;
    params.push(candidateLimit);

    const hits: SearchHit[] = [];
    for (const row of this.#db.prepare(sql).all(...params)) {
      // bm25 是负数，取负转成「越大越相关」（见文件头）。
      const score = -Number(row['rank']);
      hits.push({
        uri: text(row['uri']),
        level: text(row['level']) as Level,
        abstract: nullableText(row['abstract']),
        score,
        contextType: text(row['context_type']) as ContextType,
        memoryType: nullableText(row['memory_type']),
      });
    }

    this.#logger.debug('FTS5 检索', {
      candidates: candidateLimit,
      returned: Math.min(hits.length, query.limit),
      contextTypes: query.contextTypes?.length ?? 0,
    });
    // SQL 取的是 limit × candidateMultiplier 条候选，多取的部分留给层级加权与
    // 去重（`services/search.ts` 的 `#rank`），最终对外仍然是 limit 条上限
    // （§8.2 的「候选不足」问题由权限子查询在 SQL 里解决）。
    return hits.slice(0, query.limit);
  }

  /**
   * 路径通配。
   *
   * SQL 侧用 GLOB 过近似（见 `globToSqlGlob`），精确匹配在 JS 侧做；两者之间用
   * `iterate()` 惰性读取，凑满 `limit` 就停，不会把整库结果全部读进内存。
   * 权限、路径范围、元数据与归档状态仍然由 SQL 过滤——不能把没有权限或已归档的
   * URI 读到内存再丢。归档状态与 `search` 用同一条谓词（`ACTIVE_STATUS_PREDICATE`），
   * 因为 `glob` 也是 `grep` 与向量检索的候选集来源。
   *
   * 排序按 uri 升序（`*` 的精确过滤不改变顺序），`LIMIT` 语义是「前 limit 条精确
   * 命中」，不是「前 limit 条过近似命中」。
   */
  async glob(query: GlobQuery): Promise<string[]> {
    validateGlobQuery(query);

    const alternatives = globAlternatives(query.pattern, query.scopes);
    // 只返回节点自身那一行：目录的 L1 概览行与 L0 行同 URI，不排除会让同一个目录
    // 在 `glob` 结果里出现两次（向量检索的候选集也来自这里，重复候选会白占名额）。
    const conditions = [
      `(${alternatives.map(() => 'n.uri GLOB ?').join(' OR ')})`,
      nodeSelfRowSql('n'),
      ACTIVE_STATUS_PREDICATE,
    ];
    const params: SQLInputValue[] = alternatives.map((alternative) => alternative.sqlPattern);

    const scopes = scopeClause('n.uri', query.scopes);
    conditions.push(scopes.sql);
    params.push(...scopes.params);

    // 向量检索的候选集同样在 SQL 里按元数据过滤（见 `GlobQuery` 的注释）。
    const metadata = metadataConditions(query);
    conditions.push(...metadata.sql);
    params.push(...metadata.params);

    const permission = permissionPredicate(query.principals);
    conditions.push(permission.sql);
    params.push(...permission.params);

    const sql = `SELECT n.uri FROM node n
       WHERE ${conditions.join('\n         AND ')}
       ORDER BY n.uri ASC`;

    const uris: string[] = [];
    for (const row of this.#db.prepare(sql).iterate(...params)) {
      const uri = text(row['uri']);
      if (!alternatives.some((alternative) => alternative.exact.test(uri))) {
        continue;
      }
      uris.push(uri);
      if (uris.length >= query.limit) {
        break;
      }
    }

    this.#logger.debug('FTS5 通配', { pattern: query.pattern, returned: uris.length });
    return uris;
  }

  /**
   * 一个节点的读模型（`node` 表的一行）。
   *
   * 只取节点自身那一行：目录的 L1 概览行与它同 URI，两个都取会让「这个目录多大、
   * 什么状态」变成两行互相矛盾的数据（`size` 是子项数、`abstract` 是 L0 摘要，
   * 只有 L0 行上才是节点自身的口径）。
   */
  async stat(uri: string): Promise<NodeStat | null> {
    const row = this.#db
      .prepare(
        `SELECT uri, kind, context_type, memory_type, size, updated_at, status, abstract
         FROM node WHERE uri = ? AND ${nodeSelfRowSql()}`,
      )
      .get(uri);
    if (row === undefined) {
      return null;
    }
    return {
      uri: text(row['uri']),
      kind: text(row['kind']) as NodeStat['kind'],
      contextType: text(row['context_type']) as ContextType,
      memoryType: nullableText(row['memory_type']),
      size: Number(row['size']),
      updatedAt: text(row['updated_at']),
      status: text(row['status']) as NodeStat['status'],
      abstract: nullableText(row['abstract']),
    };
  }
}
