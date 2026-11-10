/**
 * 索引重建命令（架构文档 §7「删库可重建」、§20 的运维链路）。
 *
 * **只从磁盘读，不信任 SQLite。** 索引坏了才是要重建的理由：拿 `node` 表当输入
 * 等于假设「坏掉的东西还能用」。这里遍历真实文件系统，重新解析 frontmatter、重新
 * 计算 digest、重新写 `node` / `node_fts` / `node_embedding`。
 *
 * ## 断点续跑
 *
 * 按 URI 升序处理，每一步都是幂等 upsert。中途失败（供应商抖动、进程被杀）后重跑：
 * 已写入的嵌入按 `content_digest` 判定为「没变」直接跳过，只处理剩下的。游标不必
 * 落盘——**磁盘是真相**，重跑重新遍历一遍就得到同一份候选集。
 *
 * ## 范围
 *
 * 重建**检索索引**（`node` / `node_fts`）、**向量**（`node_embedding`）与**记忆关联边**
 * （`memory_link` 的 `derived_from` 部分，从每份记忆文件的 `sources` 重算，§11.10）。
 * 物化权限（`node_permission`）不在这里重算：它由 `.acl.json` 与所有者推导，
 * 归属 `AclService` 的写路径（§8.2「写时算，读时查」）。索引损坏（表被删、写坏）
 * 而权限表完好是常态；整库丢失时权限要另走 ACL 重建，不在本命令的职责里。
 *
 * ## 输出约定
 *
 * 进度写 stderr（`ConsoleLogger` 与 `progress()` 都走 stderr），stdout 只留最终
 * 一行「成功了」。这样 `reindex > report.json` 拿到的是一份干净结果，而不是几万
 * 行进度。
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { ContentStore } from '../adapters/fs/content-store.js';
import { parseDocument, type ParsedDocument } from '../adapters/fs/frontmatter.js';
import { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { AiSdkEmbeddingProvider } from '../adapters/llm/embedding-provider.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { EmbeddingCacheRepository } from '../adapters/sqlite/embedding-cache.js';
import {
  EmbeddingRepository,
  createEmbeddingTable,
  type EmbeddingRow,
} from '../adapters/sqlite/embedding-repository.js';
import { MemoryLinkRepository } from '../adapters/sqlite/memory-link-repository.js';
import { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { NodeRow } from '../adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../adapters/sqlite/retrieval-index.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { NodeStatus, StatusField } from '../domain/node.js';
import { contextTypeOf, isVersionFile, parseStatusField, stableDigest } from '../domain/node.js';
import { parseValidityInstant, type IndexRecord } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';
import { EmbeddingService } from '../services/embedding.js';
import { MemoryLinkService } from '../services/memory-link.js';

import { loadCommandConfig } from './config.js';

export interface ReindexOptions {
  /** 数据根（测试注入用）；命令行传 `--data-dir` */
  readonly dataDir?: string;
  /** 配置文件路径（测试注入用）；命令行传 `--config` */
  readonly configPath?: string;
  /** 环境变量（测试注入用）；缺省 `process.env` */
  readonly env?: NodeJS.ProcessEnv;
  /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` / `--data-dir` 靠它生效 */
  readonly argv?: readonly string[];
  /** `--only=embeddings|index|links|all`，默认 all */
  readonly only?: 'embeddings' | 'index' | 'links' | 'all';
  readonly dryRun?: boolean;
}

export interface ReindexResult {
  /** 磁盘上的节点数（文件 + 目录）。`dryRun` 时是「会被处理」的数量 */
  readonly scanned: number;
  /** 实际写入的检索索引 / 向量条数 */
  readonly rewritten: number;
  /**
   * 本次写入 `node_embedding` 的行数（一个文件一条）。
   *
   * 与 `rewritten` 分开：`rewritten` 是「有东西被写回的节点数」，一次写入既可能
   * 只重写检索索引，也可能顺带补齐向量。切换 `retrieval.engine` 之后要回答的是
   * 「补齐了多少条向量」，只有这个字段能回答。
   */
  readonly vectors: number;
  /**
   * 本次按 `sources` 重建的 `derived_from` 边数（一条记忆可以有多条）。
   *
   * 与 `rewritten` 分开，理由同 `vectors`：一次重建既可能重写索引行，也可能顺带
   * 重算关联边。手工改过 `sources` 之后要回答的是「边重算了几条」，只有这个字段能答。
   */
  readonly links: number;
  /** 嵌入没变而跳过的文件数 */
  readonly skipped: number;
  /** 解析失败或嵌入降级的节点数 */
  readonly failed: number;
}

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/**
 * 维度变化时的备份表名。
 *
 * 普通表，不是虚拟表：`vec0` 的 shadow 表（`node_embedding_info` / `_chunks` …）
 * 不跟着 `ALTER TABLE ... RENAME` 改名，建同名新表会撞
 * `table "node_embedding_info" already exists`。复制成普通表是唯一能保留旧向量的做法。
 */
const EMBEDDING_BACKUP_TABLE = 'node_embedding_backup';

/**
 * 进度输出间隔。
 *
 * 100 是经验值：再密会把 stderr 刷成噪声（大库几十万行），再疏就看不到「卡在
 * 哪一段」。只在 stderr 输出，不影响 stdout 的结果行。
 */
const PROGRESS_INTERVAL = 100;

/** 秒 → 毫秒。`providers.embedding.timeoutSeconds` 是秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/** 文件是 L2 原文；目录自身是 L0 摘要（§8.5）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';
/** 目录概览行的层级（§8.5）：概览正文作为一条独立的检索行重建。 */
const OVERVIEW_LEVEL = 'L1';
/** 记忆 frontmatter 的保留键 `sources`（§11.10）：每一条是一个归档 URI。 */
const SOURCES_KEY = 'sources';
const ACTIVE_STATUS: NodeStatus = 'active';

interface DiskNode {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
}

interface FrontmatterFields {
  readonly memoryType: string | null;
  /** `status` 的三档结果：缺键 / 合法 / 键存在但非法（`domain/node.ts`）。 */
  readonly status: StatusField;
  /** 有效区间的起点（`valid_from`），UTC 形态；缺键/不可解析时是 `null` = 无界。 */
  readonly validFrom: string | null;
  /** 有效区间的终点（`valid_until`）；`null` = 仍然有效。 */
  readonly validUntil: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 记忆文件的 `memory_type` / `status` / `valid_from` / `valid_until`
 * （`IndexObserver` 的同一份映射）。
 *
 * 前两个是内存里的枚举 / 标识，直接判类型；有效期交给 `parseValidityInstant`：
 * 它把 YAML 读出来的数字、布尔、解析不了的串一律读作「无界」，并把合法值归一化成
 * `toISOString()` 形态。`memory.ts` / `index-observer.ts` 用的是同一个函数，
 * 所以同一份文件在这三条链路上得到同样的两列（对拍见
 * `tests/integration/services/frontmatter-validity-consistency.test.ts`）。
 */
function readFrontmatterFields(data: Readonly<Record<string, unknown>>): FrontmatterFields {
  const memoryType = data['memory_type'];
  return {
    memoryType: typeof memoryType === 'string' && memoryType !== '' ? memoryType : null,
    // YAML 的 `null`（`status:` / `status: null`）与数字、布尔、非法字符串一样
    // 都是「键存在但不可用」，不是缺键——缺键才是 `undefined`。
    status: parseStatusField(data['status']),
    validFrom: parseValidityInstant(data['valid_from']),
    validUntil: parseValidityInstant(data['valid_until']),
  };
}

/** 数据根下的两个 scope 目录（`user` / `group`）。不存在不是错误。 */
async function listRoots(dataDir: string): Promise<readonly Uri[]> {
  const roots: Uri[] = [];
  for (const scope of ['user', 'group'] as const) {
    let names: readonly string[];
    try {
      names = await readdir(join(dataDir, scope));
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const name of names) {
      try {
        roots.push(Uri.parse(`comem://${scope}/${name}`));
      } catch {
        // 不是合法根标识的目录（`_meta` 之外的临时产物）：`Uri` 表示不了，跳过。
      }
    }
  }
  return roots;
}

