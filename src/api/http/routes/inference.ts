/**
 * 本地推理端点（架构文档 §14、§18.2）。
 *
 * 三个端点都只给系统管理员。`GET` 探测「本机能否启动、现在有没有在运行」；
 * `POST /start` 用服务端写死的命令拉起子进程并等到就绪；`POST /stop` 只停 pid
 * 文件里记录的那个进程。**请求体不参与任何决策**——路径、device、threads 都不可
 * 由调用方指定。
 *
 * 失败形状沿用统一封套：缺依赖是 400 `INVALID_ARGUMENT`（`details.missing` /
 * `details.startCommand`）；起来了但没就绪是 409 `CONFLICT`
 * （`details.started` / `ready` / `reason`）。
 */

import type { FastifyInstance } from 'fastify';

import { ok } from '../envelope.js';
import { assertSystemAdmin } from '../middleware.js';
import type { HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export interface LocalInferenceStatusPayload {
  readonly available: boolean;
  readonly running: boolean;
  readonly endpoint: string;
  readonly dimension: number | null;
  readonly backend: string | null;
  readonly device: string | null;
  readonly model: string | null;
  readonly missing: readonly string[];
  readonly startCommand: string | null;
}

export interface LocalInferenceStartPayload {
  readonly started: true;
  readonly ready: true;
  readonly endpoint: string;
  readonly dimension: number | null;
}

/** 进程管理端口。适配器在 `adapters/local-inference/`，路由只认这三个方法。 */
export interface LocalInferencePort {
  status(): Promise<LocalInferenceStatusPayload>;
  start(): Promise<LocalInferenceStartPayload>;
  stop(): Promise<void>;
}

export type InferenceRouteServices = Pick<HttpRouteServices, 'systemAdmin'> & {
  readonly localInference: LocalInferencePort;
};

export function createInferenceRoutes(services: InferenceRouteServices): HttpRouteGroup {
  return {
    prefix: '/inference',
    register(app: FastifyInstance): void {
      app.get('/local', async (request) => {
        assertSystemAdmin(request, services.systemAdmin);
        return ok(await services.localInference.status());
      });

      app.post('/local/start', async (request) => {
        assertSystemAdmin(request, services.systemAdmin);
        // 不读 request.body：没有任何来自请求的参数能改变启动命令。
        return ok(await services.localInference.start());
      });

      app.post('/local/stop', async (request) => {
        assertSystemAdmin(request, services.systemAdmin);
        await services.localInference.stop();
        return ok({ stopped: true });
      });
    },
  };
}
