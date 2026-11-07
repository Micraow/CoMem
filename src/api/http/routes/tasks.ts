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
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalQueryInteger, optionalString, requireRecord, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** 任务行的只读视图。字段与 `adapters/sqlite/task-repository.ts` 的 `TaskRow` 一致。 */
export interface TaskRecord {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly payload: unknown;
  readonly stepsDone: readonly string[];
  readonly attempts: number;
  readonly leaseUntil: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 任务查询端口。
 *
 * `TaskRepository` 结构上满足它（`TaskRow` 的联合类型字段可赋值给 `string`），
 * 不需要适配器或类型断言。
 */
export interface TaskQueryStore {
  get(id: string): TaskRecord | null;
  claimable(now: Date, limit: number): readonly TaskRecord[];
  requeue(id: string, now: Date): void;
}

const TASK_STATUSES: readonly string[] = ['pending', 'running', 'done', 'failed'];

/** 默认返回条数。与 `TaskService.claimable` 的上限一致。 */
const DEFAULT_TASK_LIMIT = 100;

function requireStatus(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const status = TASK_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new ComemError('INVALID_ARGUMENT', `status 只能是 ${TASK_STATUSES.join(' / ')}。`, {
      status: value,
    });
  }
  return status;
}

export function createTaskRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { taskStore } = services;

  return {
    prefix: '/tasks',
    register(app: FastifyInstance): void {
      app.get<{ Params: { id: string } }>('/:id', async (request) => {
        requestContextOf(request);
        const task = taskStore.get(request.params.id);
        if (task === null) {
          throw new ComemError('NOT_FOUND', `任务不存在：${request.params.id}`, {
            taskId: request.params.id,
          });
        }
        return ok({ task });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        requestContextOf(request);
        const query = requireRecord(request.query, 'tasks/list');
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_TASK_LIMIT, { min: 1 });
        const status = requireStatus(optionalString(query, 'status'));
        const claimable = taskStore.claimable(new Date(), limit);
        const tasks = status === undefined ? claimable : claimable.filter((task) => task.status === status);
        return ok({ tasks, total: tasks.length });
      });

      app.post<{ Params: { id: string } }>('/:id/retry', async (request) => {
        requestContextOf(request);
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
