/**
 * 技能路由（架构文档 §14、§13.2 的 `add_skill`）。
 *
 * 技能包里的文件是二进制（`scripts/check.sh` 之类），JSON 传不了字节，所以
 * `files[].content` 是 **base64**。文本文件也走同一条路径：把「编码」放进协议，
 * 比让调用方猜「这个文件算不算文本」少一个失败模式。
 *
 * 入口文件 `SKILL.md` 的 `name` / `description` 由 `SkillService` 校验，路由层只
 * 保证字段类型与 base64 可解码——业务规则只有一份。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { SkillFileInput } from '../../../services/skill.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalString, requireRecord, requireUri, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3。 */
const READ = 1;
const WRITE = 3;

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function parseFile(value: unknown, index: number): SkillFileInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`files[${index}] 必须是对象。`, { index });
  }
  const record = requireRecord(value, `files[${index}]`);
  const path = record['path'];
  const content = record['content'];

  if (typeof path !== 'string' || path === '') {
    throw invalid(`files[${index}].path 必须是非空字符串。`, { index });
  }
  if (typeof content !== 'string') {
    throw invalid(`files[${index}].content 必须是 base64 字符串。`, { index });
  }

  // `Buffer.from(..., 'base64')` 对非法字符是静默跳过，不是报错。先按规范形态
  // 校验一遍：长度是 4 的倍数、字符集是 base64 字母表（含 padding）。
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw invalid(`files[${index}].content 不是合法的 base64。`, { index });
  }

  return {
    path,
    content: new Uint8Array(Buffer.from(content, 'base64')),
  };
}

function parseFiles(value: unknown): readonly SkillFileInput[] {
  if (!Array.isArray(value)) {
    throw invalid('files 必须是数组。', { field: 'files' });
  }
  return value.map((item, index) => parseFile(item, index));
}

function scopeOfSubject(subject: string): Uri {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw invalid(`技能身份必须是 user 主体：${subject}`, { subject });
  }
  return Uri.parse(`comem://user/${principal.id}`);
}

/** `GET /skills` 列表项：URI 与目录名（`SKILL.md` 的 description 暂缺，见路由注释）。 */
interface SerializedSkill {
  readonly uri: string;
  readonly name: string;
}

/** `POST /skills` 的响应体。 */
interface SkillAddResponse {
  readonly skillUri: string;
  readonly fileCount: number;
}

/** `GET /skills` 的响应体。 */
interface SkillListResponse {
  readonly scope: string;
  readonly skills: readonly SerializedSkill[];
}

export function createSkillRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { skill, authorizer } = services;

  return {
    prefix: '/skills',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/', async (request) => {
        const body = requireRecord(request.body, 'skills/add');
        const context = requestContextOf(request);
        const parentUri = requireUri(body, 'parentUri');
        const name = body['name'];
        if (typeof name !== 'string' || name === '') {
          throw invalid('name 必须是非空字符串。', { field: 'name' });
        }
        const files = parseFiles(body['files']);

        await authorizer.assert(parentUri, WRITE, context.principals);
        const result = await skill.addSkill({
          parentUri,
          name,
          files,
          subject: context.subject,
          principals: context.principals,
        });

        return ok<SkillAddResponse>({
          skillUri: result.skillUri.toString(),
          fileCount: result.fileCount,
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        const query = requireRecord(request.query, 'skills/list');
        const context = requestContextOf(request);
        const scopeUri = optionalString(query, 'scopeUri');
        const scope = scopeUri === undefined ? scopeOfSubject(context.subject) : Uri.parse(scopeUri);
        await authorizer.assert(scope, READ, context.principals);
        const skills = await skill.listSkills(scope, {
          subject: context.subject,
          principals: context.principals,
        });
        // 返回 `{ uri, name }` 而不是裸字符串：Hook 的 `<available-skills>` 目录要
        // 靠名字让人（和模型）看懂，URI 里的 `comem://user/alice/skills/` 前缀是噪音。
        //
        // **`description` 暂缺**：`SKILL.md` 的 description 在 frontmatter 里，而
        // `DocumentFrontmatter` 只建模摘要三字段，`ContentStore.readText` 不暴露任意
        // 键。要补得先扩领域类型（W9 处理）。目录降级成「只有名字」是 §15.2 允许
        // 的一档，不是静默丢失。
        return ok<SkillListResponse>({
          scope: scope.toString(),
          skills: skills.map((uri) => ({ uri: uri.toString(), name: uri.name })),
        });
      });
    },
  };
}
