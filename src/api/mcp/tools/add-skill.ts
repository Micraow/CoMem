/**
 * `add_skill`：安装技能（架构文档 §13.2）。
 *
 * 技能是一组文件，安装在 `parentUri` 下；`name` 是目录名。文件内容按 UTF-8
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
  return {
    path: nonEmptyString(file, 'path', 'add_skill'),
    content: ENCODER.encode(requiredString(file, 'content', 'add_skill')),
  };
}

export const addSkillTool: McpToolDefinition = {
  name: 'add_skill',
  kind: 'ingest',
  description:
    '把一组文件安装成可复用技能（skills/{name}/）。要沉淀「怎么做一件事」的可执行包时用；只是存文档用 add_resource。name 是目录名。再次安装同名技能时，本次提交的同路径文件被覆盖；上一版存在但本次未提供的文件不会被移除（仍能被 find / grep 检到）。files 每项必须有 path 与 content（UTF-8 文本），二进制不在支持范围内。',
  inputSchema: {
    type: 'object',
    properties: {
      parentUri: { type: 'string', description: '技能目录的父 URI；~ 是当前身份的根' },
      name: { type: 'string', description: '技能名，作为目录名' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '技能内相对路径' },
            content: { type: 'string', description: 'UTF-8 文本内容' },
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
    await context.acl.assert(parentUri, WRITE, context.principals);

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
