/**
 * 提示词路由（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 六条提示词（抽取 / 摘要 / 重写各一对 system + user）的静态骨架在仓库的
 * `prompts/*.md` 里，控制台在这里查看与修改。修改落到 SQLite 的
 * `prompt_override` 表，优先级是**仓库默认 < 数据库覆盖**，`DELETE` 即恢复默认。
 *
 * ## 授权：读开放，写只给系统管理员
 *
 * 提示词是**进程级配置**，不属于任何 `comem://` 命名空间，所以不用 ACL 求权——
 * 硬套会造出「一个不存在的资源」的假身份。
 *
 * 读（`GET /`、`GET /:id`）对任何已认证身份开放：提示词会被注入到 agent 上下文，
 * 本来就不是秘密，控制台也需要在看「有没有覆盖」时读到它。
 *
 * 写（`PUT`、`DELETE`、`POST /:id/preview`）只给 `auth.adminUserIds`：改一条
 * 提示词会影响所有用户与所有 agent，预览也会触发模板渲染（未来若接模型则是真实
 * 成本）。默认名单为空 = 这些操作对所有人 403。
 *
 * ## 校验留两层
 *
 * 保存前校验模板语法与变量（`domain/prompt.ts`），渲染时再校验一次变量是否都传了。
 * 只做前者不够：模板少用一个变量是合法的编辑，**缺值**只可能在渲染时暴露。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import {
  PROMPT_IDS,
  isPromptId,
  type PromptId,
  type PromptVariable,
} from '../../../domain/prompt.js';
import type { PromptDetail, PromptSummary } from '../../../services/prompt-service.js';
import { ok } from '../envelope.js';
import { assertSystemAdmin } from '../middleware.js';
import { requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

function requirePromptId(raw: string): PromptId {
  if (!isPromptId(raw)) {
    // 未知标识是 NOT_FOUND，不是 INVALID_ARGUMENT：路径本身合法，只是没有这条提示词。
    throw new ComemError('NOT_FOUND', `没有这条提示词：${raw}`, {
      promptId: raw,
      available: [...PROMPT_IDS],
    });
  }
  return raw;
}

function serializeVariable(variable: PromptVariable): Record<string, unknown> {
  return { name: variable.name, description: variable.description };
}

function serializeSummary(summary: PromptSummary): Record<string, unknown> {
  return {
    id: summary.id,
    description: summary.description,
    variables: summary.variables.map(serializeVariable),
    overridden: summary.overridden,
    stale: summary.stale,
    updatedAt: summary.updatedAt,
  };
}

function serializeDetail(detail: PromptDetail): Record<string, unknown> {
  return {
    ...serializeSummary(detail),
    body: detail.body,
    defaultBody: detail.defaultBody,
  };
}

/**
 * 预览用的变量。键是模板里的变量名，值由调用方给；没给的变量由服务层填「〔说明〕」。
 *
 * 未知键直接拒绝：拼错的变量名会被静默忽略，而界面会显示「已替换」，用户以为
 * 自己看到的是真实渲染结果。
 */
function parseVariables(body: Record<string, unknown>): Record<string, string> {
  const raw = body['variables'];
  if (raw === undefined) {
    return {};
  }
  const record = requireRecord(raw, 'prompts/:id/preview.variables');
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw new ComemError('INVALID_ARGUMENT', `变量 ${name} 必须是字符串。`, {
        field: `variables.${name}`,
        value,
      });
    }
    variables[name] = value;
  }
  return variables;
}

export function createPromptRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { prompts, adminUserIds } = services;

  return {
    prefix: '/prompts',
    register(app: FastifyInstance): void {
      app.get('/', async () => ok({ prompts: prompts.list().map(serializeSummary) }));

      app.get<{ Params: { id: string } }>('/:id', async (request) =>
        ok(serializeDetail(prompts.get(requirePromptId(request.params.id)))),
      );

      app.put<{ Params: { id: string }; Body: unknown }>('/:id', async (request) => {
        assertSystemAdmin(request, adminUserIds);
        const id = requirePromptId(request.params.id);
        const body = requireRecord(request.body, 'prompts/:id');
        return ok(serializeDetail(prompts.save(id, requireString(body, 'body'))));
      });

      app.delete<{ Params: { id: string } }>('/:id', async (request) => {
        assertSystemAdmin(request, adminUserIds);
        return ok(serializeDetail(prompts.reset(requirePromptId(request.params.id))));
      });

      app.post<{ Params: { id: string }; Body: unknown }>('/:id/preview', async (request) => {
        // 预览也要管理员：它复用同一份模板渲染，未来接上模型就是真实成本与
        // 注入面（模板正文可由管理员改）。
        assertSystemAdmin(request, adminUserIds);
        const id = requirePromptId(request.params.id);
        const body = request.body === undefined ? {} : requireRecord(request.body, 'prompts/:id/preview');
        return ok({ text: prompts.preview(id, parseVariables(body)) });
      });
    },
  };
}