/**
 * 遍历磁盘上的全部节点。
 *
 * 用 `ContentStore.list` 而不是 `node:fs` 裸遍历：它已经处理了 NFC 规范化、
 * 保留名、临时文件过滤与「URI 表示不了的条目」——重写一遍这些规则只会让两处
 * 慢慢漂移。排序放在最后，保证重跑时处理顺序稳定（断点续跑的依据）。
 */
async function walkDataDir(dataDir: string, logger: Logger): Promise<readonly DiskNode[]> {
  const store = new ContentStore({ dataDir, logger });
  const nodes: DiskNode[] = [];

  for (const root of await listRoots(dataDir)) {
    const stat = await store.stat(root);
    if (stat === null) {
      continue;
    }
    nodes.push({ uri: root, kind: stat.kind });

    const stack: Uri[] = stat.kind === 'directory' ? [root] : [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      let children;
      try {
        children = await store.list(current);
      } catch (error) {
        if (error instanceof ComemError && error.code === 'NOT_FOUND') {
          continue;
        }
        throw error;
      }
      for (const child of children) {
        nodes.push({ uri: child.uri, kind: child.kind });
        if (child.kind === 'directory') {
          stack.push(child.uri);
        }
      }
    }
  }

  return nodes.sort((left, right) => {
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri === rightUri) {
      return 0;
    }
    return leftUri < rightUri ? -1 : 1;
  });
}

/**
 * 从磁盘重建一个节点的 `IndexRecord`（目录可能两条）。失败抛 `ComemError`
 * （坏 frontmatter 等）。
 *
 * 目录有摘要文件时返回两行：L0（`abstract` = L0 摘要）与 L1（`content` = 概览正文）。
 * 与写路径一致——概览正文是目录最丰富的那段可检索文本，重建索引时它同样从
 * `.overview.md` 里读出来，不能让 `reindex` 之后只有写路径生成过的目录才搜得到概览。
 *
 * 没有摘要文件时只返回 L0 行。此时磁盘上就没有概览可索引，残留的 L1 行会在下一次
 * 摘要生成时被覆盖（`SummaryService.#persistSummary` 两行一起写）。
 */
