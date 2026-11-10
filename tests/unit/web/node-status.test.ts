/**
 * 节点状态清单与领域取值域的对拍（`web/utils/nodeStatus.ts` ↔ `src/domain/node.ts`）。
 *
 * 领域层只有 `NodeStatus` 这个联合类型，`NODE_STATUSES` 是内部 `Record<NodeStatus, true>`
 * （只服务于字符串守卫，不导出）。所以双向绑定分两层：
 *
 * - 类型层：`Record<DomainNodeStatus, NodeStatus>` 与反向，任一侧加成员都缺键；
 * - 运行期：用领域层导出的 `parseStatusField` 逐个确认三个值合法、清单外的值
 *   落 `invalid`——这是唯一能问到领域层的运行期事实（`absent` 只对应 `undefined`）。
 *
 * `PendingMemoryPayload.status` 的类型是 `MemoryStatus`（`services/memory/document.ts`
 * 的 `MemoryStatus = NodeStatus`），第三组 `Record` 把那条路径也绑在同一个闭集上。
 */
import { describe, expect, it } from 'vitest'

import { parseStatusField, type NodeStatus as DomainNodeStatus } from '../../../src/domain/node.js'
import type { MemoryStatus } from '../../../src/services/memory/document.js'
import { NODE_STATUSES, type NodeStatus } from '../../../web/utils/nodeStatus.js'

describe('节点状态清单', () => {
  it('清单是文档里的三个，且与领域类型双向一致', () => {
    const documented: readonly DomainNodeStatus[] = ['active', 'pending', 'archived']

    expect([...NODE_STATUSES]).toEqual([...documented])
  })

  it('领域层加一个状态时双向 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<NodeStatus, DomainNodeStatus> = {
      active: 'active',
      pending: 'pending',
      archived: 'archived',
    }
    const domainToWeb: Record<DomainNodeStatus, NodeStatus> = {
      active: 'active',
      pending: 'pending',
      archived: 'archived',
    }
    // 复核记录的 status 与节点状态是同一个闭集（`MemoryStatus = NodeStatus`）。
    const memoryToWeb: Record<MemoryStatus, NodeStatus> = {
      active: 'active',
      pending: 'pending',
      archived: 'archived',
    }

    expect(Object.keys(webToDomain)).toEqual([...NODE_STATUSES])
    expect(Object.keys(domainToWeb)).toEqual([...NODE_STATUSES])
    expect(Object.keys(memoryToWeb)).toEqual([...NODE_STATUSES])
  })

  it('领域层接受清单里的每个值，拒绝清单外的值', () => {
    for (const status of NODE_STATUSES) {
      expect(parseStatusField(status)).toEqual({ kind: 'value', value: status })
    }

    // 大小写不同、未知单词、空串都是文档损坏，不是「没有状态」。
    for (const invalid of ['', 'Active', 'done', 'rejected']) {
      expect(parseStatusField(invalid)).toEqual({ kind: 'invalid' })
    }
    expect(parseStatusField(null)).toEqual({ kind: 'invalid' })
    // 键不存在才是 absent，不在这张清单的取值里。
    expect(parseStatusField(undefined)).toEqual({ kind: 'absent' })
  })
})
