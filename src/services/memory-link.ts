/**
 * 记忆关联边服务（架构文档 §11.10）。
 *
 * 薄薄一层：把领域入参转成仓储行、给 `from` 定 URI、调用仓储。不做检索、不展开
 * 邻居、不建图——这条边界写在这里，免得以后有人把「多跳」塞进来。
 *
 * 产生端有两处：调用方显式给出 `links`（归档管线的两个写入步骤），以及
 * `rebuildDerived`（`reindex` 从 `sources` 整批重算）。抽取时让 LLM 产出实体间链接
 * 需要改提示词，不在本次范围内（§11.10「谁产生 links」）。
 */

import type { Logger } from '../domain/log.js';
import type { MemoryLink, MemoryLinkInput, MemoryLinkType } from '../domain/memory-link.js';
import type { MemoryLinkRepository, MemoryLinkRowInput } from '../adapters/sqlite/memory-link-repository.js';
import type { Uri } from '../domain/uri.js';

export interface MemoryLinkServiceDeps {
  readonly repository: MemoryLinkRepository;
  readonly logger: Logger;
}

/** 默认权重：调用方没给时按「普通关联」记 1.0。 */
const DEFAULT_WEIGHT = 1.0;

/**
 * `sources` 派生出来的边类型。
 *
 * 领域层不导出具名常量（`link_type` 是开放字符串，收紧成枚举会让新产生端每次加
 * 关系都改领域层），产生端各自用标注了域类型的常量承接（`commit/steps/memory-merge.ts`
 * 与 `experience-distill.ts` 同一写法）。
 */
const DERIVED_FROM: MemoryLinkType = 'derived_from';

function normalizeWeight(weight: number | undefined): number {
  if (weight === undefined) {
    return DEFAULT_WEIGHT;
  }
  // 负数或无意义的权重只会让排序失去意义；收敛到 ≥ 0。
  return weight < 0 ? 0 : weight;
}

export class MemoryLinkService {
  readonly #repository: MemoryLinkRepository;
  readonly #logger: Logger;

  constructor(deps: MemoryLinkServiceDeps) {
    this.#repository = deps.repository;
    this.#logger = deps.logger;
  }

  /**
   * 从 `fromUri` 出发写一批边。返回新增与合并的条数。
   *
   * 同一批里重复的边（同 to + 同 matchText）由仓储的 weight=max 处理，不在这里
   * 去重——保持「一批就是一个事务」的语义，仓储是唯一知道去重键的地方。
   */
  addLinks(
    fromUri: Uri,
    links: readonly MemoryLinkInput[],
  ): { inserted: number; merged: number } {
    if (links.length === 0) {
      return { inserted: 0, merged: 0 };
    }
    const rows: MemoryLinkRowInput[] = links.map((link) => ({
      fromUri: fromUri.toString(),
      toUri: link.toUri.toString(),
      linkType: link.linkType,
      weight: normalizeWeight(link.weight),
      matchText: link.matchText ?? '',
      description: link.description ?? '',
    }));
    const result = this.#repository.upsertMany(rows);
    this.#logger.debug('记忆关联边已写入', {
      from: fromUri.toString(),
      count: links.length,
      ...result,
    });
    return result;
  }

  /**
   * 用磁盘上的 `sources` 重建全部 `derived_from` 边（`reindex` 的唯一调用方）。
   *
   * `sources` 是真相，`memory_link` 是它的派生读模型（§11.10）。写路径只在归档时
   * 增量写边；边写失败、行被删错、手工改过 `sources` 之后两者会漂移，反查读到的
   * 是旧边。这里按磁盘现状整批替换 derived 部分，让反查重新与文件一致。
   *
   * **只替换 `derived_from`**：其它边（`references` / `related`）没有 frontmatter
   * 里的真相，推导不出来，也不能被这次操作误删。
   *
   * 每条边都是写路径的默认形状：`weight = 1.0`、`match_text` / `description` 为空
   * ——产生端从不给 `derived_from` 填这三个字段，重建只复现 `sources` 说的事。
   */
  rebuildDerived(
    edges: readonly { readonly from: Uri; readonly to: Uri }[],
  ): { inserted: number; deleted: number } {
    const rows: MemoryLinkRowInput[] = edges.map((edge) => ({
      fromUri: edge.from.toString(),
      toUri: edge.to.toString(),
      linkType: DERIVED_FROM,
      weight: DEFAULT_WEIGHT,
      matchText: '',
      description: '',
    }));
    return this.#repository.replaceByLinkType(DERIVED_FROM, rows);
  }

  /** 一个记忆指向的所有边。 */
  linksOf(uri: Uri): readonly MemoryLink[] {
    return this.#repository.linksFrom(uri.toString());
  }

  /** 派生：所有指向这个记忆的边。 */
  backlinksOf(uri: Uri): readonly MemoryLink[] {
    return this.#repository.backlinksOf(uri.toString());
  }
}