async function buildRecords(
  store: ContentStore,
  metadata: MetadataFileStore,
  logger: Logger,
  node: DiskNode,
  existing: NodeRow | null,
  /**
   * 文件节点已经解析好的磁盘内容；目录节点传 `null`。
   *
   * 由调用方读一次再传进来，因为同一份字节这次还要喂给向量与 `sources` 两条重建
   * 路径——三处各读一次会把「重扫一遍磁盘」变成随机读放大。
   */
  document: ParsedDocument | null,
): Promise<readonly IndexRecord[]> {
  const stat = await store.stat(node.uri);
  if (stat === null) {
    throw new ComemError('NOT_FOUND', `磁盘上的节点已不可寻址：${node.uri.toString()}`, {
      uri: node.uri.toString(),
    });
  }

  const contextType = contextTypeOf(node.uri);
  const parentUri = node.uri.parent()?.toString() ?? '';

  if (node.kind === 'directory') {
    const summary = await metadata.readSummary(node.uri);
    const base: IndexRecord = {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextType,
      memoryType: existing?.memoryType ?? null,
      level: DIRECTORY_LEVEL,
      abstract: summary.abstract === '' ? null : summary.abstract,
      content: '',
      bodyDigest: stableDigest(''),
      size: stat.size,
      updatedAt: stat.updatedAt,
      status: existing?.status ?? ACTIVE_STATUS,
    };
    if (summary.overview === '') {
      return [base];
    }
    return [
      base,
      {
        ...base,
        level: OVERVIEW_LEVEL,
        content: summary.overview,
        bodyDigest: stableDigest(summary.overview),
      },
    ];
  }

  if (document === null) {
    // 调用方约束：文件节点必须先把磁盘内容读出来。
    throw new ComemError('INTERNAL', '文件节点缺少磁盘解析结果。', { uri: node.uri.toString() });
  }
  const fields = readFrontmatterFields(document.data);
  const summary = document.data['summary'];
  // 与 `IndexObserver` 同一处置：记忆文件的 `status` 键存在但值非法时整份文档按
  // 不可解析的记忆处理，`memory_type = NULL`、`status = active`。保留旧值会让重建
  // 把「文件已经不可读」重写成「它仍是上次那条记忆」——索引与磁盘永久分叉。
  const invalidStatus = contextType === 'memory' && fields.status.kind === 'invalid';
  if (invalidStatus) {
    logger.warn('记忆文件的 status 不是合法状态，按不可解析的记忆文件处理', {
      uri: node.uri.toString(),
    });
  }

  return [
    {
      uri: node.uri.toString(),
      parentUri,
      scope: node.uri.scope,
      kind: 'document',
      contextType,
      // frontmatter 是记忆类型的唯一真相；读不出来时保留索引里的旧值。
      // `status` 非法时例外：那是整份文档不可解析，旧类型跟着一起作废。
      memoryType: invalidStatus ? null : (fields.memoryType ?? existing?.memoryType ?? null),
      level: DOCUMENT_LEVEL,
      abstract: typeof summary === 'string' && summary !== '' ? summary : null,
      content: document.body,
      bodyDigest: stableDigest(document.body),
      size: stat.size,
      updatedAt: stat.updatedAt,
      // 记忆文件：缺键 = active（历史文件），合法值照用，非法值已在上面按不可解析
      // 处理成 active。非记忆文件没有复核闸门语义，维持「保留索引旧值」。
      status:
        contextType === 'memory'
          ? fields.status.kind === 'value'
            ? fields.status.value
            : ACTIVE_STATUS
          : (fields.status.kind === 'value'
              ? fields.status.value
              : (existing?.status ?? ACTIVE_STATUS)),
      // 有效期**不保留索引旧值**：磁盘是真相，缺键就是无界（与写路径同一个口径）。
      validFrom: fields.validFrom,
      validUntil: fields.validUntil,
    },
  ];
}

/**
 * `derived_from` 边的匹配文本。
 *
 * `sources` 只给归档 URI，写路径也固定写空串（`MemoryLinkService.rebuildDerived`），
 * 所以重建出来的边没有匹配文本。它仍然占去重键的一维：唯一索引是三列。
 */
const DERIVED_MATCH_TEXT = '';

/** 一条待写入的 `derived_from` 边。 */
interface DerivedEdge {
  readonly from: Uri;
  readonly to: Uri;
  readonly matchText: string;
}

/**
 * `derived_from` 边的去重键：三列逐一对应
 * `memory_link_unique(from_uri, to_uri, match_text)`（`0003_memory_link.sql`）。
 *
 * 重建直接 INSERT（`replaceByLinkType` 刚把这一类边删空），重复的三元组会撞唯一键
 * 让整批回滚，所以去重口径必须与索引一致。按 `(from, to)` 两列去重时，表说三列唯一、
 * 重建说两列唯一：一旦某个产生端填了匹配文本，同一个 `from → to` 的两条边就会被静默
 * 吞掉一条，而表允许它们共存。
 *
 * 导出是给用例钉住这个口径的（`tests/integration/commands/reindex.test.ts`）。
 */
export function derivedEdgeKey(edge: DerivedEdge): string {
  return `${edge.from.toString()}\n${edge.to.toString()}\n${edge.matchText}`;
}

