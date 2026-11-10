/**
 * 文件 / 目录的 `kind` → 界面文案（文件树页与侧栏共用一份）。
 *
 * ## 取值域是闭集
 *
 * `/fs/tree`、`/fs/ls`、`/fs/stat` 的 `kind` 由 `src/adapters/fs/content-store.ts`
 * 从 `fs.stat()` 的 `stats.isDirectory()` 推出，写死成 `'file' | 'directory'`
 * 字面量，没有字符串拼接；`src/api/http/routes/fs.ts` 的 `serializeEntry` 与
 * `/fs/stat` 原样带出。所以界面可以把内联三元收进表里：加一个成员时缺文案即
 * 编译失败，而不是静默落到 else 分支。
 *
 * 这不是 `src/domain/node.ts` 的 `NodeKind`（那是索引行的 `directory` /
 * `document`，另一种词表）：两套都叫 kind，混用会让「文档」在索引侧和磁盘侧
 * 指不同的东西。这里只覆盖 HTTP 的三种 `/fs/*` 响应。
 *
 * 控制台不能 import 服务端类型，所以 `as const` 数组是 web 侧的取值来源。
 * 服务端侧的同名类型在 `src/services/filesystem.ts` 的 `TreeEntry.kind`，对拍
 * 测试以它为领域清单（`tests/unit/web/fs-labels.test.ts`）——那是唯一同时 import
 * 两边的地方。
 *
 * ## 三张表都按 kind 展开
 *
 * 除了「类型」这一行的名字，目录还额外有两处展示差异：名称带尾斜杠、概览页有
 * L1 一档。它们曾各自写成内联三元，和类型名一样属于「kind 的最后一段落」——
 * 加一个成员时三处都要人肉找。统一收在这里，调用方只提供 kind。
 */

/** `/fs/*` 响应的 `kind`。 */
export const FS_ENTRY_KINDS = ['file', 'directory'] as const

export type FsEntryKind = (typeof FS_ENTRY_KINDS)[number]

/** kind → 类型名。漏一个 `FsEntryKind` 即编译失败，多一个键也是。 */
const FS_ENTRY_KIND_LABEL = {
  file: '文档',
  directory: '目录',
} satisfies Record<FsEntryKind, string>

/** kind → 名称后缀（目录以 `/` 结尾，界面上与展开箭头一起表达层级）。 */
const FS_ENTRY_NAME_SUFFIX = {
  file: '',
  directory: '/',
} satisfies Record<FsEntryKind, string>

/** kind → 有的摘要层级（文档没有 L1 概览，服务端恒返回 null）。 */
const FS_ENTRY_LEVELS_LABEL = {
  file: 'L0 摘要',
  directory: 'L0 摘要 · L1 概览',
} satisfies Record<FsEntryKind, string>

/** kind → 界面文案。 */
export function fsEntryKindLabel(kind: FsEntryKind): string {
  return FS_ENTRY_KIND_LABEL[kind]
}

/** kind + 名称 → 列表里显示的名字。 */
export function fsEntryDisplayName(kind: FsEntryKind, name: string): string {
  return `${name}${FS_ENTRY_NAME_SUFFIX[kind]}`
}

/** kind → 摘要层级的说明（侧栏「层级」一行）。 */
export function fsEntryLevelsLabel(kind: FsEntryKind): string {
  return FS_ENTRY_LEVELS_LABEL[kind]
}
