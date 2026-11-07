/**
 * `add_skill`：安装技能（架构文档 §13.2）。
 *
 * 技能是一组可执行文件，安装在 `parentUri` 下；`name` 是目录名。文件内容按 UTF-8
 * 文本传输——MCP 的参数是 JSON，没有字节串类型。二进制技能不在支持范围内。
 *
 * 与 `add_resource` 一样走批量入口：一次调用写完所有文件，索引只在结束时更新一次。
 */

import { Uri } from '../../../domain/uri.js';
import type { SkillFileInput } from '../../../services/skill.js';
import {
  asRecord,
  indexStatus,
  nonEmptyString,
  optionalBoolean,
  recordArray,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §12.1：write = 3。 */
const WRITE = 3;

/** 技能文件按 UTF-8 传输（见文件头）。 */
const ENCODER = new TextEncoder();

function toFileInput(file: Record<string, unknown>): SkillFileInput {
  const executable = optionalBoolean(file, 'executable', false, 'add_skill');
  return {
    path: nonEmptyString(file, 'path', 'add_skill'),
    content: ENCODER.encode(requiredString(file, 'content', 'add_skill')),
    ...(executable ? { executable } : {}),
  };
}

export const addSkillTool: McpToolDefinition = {
  name: 'add_skill',
  kind: 'ingest',
  description:
    '要把一组可执行文件注册成可复用技能时用这个；只是存文档用 add_resource。name 会成为技能目录名，重复安装同名技能会覆盖。files 里每项必须有 path 与 content（UTF-8 文本），executable=true 会给文件加执行位。返回安装结果与索引状态。',
  inputSchema: {
    type: 'object',
    properties: {
      parentUri: { type: 'string', description: '技能目录的父 URI' },
      name: { type: 'string', description: '技能名，作为目录名' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '技能内相对路径' },
            content: { type: 'string', description: 'UTF-8 文本内容' },
            executable: { type: 'boolean', default: false },
          },
          required: ['path', 'content'],
        },
        description: '技能包含的文件',
      },
    },
    required: ['parentUri', 'name', 'files'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'add_skill');
    const parentUri = Uri.parse(requiredString(args, 'parentUri', 'add_skill'));
    const name = nonEmptyString(args, 'name', 'add_skill');
    const files = recordArray(args, 'files', 'add_skill').map(toFileInput);

    // §12.4：安装技能是 write 出口。
    await context.acl.assert(parentUri, WRITE);

    const result = await context.skill.addSkill({
      parentUri,
      name,
      files,
      subject: context.subject,
      principals: context.principals,
    });
    const index = await indexStatus(context, result.skillUri, 'indexed');
    context.logger.info('MCP add_skill 已安装', {
      requestId: context.requestId,
      parentUri: parentUri.toString(),
      skillUri: result.skillUri.toString(),
      name,
      files: result.fileCount,
    });
    return textResult(
      `Installed skill "${name}" with ${result.fileCount} file(s) at ${result.skillUri.toString()}.\nIndex: ${index}`,
    );
  },
};