/**
 * 从一份记忆文件的 `sources` 收集 `derived_from` 边（`from` = 记忆自身，`to` = 来源）。
 *
 * 语义与写路径一致（§11.10）：`sources` 里的每一条归档 URI 对应一条边，
 * `link_type = 'derived_from'`、`weight = 1.0`、`match_text` / `description` 为空
 * ——产生端（`MemoryMergeStep` / `ExperienceDistillStep`）从不给这三个字段填内容。
 *
 * **只收记忆文件。** `sources` 是记忆的保留键（§6.6）；资源 / 技能文件的 frontmatter
 * 里出现同名键不是溯源，给它建边会让 `backlinks` 混进无关节点。
 *
 * **跳过 `.history` 下的版本文件。** 写路径只在归档时给当时的规范文件写边；版本
 * 快照是覆盖写留下的旧值，从不产生边。把它们算进来，重建会造出写路径永远不会写出
 * 的边（同一个 identity 的每一份历史都会多一条）。
 *
 * **不检查终点是否存在。** `sources` 是真相：归档被清理之后那条溯源仍然成立，反查
 * 「哪些记忆来自这次归档」也仍然有意义。查存在性还会让同一份 `sources` 因为磁盘
 * 现状不同而得到不同的边，重建不再幂等（§11.10「悬空边写时不拦、读时容忍」）。
 *
 * 不合法的来源值跳过并记 `warn`：反查时终点用 `Uri.parse` 还原，一个非法值会让整次
 * 反查抛错。手改 `sources` 撞出重复值时按 `derivedEdgeKey()` 去重——那是唯一索引的
 * 三列，少一列就会让一次插入撞键、整批回滚。
 */
function collectDerivedEdges(
  uri: Uri,
  rawSources: unknown,
  target: DerivedEdge[],
  seen: Set<string>,
  logger: Logger,
): void {
  if (contextTypeOf(uri) !== 'memory' || isVersionFile(uri)) {
    return;
  }
  if (!Array.isArray(rawSources)) {
    return;
  }
  for (const value of rawSources) {
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    const to = Uri.tryParse(value);
    if (to === null) {
      logger.warn('记忆来源不是合法 URI，重建关联边时跳过。', {
        uri: uri.toString(),
        source: value,
      });
      continue;
    }
    const edge: DerivedEdge = { from: uri, to, matchText: DERIVED_MATCH_TEXT };
    const key = derivedEdgeKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    target.push(edge);
  }
}

function progress(
  scanned: number,
  total: number,
  rewritten: number,
  skipped: number,
  failed: number,
): void {
  process.stderr.write(
    `reindex: ${scanned}/${total} 已扫描，重写 ${rewritten}，跳过 ${skipped}，失败 ${failed}\n`,
  );
}

/**
 * 向量阶段的进度行。
 *
 * 与索引阶段的 `progress()` 分开：`--only=all` 里两段各自从 0 数到总数，共用一个
 * 分母会让「已扫描」在第二段开头倒退，读起来像是重跑了一遍。
 */
function progressVectors(
  processed: number,
  total: number,
  embedded: number,
  skipped: number,
  failed: number,
): void {
  process.stderr.write(
    `reindex: 向量 ${processed}/${total} 已处理，补齐 ${embedded}，跳过 ${skipped}，失败 ${failed}\n`,
  );
}

interface EmbeddingBackup {
  readonly model: string;
  readonly dimension: number;
}

/**
 * 把当前向量表复制到备份表，返回它的模型与维度。
 *
 * `vec0` 的向量列能直接 `SELECT` 出来（BLOB），也能原样写回同维度的新表，所以备份
 * 是一次 `CREATE TABLE ... AS SELECT`，不需要逐行读向量。
 */
function backupEmbeddings(db: DatabaseSync): EmbeddingBackup {
  const row = db.prepare('SELECT model, dimension FROM embedding_model WHERE id = 1').get();
  const dimension = Number(row?.['dimension']);
  const model = String(row?.['model'] ?? '');
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new ComemError('INTERNAL', '向量表缺少维度元数据，无法备份重建。', { dimension });
  }
  db.exec(`DROP TABLE IF EXISTS ${EMBEDDING_BACKUP_TABLE}`);
  db.exec(`CREATE TABLE ${EMBEDDING_BACKUP_TABLE} AS
    SELECT uri, model, content_digest, embedding FROM node_embedding`);
  return { model, dimension };
}

/**
 * 回滚：删掉按新维度建的表，按备份的维度重建，再把行写回去。
 *
 * 元数据行也要改回旧维度——否则下次启动时 `ensureSchema` 会认为「库里的维度与
 * 配置一致」，而实际表是旧维度，写入时报一句没有上下文的 SQL 错误。
 */
function restoreEmbeddings(db: DatabaseSync, backup: EmbeddingBackup, logger: Logger): void {
  db.exec('DROP TABLE IF EXISTS node_embedding');
  db.exec('DELETE FROM embedding_model WHERE id = 1');
  createEmbeddingTable(db, backup.dimension);
  db.exec(`INSERT INTO node_embedding (uri, model, content_digest, embedding)
    SELECT uri, model, content_digest, embedding FROM ${EMBEDDING_BACKUP_TABLE}`);
  db.prepare(
    'INSERT INTO embedding_model (id, model, dimension, created_at) VALUES (1, ?, ?, ?)',
  ).run(backup.model, backup.dimension, new Date().toISOString());
  logger.warn('向量表重建失败，已回滚到旧维度。', { dimension: backup.dimension });
}

