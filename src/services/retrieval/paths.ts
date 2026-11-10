/**
 * 负责：`grep`（读文件做正则行匹配）与 `glob`（路径通配）两个路径型检索面。
 * 不负责：索引内的词/向量检索，也不把元数据（类型、层级、时间）收窄套到这两个面上。
 */

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { GrepHit, RetrievalIndex } from '../../domain/retrieval.js';
import { Uri } from '../../domain/uri.js';

import type { Authorizer } from '../authorizer.js';
import type { FileSystemService } from '../filesystem.js';
import { elapsedMs, resolveLimit } from './budget.js';
import type { FindOptions } from './types.js';

/**
 * `grep` 的默认前后文行数。
 *
 * 3：经验值，来源未知。§13.2 的 `grep` 工具契约没给默认；取 3 与 `grep -C 3` 的
 * 常见用法一致——再少看不出上下文，再多就是在读文件。
 */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * `grep` 最多读多少个候选文件。
 *
 * 200：经验值，来源未知。作用是挡住 `.*` 读穿整个库：tmpfs 上 200 个文件约
 * 20–200ms，真实磁盘上是它的数倍；再往上单次 `grep` 会进入秒级，而用户拿到的
 * 还只是前 `limit` 条命中。
 */
const GREP_CANDIDATE_LIMIT = 200;

/**
 * `grep` 的候选集来源：`**` 在 `index.glob` 里展开成「scope 下全部节点」。
 *
 * 不用 `*`：`*` 不跨 `/`（只匹配直接子项），而 `grep` 要扫整棵子树。
 */
const GREP_CANDIDATE_PATTERN = '**';

/** 路径型检索面的依赖：索引给候选，filesystem 读正文，authorizer 做第二遍可读性过滤。 */
export interface PathSearchDeps {
  readonly index: RetrievalIndex;
  readonly filesystem: FileSystemService;
  readonly authorizer: Authorizer;
  readonly logger: Logger;
}

export class PathSearch {
  readonly #index: RetrievalIndex;
  readonly #filesystem: FileSystemService;
  readonly #authorizer: Authorizer;
  readonly #logger: Logger;

  constructor(deps: PathSearchDeps) {
    this.#index = deps.index;
    this.#filesystem = deps.filesystem;
    this.#authorizer = deps.authorizer;
    this.#logger = deps.logger;
  }

  /**
   * §8.4 的 `grep`：正则 + 路径范围，行级命中带前后文。
   *
   * 先 `index.glob` 拿权限过滤后的候选，再逐个读文件做行匹配（见文件头）。候选
   * 文件数超过 `GREP_CANDIDATE_LIMIT` 时记 warn 并截断——截断必须留痕，否则
   * 用户会以为「没有更多命中」。
   *
   * `contextTypes` / `levels` / `memoryTypes` / 时间范围不生效：`grep` 的候选集
   * 是「路径下全部文件」，按元数据收窄会把「正则明明匹配、只是类型不同」的文件
   * 从结果里静默拿掉。那三个维度只给检索用（`#readableUris` 与 FTS5 的 SQL）。
   */
  async grep(
    pattern: string,
    options: FindOptions & { readonly contextLines?: number },
  ): Promise<readonly GrepHit[]> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    if (!Number.isInteger(contextLines) || contextLines < 0) {
      throw new ComemError('INVALID_ARGUMENT', 'contextLines 必须是非负整数。', { contextLines });
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ComemError('INVALID_ARGUMENT', `grep 的正则不合法：${reason}`, {
        pattern,
        reason,
      });
    }

    // 多要一条用来判断「是否被截断」，不能只看返回条数是否等于上限。
    const candidates = await this.#index.glob({
      pattern: GREP_CANDIDATE_PATTERN,
      scopes: options.scopes,
      principals: options.principals,
      limit: GREP_CANDIDATE_LIMIT + 1,
    });
    if (candidates.length > GREP_CANDIDATE_LIMIT) {
      this.#logger.warn('grep 候选文件数超过上限，已截断', {
        candidates: candidates.length,
        limit: GREP_CANDIDATE_LIMIT,
      });
    }

    const hits: GrepHit[] = [];
    let scanned = 0;
    for (const value of candidates.slice(0, GREP_CANDIDATE_LIMIT)) {
      if (hits.length >= limit) {
        break;
      }
      const uri = Uri.tryParse(value);
      if (uri === null) {
        continue;
      }
      scanned += 1;

      let text: string;
      try {
        text = (await this.#filesystem.read(uri, options.principals)).text;
      } catch (error) {
        // 索引与磁盘短暂不一致（刚删、刚移动）是正常状态：跳过这一条，
        // 不打断整次 grep。权限在 filesystem 里已经拒过，同样跳过。
        if (error instanceof ComemError) {
          this.#logger.warn('grep 跳过不可读的候选', {
            uri: value,
            code: error.code,
          });
          continue;
        }
        throw error;
      }

      // 文件末尾的换行是**行终止符**，不是「多一个空行」：不摘掉的话，末尾为换行的
      // 文件会凭空多出一行（`grep -n` 不会）。只摘一个，全文为空的文件仍然算一行。
      const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) {
          continue;
        }
        hits.push({
          uri: value,
          line: index + 1,
          text: line,
          before: lines.slice(Math.max(0, index - contextLines), index),
          after: lines.slice(index + 1, index + 1 + contextLines),
        });
        if (hits.length >= limit) {
          break;
        }
      }
    }

    this.#logger.info('grep 完成', {
      subject: options.subject,
      patternLength: pattern.length,
      files: scanned,
      returned: hits.length,
      durationMs: elapsedMs(startedAt),
    });
    return hits;
  }

  /**
   * §8.4 的 `glob`：路径通配。
   *
   * 索引层已经按 `node_permission` 过滤过（§8.2），这里仍然再过一遍
   * `authorizer.filterReadable`：服务层不能依赖索引实现的自觉（§12.4 的出口清单
   * 是按出口数的）。顺带把 URI 规范化成 `Uri.toString()` 的形态再返回。
   */
  async glob(pattern: string, options: FindOptions): Promise<readonly string[]> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const matched = await this.#index.glob({
      pattern,
      scopes: options.scopes,
      principals: options.principals,
      limit,
    });

    const candidates: Uri[] = [];
    for (const value of matched) {
      const uri = Uri.tryParse(value);
      if (uri !== null) {
        candidates.push(uri);
      }
    }
    const readable = await this.#authorizer.filterReadable(candidates, options.principals);
    const result = candidates
      .map((uri) => uri.toString())
      .filter((value) => readable.has(value));

    this.#logger.info('glob 完成', {
      subject: options.subject,
      patternLength: pattern.length,
      matched: matched.length,
      returned: result.length,
      durationMs: elapsedMs(startedAt),
    });
    return result;
  }
}
