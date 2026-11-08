/**
 * `add_resource`：批量导入资料（架构文档 §13.2、§10.6 的批量写入）。
 *
 * 分两步：附件先上传拿到 `uploadId`（HTTP 的 `temp-upload`），再来建资源。原始
 * 附件落盘保留，`download` 才有东西可下；`content` 是 agent 已经规范化好的文本，
 * 后端不做 PDF / Office 解析。
 *
 * 批量路径在服务层入口去重祖先，写完后统一触发一次摘要重算（§10.6）——工具层
 * 只负责把一次调用的文件全部交给服务，不循环调用 `write`。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { ResourceFileInput } from '../../../services/resource.js';
import {
  asRecord,
  indexStatus,
  nonEmptyString,
  optionalBoolean,
  optionalString,
  recordArray,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** §12.1：write = 3。 */
const WRITE = 3;

function toFileInput(
  file: Record<string, unknown>,
  index: number,
): ResourceFileInput {
  const path = nonEmptyString(file, 'path', 'add_resource');
  const uploadId = optionalString(file, 'uploadId', 'add_resource');
  const content = optionalString(file, 'content', 'add_resource');
  const summary = optionalString(file, 'summary', 'add_resource');

  if (uploadId === undefined && content === undefined) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `add_resource 的 files[${index}] 需要 uploadId 或 content。`,
      { tool: 'add_resource', index },
    );
  }
  return {
    path,
    ...(uploadId === undefined ? {} : { uploadId }),
    ...(content === undefined ? {} : { content }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export const addResourceTool: McpToolDefinition = {
  name: 'add_resource',
  kind: 'ingest',
  description:
    '要把一批外部文件（文档、图片、代码）作为资料存进记忆库时用这个，不要逐个 write——批量入口只触发一次摘要重算。files 里每项必须有 path，并至少带 uploadId（先上传）或 content（agent 已转好的文本）。返回 taskId，索引与摘要在后台进行。',
  inputSchema: {
    type: 'object',
    properties: {
      parentUri: { type: 'string', description: '资源目录的父 URI' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '逻辑路径，如 docs/api.md' },
            uploadId: { type: 'string', description: '临时上传返回的附件 id' },
            content: { type: 'string', description: '规范化后的文本' },
            summary: { type: 'string', description: 'agent 给的文件摘要' },
          },
          required: ['path'],
        },
        description: '要导入的文件',
      },
      wait: { type: 'boolean', default: false },
    },
    required: ['parentUri', 'files'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'add_resource');
    const parentUri = Uri.parse(requiredString(args, 'parentUri', 'add_resource'));
    const files = recordArray(args, 'files', 'add_resource').map(toFileInput);
    const wait = optionalBoolean(args, 'wait', false, 'add_resource');

    // §12.4：摄取是 write 出口，服务层之外的授权在工具层先做。
    await context.acl.assert(parentUri, WRITE, context.principals);

    const result = await context.resource.addResource({
      parentUri,
      files,
      subject: context.subject,
      principals: context.principals,
    });
    const index = await indexStatus(context, parentUri, 'indexed');
    context.logger.info('MCP add_resource 已提交', {
      requestId: context.requestId,
      parentUri: parentUri.toString(),
      files: files.length,
      wait,
      created: result.created.length,
      updated: result.updated.length,
      skipped: result.skipped.length,
      indexed: result.tokens.indexed,
    });
    const skipped =
      result.skipped.length === 0
        ? ''
        : `\nSkipped: ${result.skipped.map((entry) => entry.path).join(', ')}`;
    return textResult(
      `Added ${files.length} file(s) to ${parentUri.toString()} (created: ${result.created.length}, updated: ${result.updated.length}, skipped: ${result.skipped.length}).${skipped}\nIndex: ${index}`,
    );
  },
};