/**
 * 「这个节点缺向量」的 SQL 谓词，**唯一一处**。
 *
 * 别名约定：`node` 表是 `n`，`node_embedding` 表是 `e`；绑定参数依次是
 * 「空正文的摘要」与「当前模型」。两处生产调用方（启动提醒、启动回填的候选集）必须拼
 * 同一份子句——分两处写，迟早分叉成「启动说没缺、回填还在干活」或者「启动永远在报、
 * 回填却无事可做」。
 *
 * 三条子句各挡一类行：
 * - `kind = 'document'`：目录行（含 L1 概览行，它的 `body_digest` 非空）不参与语义检索；
 * - `body_digest <> 空正文摘要`：空文件没有可嵌的正文，嵌了也搜不出东西；
 * - `NOT EXISTS`：同 `model` 且同摘要的向量已经存在，说明这一条是最新的。
 *
 * **基准是索引里的 `node.body_digest`，不是磁盘正文。** 这是有意的：这条判定要能
 * 在启动时一次 SQL 扫完（1 万行实测约 90 毫秒），读盘做不了。索引落后于磁盘时它
 * 会漏报（`tests/integration/sqlite/embedding-freshness-consistency.test.ts` 记着
 * 这个边界），修索引是 `pnpm reindex --only=index` 的职责。
 */
const MISSING_VECTOR_WHERE = `n.kind = 'document'
          AND n.body_digest <> ?
          AND NOT EXISTS (
            SELECT 1 FROM node_embedding e
             WHERE e.uri = n.uri AND e.model = ? AND e.content_digest = n.body_digest
          )`;

/**
 * 「库里有记忆但没有向量」的存在性判断（`LIMIT 1`）。
 *
 * 启动提醒（`bootstrap/main.ts` 的 `warnIfVectorsMissing`）用它，与启动回填的候选集
 * （`documentsMissingVectors`）共用 `MISSING_VECTOR_WHERE`。
 *
 * 只回答有没有，不回答多少条：条数是 `runReindex` 输出里的「补齐向量 N 条」。
 * 有缺失时第一条就返回；没有缺失时最坏扫一遍 `node`。
 */
export function hasDocumentsMissingVectors(db: DatabaseSync, model: string): boolean {
  const missing = db
    .prepare(`SELECT 1 AS missing FROM node n WHERE ${MISSING_VECTOR_WHERE} LIMIT 1`)
    .get(stableDigest(''), model);
  return missing !== undefined;
}

/**
 * 缺向量的文档 URI，按 URI 升序（`reindex` 的断点续跑顺序）。
 *
 * 启动回填（`bootstrap/main.ts` 的 `backfillMissingVectors`）用它拿候选集。它不读盘，
 * 所以只认 `node` 行——磁盘上有文件而索引里没有行的节点不在这里，那是对账 / 重建
 * 索引的职责（`reindex --only=index`）。
 */
export function documentsMissingVectors(db: DatabaseSync, model: string): readonly string[] {
  const rows = db
    .prepare(`SELECT n.uri AS uri FROM node n WHERE ${MISSING_VECTOR_WHERE} ORDER BY n.uri`)
    .all(stableDigest(''), model);
  return rows.map((row) => String(row['uri']));
}

/** 一批回填结束时的进度。`remaining` 是还没处理的候选数（不含本批）。 */
export interface EmbedMissingNodesProgress {
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly remaining: number;
}

export interface EmbedMissingNodesResult {
  /** 本次写了向量的 URI（升序）。调用方用它算「有东西被写回的节点数」。 */
  readonly embeddedUris: readonly string[];
  /** 磁盘正文摘要与库里那一行一致的节点数（没打供应商）。 */
  readonly skipped: number;
  /** 读盘 / 解析 / 嵌入 / 写入失败的 URI，同一个节点只出现一次。 */
  readonly failedUris: readonly string[];
  /** 是否被 `signal` 中止。已写入的批次不回滚。 */
  readonly aborted: boolean;
}

export interface EmbedMissingNodesDeps {
  readonly embeddings: EmbeddingRepository;
  readonly embedding: EmbeddingService;
  readonly store: ContentStore;
  readonly logger: Logger;
  /**
   * 每批的节点数。
   *
   * 它同时决定一次 `embedding.embed()` 里最多几条正文（服务内部还会按供应商的
   * `maxBatchSize` 再切片）。CLI 传 1：与抽取前的「一个节点一次调用」逐条一致，
   * 降级只影响当前节点、断点续跑的进度也是按节点计的；启动回填传供应商的批大小。
   */
  readonly batchSize: number;
  /** 中止信号。只在批与批之间检查，并透传给在途的供应商调用。 */
  readonly signal?: AbortSignal;
  /** 每批结束回调（启动回填用它记进度；CLI 用它打进度行）。 */
  readonly onBatch?: (progress: EmbedMissingNodesProgress) => void;
}

/**
 * 给一批节点补齐向量：**候选 URI → 读盘 → 解析正文 → 嵌入 → 写 `node_embedding`**。
 *
 * 两处调用方共用它：
 * - `runReindex --only=embeddings`（以及 `--only=all` 的向量那一段）：候选集是磁盘
 *   遍历出来的文件——`reindex` 的输入永远是磁盘，不能因为索引里没有这一行就漏掉；
 * - 启动回填（`bootstrap/main.ts`）：候选集是 `documentsMissingVectors`。
 *
 * **摘要与正文都从磁盘读，不拿 `node.body_digest` 当输入。** `node` 行可能落后于
 * 磁盘，用它的摘要配上刚读出的正文，会写出「digest 对得上索引、向量来自另一份正文」
 * 的行——这种行最难查：检索命中的是旧内容，而启动探测与下一次 reindex 都认为它是最新的。
 *
 * 每个节点先拿刚算出的摘要与库里那一行比，一致就跳过（不打供应商）；不一致才嵌。
 * 失败只记 warn 并继续：一个读不出来的文件、一次供应商抖动都不该让剩下的记忆永远
 * 没有向量（`EmbeddingService` 的熔断会在连续失败后短路，继续下一批不会猛打供应商）。
 */
