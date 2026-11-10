/**
 * 任务路由（架构文档 §14、§10.4、§17.1）。
 *
 * 任务行的读路径没有服务方法：`TaskService` 只暴露「认领 / 执行 / 回收 / 计数」，
 * 不暴露「按 ID 查」「列可认领」。为两个只读查询给服务加转发方法会把「谁是任务
 * 状态的入口」拆成两处，所以这里声明一个**最小结构端口** `TaskQueryStore`，由
 * bootstrap 注入 `TaskRepository`（`AclDatabase` 的同一做法）。
 *
 * `GET /tasks` 返回的是**可认领**的任务（`pending` 或租约过期的 `running`），不是
 * 全表：已经 `done` 的归档任务没有动作可做，列出来只会让运维以为队列里堆了东西。
 *
 * `retry` 只对 `failed` 的任务生效：把一个 `pending` 任务「重试」是空操作，把一个
 * `running` 任务重试会和正在跑的执行器抢同一行——两者都返回 `CONFLICT` 而不是
 * 假装成功。
 *
 * ## 授权：只允许系统管理员（任务表没有归属列）
 *
 * `task` 表只有 `id / type / status / payload / steps_done / attempts /
 * lease_until / error / created_at / updated_at`——**没有 scope 或 uri 列**，所以
 * 「这个任务属于谁的命名空间」在数据模型里没有答案。`payload` 是 `unknown`，
 * 各任务类型的形状由写入方决定；从它里面猜路径做权限判定等于把授权建在
 * 不可校验的 JSON 上（改一次 payload 形状就漏一次）。
 *
 * 因此三个端点都按跨主体操作处理：只认 `auth.adminUserIds`（默认空 = 全部 403）。
 * 任务载荷里可能含会话内容（归档任务的 `sessionUri` / `archiveUri`），不能允许
 * 任意登录身份按 ID 读取，也不能允许任意身份 requeue 别人的失败任务。
 *
 * 要让普通用户按命名空间读任务，先给 `task` 表加一列归属（写入时落 scope 根），
 * 求权才能针对目标资源——那是表结构变更，不在本端点里猜。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import {
  isTaskStatus,
  TASK_STATUSES,
  type ClaimableTaskStatus,
  type TaskStatus,
  type TaskType,
} from '../../../domain/task.js';
import { ok } from '../envelope.js';
import { assertSystemAdmin } from '../middleware.js';
import { optionalQueryInteger, optionalString, requireRecord, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** 任务行的只读视图。字段与 `adapters/sqlite/task-repository.ts` 的 `TaskRow` 一致。 */
export interface TaskRecord {
  readonly id: string;
  /**
   * `TaskType`，不是 `string`：`task` 表的 `type` 列读出来是字符串，但
   * `task-repository.ts` 的行映射已经用 `requireTaskType` 校验过值域（非法值抛
   * `INTERNAL`），`TaskRow` 的字段就是收窄后的类型。写宽成 `string` 时，`type` 与
   * 同一行里已经收窄的 `status` 不对称，消费方按任务类型分支既没有穷举保护、
   * 也拿不到「加一个任务类型要改哪里」的编译提示。
   */
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly payload: unknown;
  readonly stepsDone: readonly string[];
  readonly attempts: number;
  readonly leaseUntil: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `GET /tasks` 的行。
 *
 * `status` 收缩到 `ClaimableTaskStatus`：这个端点只列可认领的任务（`pending`，或
 * 租约过期的 `running`），`done` / `failed` 不会出现。写成全集的 `TaskStatus` 会让
 * 消费方为不会出现的状态写文案，或用 `??` 兜底把「真的出现了意外状态」显示成空白。
 *
 * **只有 `claimable()` 用这个形状。** `get(id)` 必须返回全集：`POST /tasks/:id/retry`
 * 的判据就是 `status === 'failed'`，把它们写成子集会让那条判断变成恒假。
 */
export interface ClaimableTaskRecord extends Omit<TaskRecord, 'status'> {
  readonly status: ClaimableTaskStatus;
}

/**
 * 任务查询端口。
 *
 * `TaskRepository` 结构上满足它（`TaskRow` 的联合类型字段可赋值给 `string`），
 * 不需要适配器或类型断言。
 */
export interface TaskQueryStore {
  get(id: string): TaskRecord | null;
  claimable(now: Date, limit: number): readonly ClaimableTaskRecord[];
  requeue(id: string, now: Date): void;
}

/** 默认返回条数。与 `TaskService.claimable` 的上限一致。 */
const DEFAULT_TASK_LIMIT = 100;

/**
 * `status` 查询参数的取值。
 *
 * 取自 `domain/task.ts` 的 `TASK_STATUSES`（唯一来源）：手抄一份 `readonly string[]`
 * 时，加一个任务状态既没有编译错误也没有运行期错误——查询参数会继续拒绝它。
 */
function requireStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isTaskStatus(value)) {
    throw new ComemError('INVALID_ARGUMENT', `status 只能是 ${TASK_STATUSES.join(' / ')}。`, {
      status: value,
    });
  }
  return value;
}

export function createTaskRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { taskStore, adminUserIds } = services;

  return {
    prefix: '/tasks',
    register(app: FastifyInstance): void {
      app.get<{ Params: { id: string } }>('/:id', async (request) => {
        assertSystemAdmin(request, adminUserIds);
        const task = taskStore.get(request.params.id);
        if (task === null) {
          throw new ComemError('NOT_FOUND', `任务不存在：${request.params.id}`, {
            taskId: request.params.id,
          });
        }
        return ok({ task });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        assertSystemAdmin(request, adminUserIds);
        const query = requireRecord(request.query, 'tasks/list');
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_TASK_LIMIT, { min: 1 });
        const status = requireStatus(optionalString(query, 'status'));
        const claimable = taskStore.claimable(new Date(), limit);
        const tasks = status === undefined ? claimable : claimable.filter((task) => task.status === status);
        return ok({ tasks, total: tasks.length });
      });

      app.post<{ Params: { id: string } }>('/:id/retry', async (request) => {
        assertSystemAdmin(request, adminUserIds);
        const task = taskStore.get(request.params.id);
        if (task === null) {
          throw new ComemError('NOT_FOUND', `任务不存在：${request.params.id}`, {
            taskId: request.params.id,
          });
        }
        if (task.status !== 'failed') {
          throw new ComemError(
            'CONFLICT',
            `只有 failed 的任务可以重试，当前状态是 ${task.status}：${task.id}`,
            { taskId: task.id, status: task.status },
          );
        }
        taskStore.requeue(task.id, new Date());
        return ok({ task: taskStore.get(task.id) });
      });
    },
  };
}
