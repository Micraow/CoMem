/**
 * `add_resource`：批量导入资料（架构文档 §13.2、§10.6 的批量写入）。
 *
 * 两种来源：纯文本资料直接给 `content`（agent 已规范化的正文），MCP 单入口就能
 * 用；要保留原始附件时先用 HTTP 的 `temp-upload` 拿 `uploadId`，再与 `content`
 * 一起提交——`uploadId` 落盘到 `.attachments/` 供 `download`，`content` 是索引与
 * 检索用的正文。两者可以同时给（原件 + 正文），后端不做 PDF / Office 解析。
 *
 * 批量路径在服务层入口去重祖先，写完后统一触发一次摘要重算（§10.6）——工具层
 * 只负责把一次调用的文件全部交给服务，不循环调用 `write`。
 */

import { WRITE_LEVEL } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { ResourceFileInput } from '../../../services/resource.js';
import {
  asRecord,
  indexStatus,
  nonEmptyString,
  optionalString,
  recordArray,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

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
    '把外部文件（文档 / 图片 / 代码）作为资料导入记忆库。要建可检索、可下载的资料节点时用它；逐个 write 会触发多次摘要重算，也会丢掉原始附件。files 每项必须有 path，且至少带 content（agent 转好的正文）或 uploadId（HTTP temp-upload 的附件 id，两者可同时给：原件 + 正文）——后端不解析 PDF / Office。',
  inputSchema: {
    type: 'object',
    properties: {
      parentUri: { type: 'string', description: '资料目录的父 URI；~ 是当前身份的根' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '逻辑路径，如 docs/api.md' },
            uploadId: {
              type: 'string',
              description: 'HTTP temp-upload 返回的附件 id；与 content 可同时给（原件 + 正文）',
            },
            content: { type: 'string', description: 'agent 规范化后的正文；纯文本资料只给它就够' },
            summary: { type: 'string', description: 'agent 给的文件摘要' },
          },
          required: ['path'],
        },
        description: '要导入的文件',
      },
    },
    required: ['parentUri', 'files'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'add_resource');
    const parentUri = Uri.parse(requiredString(args, 'parentUri', 'add_resource'));
    const files = recordArray(args, 'files', 'add_resource').map(toFileInput);

    // §12.4：摄取是 write 出口，服务层之外的授权在工具层先做。
    await context.acl.assert(parentUri, WRITE_LEVEL, context.principals);

    // 单个文件的大小上限由 `ResourceService` 统一执行（`DEFAULT_MAX_FILE_BYTES`，
    // `content` 的 UTF-8 字节数与附件原始字节走同一条判定）——这里不复制这个数字。
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
