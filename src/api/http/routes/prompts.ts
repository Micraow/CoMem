/**
 * 提示词路由（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 六条提示词（抽取 / 摘要 / 重写各一对 system + user）的静态骨架在仓库的
 * `prompts/*.md` 里，控制台在这里查看与修改。修改落到 SQLite 的
 * `prompt_override` 表，优先级是**仓库默认 < 数据库覆盖**，`DELETE` 即恢复默认。
 *
 * ## 为什么不做 ACL
 *
 * 提示词是**进程级配置**，不属于任何 `comem://` 命名空间。给一条提示词授「谁能
 * 改」需要先有「谁的配置」这个概念，而 v1 是单租户部署（`AclService` 在构造期
 * 绑定身份，§12.4）。和 `/telemetry`、`/health` 一样不做鉴权：它们都不碰用户内容。
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
  const { prompts } = services;

  return {
    prefix: '/prompts',
    register(app: FastifyInstance): void {
      app.get('/', async () => ok({ prompts: prompts.list().map(serializeSummary) }));

      app.get<{ Params: { id: string } }>('/:id', async (request) =>
        ok(serializeDetail(prompts.get(requirePromptId(request.params.id)))),
      );

      app.put<{ Params: { id: string }; Body: unknown }>('/:id', async (request) => {
        const id = requirePromptId(request.params.id);
        const body = requireRecord(request.body, 'prompts/:id');
        return ok(serializeDetail(prompts.save(id, requireString(body, 'body'))));
      });

      app.delete<{ Params: { id: string } }>('/:id', async (request) =>
        ok(serializeDetail(prompts.reset(requirePromptId(request.params.id)))),
      );

      app.post<{ Params: { id: string }; Body: unknown }>('/:id/preview', async (request) => {
        const id = requirePromptId(request.params.id);
        const body = request.body === undefined ? {} : requireRecord(request.body, 'prompts/:id/preview');
        return ok({ text: prompts.preview(id, parseVariables(body)) });
      });
    },
  };
}
