/**
 * 配置端点（架构文档 §18）：只读快照、写覆盖文件、连接测试。
 *
 * 三个端点都只给系统管理员（`assertSystemAdmin`）。读取口径是**当前进程已生效的
 * 配置**：`GET` 回启动快照，`POST /config/test` 用启动时构造的模型实例发请求。
 * 写覆盖文件不会热生效，响应固定带 `restartRequired: true`。
 *
 * 密钥纪律与 `admin-api-keys.ts` 相同：明文永不出现在任何响应里，只回
 * `configured` 与末 4 位掩码。探针实现在 `config-probes.ts`。
 */

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { ComemError, fsErrorCode } from '../../../domain/errors.js';
import { isRecord } from '../../../domain/guards.js';
import { describeConfig, type ConfigLeafView } from '../../../config/metadata.js';
import { hasPath } from '../../../config/merge.js';
import { nextOverrideFor, readOverride, writeOverrideFile } from '../../../config/override.js';
import { ok } from '../envelope.js';
import { assertSystemAdmin } from '../middleware.js';
import { requireRecord, type HttpRouteGroup } from '../server.js';

import { parseTarget, probe, type ConfigRouteServices } from './config-probes.js';

export type { ConfigRouteServices } from './config-probes.js';

/**
 * 覆盖文件可写判定：文件存在看文件，不存在看目录。
 *
 * 只看文件本身会在「文件还没创建」时恒为 false；只看目录会在文件被设成只读时
 * 误报可写。两者都要。
 */
async function overrideWritable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') {
      return false;
    }
    try {
      await access(dirname(path), fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** 校验 PATCH 的每个路径：存在、可编辑、没有被环境变量遮住。 */
function assertWritablePaths(
  snapshot: ConfigRouteServices['configSnapshot'],
  paths: readonly string[],
): void {
  const items = new Map<string, ConfigLeafView>(
    describeConfig(snapshot, false).items.map((item) => [item.path, item]),
  );
  for (const path of paths) {
    const item = items.get(path);
    if (item === undefined) {
      throw new ComemError('INVALID_ARGUMENT', `未知配置项：${path}`, { field: path });
    }
    if (!item.editable) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `配置项 ${path} 不可通过覆盖文件修改：${item.reason ?? '不在可编辑白名单里'}。`,
        { field: path, reason: item.reason ?? null },
      );
    }
    if (hasPath(snapshot.envOverrides, path.split('.'))) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `配置项 ${path} 由环境变量 ${item.envName} 覆盖，写覆盖文件不会生效。`,
        { field: path, envName: item.envName },
      );
    }
  }
}

export function createConfigRoutes(services: ConfigRouteServices): HttpRouteGroup {
  const { configSnapshot, systemAdmin } = services;

  return {
    // 空前缀：挂在 `/config` 与 `/api/v1/config` 两处（与运维端点同一规则）。
    prefix: '',
    register(app: FastifyInstance): void {
      app.get('/config', async (request) => {
        assertSystemAdmin(request, systemAdmin);
        return ok(
          describeConfig(configSnapshot, await overrideWritable(configSnapshot.overridePath)),
        );
      });

      app.patch<{ Body: unknown }>('/config', async (request) => {
        assertSystemAdmin(request, systemAdmin);
        const body = requireRecord(request.body, 'PATCH /api/v1/config');
        const values = body['values'];
        if (!isRecord(values)) {
          throw new ComemError('INVALID_ARGUMENT', 'values 必须是对象。', {
            field: 'values',
            value: values,
          });
        }
        const entries = Object.entries(values);
        if (entries.length === 0) {
          throw new ComemError('INVALID_ARGUMENT', 'values 不能为空。', { field: 'values' });
        }

        // 先校验、后落盘：任何一条不合法都不碰磁盘。
        assertWritablePaths(
          configSnapshot,
          entries.map(([path]) => path),
        );
        const next = nextOverrideFor(
          configSnapshot,
          readOverride(configSnapshot),
          Object.fromEntries(entries),
        );
        await writeOverrideFile(configSnapshot.overridePath, next);
        return ok({
          written: entries.length,
          overridePath: configSnapshot.overridePath,
          restartRequired: true,
        });
      });

      app.post<{ Body: unknown }>('/config/test', async (request) => {
        assertSystemAdmin(request, systemAdmin);
        const body = requireRecord(request.body, 'POST /api/v1/config/test');
        return ok(await probe(parseTarget(body['target']), services));
      });
    },
  };
}
