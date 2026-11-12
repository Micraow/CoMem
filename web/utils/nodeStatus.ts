/**
 * 节点状态清单（`src/domain/node.ts` 的 `NodeStatus`）与界面文案。
 *
 * ## 两张文案表
 *
 * 文件详情页要回答「这条记忆为什么能／不能被搜到」：检索只返回 `active` 节点
 * （`src/adapters/sqlite/retrieval-index.ts` 的 `ACTIVE_STATUS_PREDICATE`），`pending`
 * 与 `archived` 在 `find` / `search` / `glob` 里都被过滤掉。状态与「能否被检索」
 * 是两件事，所以分开：状态本身说「有效 / 待复核 / 已归档」，检索资格说
 * 「可被检索 / 待复核，检索不到 / 已归档，检索不到」。
 *
 * 复核页不显示状态字段：`GET /memories/pending` 只返回待复核记录，界面上那枚橙色
 * 徽章写的是「待复核」，不是把 `status` 原值翻出来。它读的是 `NODE_STATUS_LABEL`，
 * 不再单独写一份文案。
 *
 * 这张清单的消费点是 `PendingMemoryPayload.status` 与 `MemoryMetaPayload.status`
 * 的收窄：旧实现声明成 `string`，复核页拿到的是一个说不出取值范围的字段，将来给它
 * 加文案时只能靠 `?? 原值` 兜底。收窄成 `NodeStatus` 后，领域层加一档会在编译期暴露。
 *
 * 控制台不能 import `src/domain`，所以 `as const` 数组是 web 侧的取值来源。
 * 领域层的 `NODE_STATUSES` 是 `Record<NodeStatus, true>` 且不导出——它只服务于
 * 守卫，没有需要遍历的消费点。因此对拍测试的双向绑定是类型层的
 * （`Record<DomainNodeStatus, NodeStatus>` 与反向），运行期再用领域层的
 * `parseStatusField` 逐个确认这三个值合法。测试在
 * `tests/unit/web/node-status.test.ts`。
 */

/** `NodeStatus`（也就是 `services/memory/document.ts` 的 `MemoryStatus`）。 */
export const NODE_STATUSES = ['active', 'pending', 'archived'] as const

export type NodeStatus = (typeof NODE_STATUSES)[number]

/** 状态 → 界面文案。漏一个状态即编译失败，多一个键也是。 */
export const NODE_STATUS_LABEL = {
  active: '有效',
  pending: '待复核',
  archived: '已归档',
} satisfies Record<NodeStatus, string>

/**
 * 状态 → 「能否被检索」。
 *
 * 判据就是检索索引里的 `n.status = 'active'`：另外两档进不了 `find` / `search` /
 * `glob` 的结果。`archived` 仍可按 URI 读取——它不在检索面上，不等于内容没了。
 */
export const NODE_RETRIEVAL_LABEL = {
  active: '可被检索',
  pending: '待复核，检索不到',
  archived: '已归档，检索不到',
} satisfies Record<NodeStatus, string>
