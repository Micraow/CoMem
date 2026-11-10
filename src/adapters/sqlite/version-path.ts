/**
 * 「这个 URI 不在记忆版本快照目录下」的 SQL 判据（架构文档 §11.11）。
 *
 * 覆盖写把旧值快照到 `memories/{type}/.history/`，那份文件的 `status` 仍是 `active`
 * （它是**旧值**，不是归档项）。检索面（`search` / `glob`）靠路径段排除它：系统写的
 * 快照恒带非空 `valid_until`，但 `write` 曾经能造出没有 frontmatter 的假快照，不能把
 * 不变量押在写路径上。TTL 不看有效区间，不排除的话第一段会把它标成 `archived`（与
 * 「这是一条旧值」矛盾），第二段会物理删除它，`reject` 读 `supersedes` 时只剩「文件
 * 不存在」，静默退化成删除。
 *
 * **必须两条 GLOB，不能只写带 `/*` 的那一条。** 目录节点自身
 * （`memories/preferences/.history`）在 `.history` 后面没有字符，`/*` 匹配不到；
 * `pnpm reindex` 为它建的那一行会被第一段当过期记忆归档。
 *
 * **按路径段，不看子串。** `memories/preferences/.history.md` 是普通记忆，必须照常
 * 过期。SQL 没有「切段」函数，用 GLOB 表达段边界：`.history` 两侧必须是 `/`。锚在
 * `memories/` 之后是因为记忆类型目录全部是 `memories/{type}`（含
 * `projects/{pid}/memories`）；GLOB 的 `*` 跨 `/`，`rules` 镜像出来的
 * `.history/{scenario}/...` 同样命中。第二段的查询也要带它：存量库里的版本行归档得
 * 最早，会占满 `ORDER BY archived_at ASC` 的批次名额。
 *
 * 目录名从领域层常量派生。`alias` 是 `node` 在联表查询里的别名（`node_fts` 与
 * `node_permission` 也在 SQL 里）；省略时不加前缀（单表 `UPDATE` / `SELECT`）。
 */

import { VERSION_DIRECTORY } from '../../domain/node.js';

/** 版本快照目录的子树前缀模式（`*` 跨 `/`，锚在 `memories/` 之后）。 */
const VERSION_PATH_GLOB = `*/memories/*/${escapeGlobLiteral(VERSION_DIRECTORY)}`;

/** GLOB 里把字面量段内的元字符（`*` `?` `[` `]`）转义成字符类。 */
export function escapeGlobLiteral(value: string): string {
  return value.replace(/[[\]*?]/g, (char) => `[${char}]`);
}

/** 版本快照目录（`.history` 子树）的排除谓词；`alias` 是 `node` 的联表别名。 */
export function notVersionFileSql(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `NOT (${prefix}uri GLOB '${VERSION_PATH_GLOB}' OR ${prefix}uri GLOB '${VERSION_PATH_GLOB}/*')`;
}
