/**
 * 节点状态清单（`src/domain/node.ts` 的 `NodeStatus`）。
 *
 * ## 为什么没有文案表
 *
 * 复核页不显示状态字段：`GET /memories/pending` 只返回待复核记录，界面上那枚橙色
 * 徽章写的是「待复核」，不是把 `status` 原值翻出来。所以这里只声明取值清单，不
 * 写一张没人读的文案表（AGENTS §6：只写解决当前问题所需的代码）。
 *
 * 这张清单的消费点是 `PendingMemoryPayload.status` 的收窄：旧实现声明成
 * `string`，复核页拿到的是一个说不出取值范围的字段，将来给它加文案时只能靠
 * `?? 原值` 兜底。收窄成 `NodeStatus` 后，领域层加一档会在编译期暴露。
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