export async function embedMissingNodes(
  uris: readonly string[],
  deps: EmbedMissingNodesDeps,
): Promise<EmbedMissingNodesResult> {
  const { embeddings, embedding, store, logger, batchSize, signal } = deps;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new ComemError('INVALID_ARGUMENT', '回填向量的批大小必须是正整数。', { batchSize });
  }
  const model = embedding.model;
  if (model === null) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '回填向量需要配置 providers.embedding（当前是 disabled）。',
    );
  }
  const aborted = (): boolean => signal?.aborted === true;

  const embeddedUris: string[] = [];
  let skipped = 0;
  const failed = new Set<string>();

  for (let start = 0; start < uris.length; start += batchSize) {
    if (aborted()) {
      return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
    }
    const batch = uris.slice(start, start + batchSize);

    // 1) 读盘 + 跳过判定。摘要从磁盘正文算，与库里那一行比——不与 `node.body_digest`
    // 比，也不拿它当写入的摘要（见文件头与上面的说明）。
    const pending: { readonly uri: string; readonly body: string; readonly digest: string }[] =
      [];
    for (const uri of batch) {
      try {
        const bytes = await store.readBytes(Uri.parse(uri));
        const document = parseDocument(Buffer.from(bytes).toString('utf8'));
        if (document.body === '') {
          continue;
        }
        const digest = stableDigest(document.body);
        const current = embeddings.get(uri);
        if (current !== null && current.model === model && current.contentDigest === digest) {
          skipped += 1;
          continue;
        }
        pending.push({ uri, body: document.body, digest });
      } catch (error) {
        failed.add(uri);
        logger.warn('读取正文失败，跳过该节点的向量。', { uri, error: errorMessage(error) });
      }
    }

    // 收到退出信号时不要再打供应商：已经补好的写入保留，剩下的下次启动再来。
    if (aborted()) {
      return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
    }

    // 2) 一次调用嵌一批，再一次事务写一批。
    if (pending.length > 0) {
      const outcome = await embedding.embed(
        pending.map((candidate) => candidate.body),
        signal === undefined ? {} : { signal },
      );
      if (outcome.degraded) {
        // 关闭信号打断的调用不算节点失败：它没有「失败」，只是下次再做。
        if (aborted()) {
          return { embeddedUris, skipped, failedUris: [...failed], aborted: true };
        }
        for (const candidate of pending) {
          failed.add(candidate.uri);
        }
        logger.warn('嵌入降级，跳过这一批的向量写入。', {
          count: pending.length,
          reason: outcome.reason ?? '没有返回向量。',
        });
      } else {
        const rows: EmbeddingRow[] = [];
        for (const [index, candidate] of pending.entries()) {
          const vector = outcome.vectors[index];
          if (vector === undefined) {
            failed.add(candidate.uri);
            continue;
          }
          rows.push({
            uri: candidate.uri,
            model,
            contentDigest: candidate.digest,
            vector,
          });
        }
        if (rows.length > 0) {
          try {
            embeddings.upsert(rows);
            for (const row of rows) {
              embeddedUris.push(row.uri);
            }
          } catch (error) {
            for (const row of rows) {
              failed.add(row.uri);
            }
            logger.warn('向量写入失败，跳过这一批。', {
              count: rows.length,
              error: errorMessage(error),
            });
          }
        }
      }
    }

    deps.onBatch?.({
      embedded: embeddedUris.length,
      skipped,
      failed: failed.size,
      remaining: uris.length - (start + batch.length),
    });
  }

  return { embeddedUris, skipped, failedUris: [...failed], aborted: aborted() };
}

/**
 * 重建索引。
 *
 * `dryRun` 不打开数据库：`openDatabase` 会创建文件、`runMigrations` 会写
 * `schema_version`，那就不是「只报数不改」了。dry-run 只遍历磁盘并报告
 * `scanned`，其余计数保持 0——它们描述的是「实际写入了什么」。
 */
