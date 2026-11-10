/**
 * 写盘与预览（架构文档 §11.8「写回」「回滚语义」）。
 *
 * 写盘按 URI 升序**执行**（不是为了加锁）：`adds` / `updates` / `deletes` 的顺序因此
 * 是确定的，报告与日志可以直接比对。`dryRun` 走预览：不写任何东西，按操作原顺序
 * 报告「将要应用」的 URI。
 */

import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

import { renderMemoryUri } from '../memory.js';

import type { ConsolidationPorts, ConsolidationResult, WritePlan } from './types.js';

function compareByUri(left: WritePlan, right: WritePlan): number {
  const leftUri = left.operation.uri;
  const rightUri = right.operation.uri;
  if (leftUri === rightUri) {
    return 0;
  }
  return leftUri < rightUri ? -1 : 1;
}

export async function applyPlans(
  ports: Pick<ConsolidationPorts, 'memory' | 'logger'>,
  scope: Uri,
  plans: readonly WritePlan[],
  dryRun: boolean,
): Promise<Pick<ConsolidationResult, 'adds' | 'updates' | 'deletes'>> {
  const { memory, logger } = ports;
  const adds: string[] = [];
  const updates: string[] = [];
  const deletes: string[] = [];

  if (dryRun) {
    for (const plan of plans) {
      if (plan.operation.kind === 'add') {
        adds.push(plan.operation.uri);
      } else if (plan.operation.kind === 'update') {
        updates.push(plan.operation.uri);
      } else {
        deletes.push(plan.operation.uri);
      }
    }
    logger.info('记忆合并预览完成（未写盘）', {
      scope: scope.toString(),
      adds: adds.length,
      updates: updates.length,
      deletes: deletes.length,
    });
    return { adds, updates, deletes };
  }

  try {
    for (const plan of [...plans].sort(compareByUri)) {
      if (plan.schema === null) {
        // 删除必须可解释：`reason` 是模型给的理由，进日志（§11.8）。
        await memory.remove(plan.uri);
        deletes.push(plan.uri.toString());
        logger.info('记忆合并删除了记忆', {
          scope: scope.toString(),
          uri: plan.uri.toString(),
          reason: plan.operation.reason,
        });
        continue;
      }
      const write = await memory.upsertMemory(scope, plan.schema, {
        // 与直接传字段等价（identity + content 都在 `values` 里，路径同
        // `upsertMemory` 内部渲染的那一个），但 `{ uri, update }` 形态能带上
        // `provenance`：被本批删除的记忆的归档来源要并进保留者（W97）。
        uri: renderMemoryUri(scope, plan.schema, plan.values),
        update: () => plan.values,
        // `plan.sources` 在 `plan.ts` 里已经 `Uri.tryParse` 过，直接传，不再 parse。
        ...(plan.sources.length === 0
          ? {}
          : { provenance: { sources: plan.sources } }),
      });
      (write.created ? adds : updates).push(write.uri.toString());
      logger.info('记忆合并写入了记忆', {
        scope: scope.toString(),
        uri: write.uri.toString(),
        memoryType: write.memoryType,
        created: write.created,
        reason: plan.operation.reason,
      });
    }
  } catch (error) {
    const failure = ComemError.from(error);
    // 不回滚：`MemoryService` 没有事务，逐字节前像也拿不回来（见文件头）。
    // 已经应用的操作写进 details，运维按这份清单收尾。
    throw new ComemError(
      failure.code,
      `记忆合并中途失败，已应用的 ${adds.length + updates.length + deletes.length} 条操作没有回滚：${failure.message}`,
      {
        ...(failure.details ?? {}),
        scope: scope.toString(),
        adds: [...adds],
        updates: [...updates],
        deletes: [...deletes],
      },
    );
  }

  return { adds, updates, deletes };
}