export async function runReindex(options: ReindexOptions = {}): Promise<ReindexResult> {
  // 统一入口：`configPath` / `dataDir` 是测试注入用的显式覆盖，真实 `--config` /
  // `--data-dir` 从 `options.argv` 解析（缺省 `process.argv.slice(2)`）。只合成
  // `--data-dir` 会把真实 `--config` 丢掉，那正是这个入口要消灭的静默失败。
  const config = loadCommandConfig({
    ...(options.configPath === undefined ? {} : { path: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    argv: [
      ...(options.dataDir === undefined ? [] : ['--data-dir', options.dataDir]),
      ...(options.argv ?? process.argv.slice(2)),
    ],
  });
  const only = options.only ?? 'all';
  const dryRun = options.dryRun ?? false;

  // 进度与诊断都走 stderr；stdout 只留最终结果。
  const logger = new ConsoleLogger({
    level: config.logging.level,
    write: (line) => process.stderr.write(line),
  });

  const nodes = await walkDataDir(config.dataDir, logger);
  if (dryRun) {
    progress(0, nodes.length, 0, 0, 0);
    return { scanned: nodes.length, rewritten: 0, vectors: 0, links: 0, skipped: 0, failed: 0 };
  }

  const embeddingConfig = config.providers.embedding;
  const needsEmbeddings = only === 'embeddings' || only === 'all';
  const needsIndex = only === 'index' || only === 'all';
  const needsLinks = only === 'links' || only === 'all';
  if (needsEmbeddings && embeddingConfig.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '重算嵌入需要配置 providers.embedding（当前是 disabled）。',
      { only },
    );
  }

  // 数据根可能还没建过 `_meta`（全新目录 / 只恢复了内容文件）：`openDatabase`
  // 不会替调用方建父目录。
  await mkdir(join(config.dataDir, META_DIRECTORY), { recursive: true });
  const db = openDatabase(join(config.dataDir, META_DIRECTORY, DATABASE_FILE));
  /** 维度变化时的备份；成功回填之后删掉，抛错时用它回滚。 */
  let backup: EmbeddingBackup | null = null;
  try {
    runMigrations(db);

    const store = new ContentStore({ dataDir: config.dataDir, logger });
    const metadata = new MetadataFileStore({ dataDir: config.dataDir, logger });
    const index = new SqliteFtsIndex({
      db,
      logger,
      candidateMultiplier: config.retrieval.candidateMultiplier,
    });
    const nodeRepository = new NodeRepository({ db, logger });
    const embeddings = new EmbeddingRepository({ db, logger });
    const memoryLink = new MemoryLinkService({
      repository: new MemoryLinkRepository({ db, logger }),
      logger,
    });
    const embedding = new EmbeddingService({
      // 回填同样走缓存：同一份正文在「回填」与「写路径」之间的结果必须一致，
      // 否则第二次重建会重复打供应商。
      cache: embeddingConfig.cache.enabled
        ? new EmbeddingCacheRepository({ db, logger, maxEntries: embeddingConfig.cache.maxEntries })
        : null,
      provider:
        embeddingConfig.type === 'disabled'
          ? null
          : new AiSdkEmbeddingProvider({
              type: embeddingConfig.type,
              ...(embeddingConfig.baseUrl === ''
                ? {}
                : { baseUrl: embeddingConfig.baseUrl }),
              model: embeddingConfig.model,
              apiKey: embeddingConfig.apiKey,
              dimension: embeddingConfig.dimension,
              maxBatchSize: embeddingConfig.maxBatchSize,
              timeoutSeconds: embeddingConfig.timeoutSeconds,
              logger,
            }),
      logger,
      config: {
        dimension: embeddingConfig.dimension,
        maxBatchSize: embeddingConfig.maxBatchSize,
        timeoutMs: embeddingConfig.timeoutSeconds * MILLISECONDS_PER_SECOND,
      },
    });

    const model = embedding.model;
    let vectors = 0;
    let links = 0;
    let skipped = 0;
    /** 有东西被写回的节点（索引行或向量）。`rewritten` 是它的大小，一个节点算一次。 */
    const rewrittenUris = new Set<string>();
    /** 失败的节点。索引与向量两条路径可能都失败，同一个节点仍只算一次。 */
    const failedUris = new Set<string>();
    /** 按 `sources` 收集到的 `derived_from` 边；循环结束后一次整批替换。 */
    const derivedEdges: DerivedEdge[] = [];
    const seenEdges = new Set<string>();

    // 维度变了要整表重建：`vec0` 的维度固定在 `CREATE VIRTUAL TABLE` 时，旧表里的
    // 向量一条都用不了。先备份，回填成功后再删；中途抛错就回滚到旧维度。
    //
    // 「没有元数据行」不是变化：全新库 / 只跑过 `--only=index` 的库由
    // `ensureSchema` 直接建表。
    if (needsEmbeddings) {
      const stored = embeddings.storedDimension();
      if (stored !== null && stored !== embeddingConfig.dimension) {
        backup = backupEmbeddings(db);
        db.exec('DROP TABLE node_embedding');
        db.exec('DELETE FROM embedding_model WHERE id = 1');
        logger.info('向量维度变化，已备份旧表并重建。', {
          stored,
          configured: embeddingConfig.dimension,
          backup: EMBEDDING_BACKUP_TABLE,
        });
      }
      embeddings.ensureSchema(embeddingConfig.dimension, embeddingConfig.model);
    }

    // 检索索引与关联边共用一次读盘：两条重建路径都要正文与 frontmatter。
    // 向量走 `embedMissingNodes`（它自己读盘，见下面的调用），不复用这里的解析结果：
    // 回填要独立成一个函数给启动路径用，先读一份再传进去会把两边的批处理边界缠在一起。
    if (needsIndex || needsLinks) {
      for (const [indexInBatch, node] of nodes.entries()) {
        const uri = node.uri.toString();
        const existing = nodeRepository.get(uri);

        try {
          const document =
            node.kind === 'file'
              ? parseDocument(Buffer.from(await store.readBytes(node.uri)).toString('utf8'))
              : null;

          // 1) 检索索引：按磁盘内容重建 `node` + `node_fts`。
          if (needsIndex) {
            await index.upsert(await buildRecords(store, metadata, logger, node, existing, document));
            rewrittenUris.add(uri);
          }

          // 2) 关联边：只收集，结束前一次整批替换（见循环后的 `rebuildDerived`）。
          if (needsLinks && document !== null) {
            collectDerivedEdges(node.uri, document.data[SOURCES_KEY], derivedEdges, seenEdges, logger);
          }
        } catch (error) {
          // 坏文件（frontmatter 不合法、读盘失败）只影响自己：整批中断会让「一个
          // 坏文件卡住全库重建」，而 reindex 的用途恰恰是修复。
          failedUris.add(uri);
          logger.warn('重建索引跳过节点', { uri, error: errorMessage(error) });
        }

        if ((indexInBatch + 1) % PROGRESS_INTERVAL === 0) {
          progress(indexInBatch + 1, nodes.length, rewrittenUris.size, skipped, failedUris.size);
        }
      }
    }

    // 3) 向量：候选集是磁盘上的文件。不从 `node` 表拿——`reindex` 的输入永远是磁盘，
    // 「索引里没有这一行」正是它要修的状态之一（断点续跑用例覆盖了这种库）。
    if (needsEmbeddings && model !== null) {
      const candidates = nodes
        .filter((node) => node.kind === 'file')
        .map((node) => node.uri.toString());
      const embedded = await embedMissingNodes(candidates, {
        store,
        embeddings,
        embedding,
        logger,
        // 逐条：一次供应商调用只对应一个节点，降级只影响它；断点续跑按节点计。
        batchSize: 1,
        onBatch: ({ remaining, embedded: done, skipped: skippedCount, failed }) => {
          const processed = candidates.length - remaining;
          if (processed % PROGRESS_INTERVAL === 0) {
            progressVectors(processed, candidates.length, done, skippedCount, failed);
          }
        },
      });
      vectors = embedded.embeddedUris.length;
      skipped = embedded.skipped;
      for (const uri of embedded.embeddedUris) {
        rewrittenUris.add(uri);
      }
      for (const uri of embedded.failedUris) {
        failedUris.add(uri);
      }
    }

    // `sources` 是真相：整批替换 `derived_from`，把表里多出来的旧边一起清掉。
    // 放在循环之后、一个短事务里：读盘与嵌入都不在事务内，重启后重跑得到同一份边。
    // 读不出来的文件（frontmatter 坏了）不贡献边，它在表里的旧边会被这次替换清掉；
    // 修好文件再跑一次就恢复——重建的输入永远只有磁盘，不拿旧边当兜底。
    if (needsLinks) {
      links = memoryLink.rebuildDerived(derivedEdges).inserted;
      logger.info('记忆关联边已重建。', { edges: links, memories: nodes.length });
    }

    progress(nodes.length, nodes.length, rewrittenUris.size, skipped, failedUris.size);
    if (backup !== null) {
      db.exec(`DROP TABLE IF EXISTS ${EMBEDDING_BACKUP_TABLE}`);
    }
    return {
      scanned: nodes.length,
      rewritten: rewrittenUris.size,
      vectors,
      links,
      skipped,
      failed: failedUris.size,
    };
  } catch (error) {
    // 单个节点的失败在循环里已经计入 `failed`，走到这里的只有全局故障（磁盘满、
    // 表结构被外部改坏）。旧表还在备份表里，先还原再往上抛。
    if (backup !== null) {
      try {
        restoreEmbeddings(db, backup, logger);
      } catch (restoreError) {
        // 回滚自己失败时不能盖掉原始错误：那会让「为什么重建失败」变成「为什么
        // 回滚失败」。备份表留在库里，运维还能手工恢复。
        logger.error('回滚向量表失败，旧向量保留在备份表。', {
          backup: EMBEDDING_BACKUP_TABLE,
          reason: errorMessage(restoreError),
        });
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

/** 解析 `--only` 的取值。非法值直接抛 `INVALID_ARGUMENT`，不静默取默认。 */
function parseOnly(raw: string): ReindexOptions['only'] {
  if (raw === 'embeddings' || raw === 'index' || raw === 'links' || raw === 'all') {
    return raw;
  }
  throw new ComemError(
    'INVALID_ARGUMENT',
    `--only 只支持 embeddings | index | links | all：${raw}`,
    { only: raw },
  );
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = `--${name}`;
  for (const [index, arg] of argv.entries()) {
    if (arg === prefixed) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${prefixed}=`)) {
      return arg.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

/**
 * 只解析命令自己的参数。`--config` / `--data-dir` 归 `loadCommandConfig` 解析：
 * 在这里再读一遍就会多一份「哪个 flag 算配置」的实现，漏一个就静默失效。
 */
function parseArgs(argv: readonly string[]): ReindexOptions {
  const only = readFlag(argv, 'only');
  return {
    ...(only === undefined ? {} : { only: parseOnly(only) }),
    ...(argv.includes('--dry-run') ? { dryRun: true } : {}),
  };
}

/** 只有直接执行（`tsx src/commands/reindex.ts`）时才跑 CLI 入口，测试 import 不触发。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  runReindex({ ...parseArgs(argv), argv }).then(
    (result) => {
      process.stdout.write(
        `reindex 完成：扫描 ${result.scanned}，重写 ${result.rewritten}，补齐向量 ${result.vectors} 条，重建关联边 ${result.links} 条，跳过 ${result.skipped}，失败 ${result.failed}。\n`,
      );
    },
    (error: unknown) => {
      process.stderr.write(`reindex 失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
