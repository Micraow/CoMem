/**
 * `forget`：删除节点（架构文档 §12.4、§13.2）。
 *
 * `rm` 语义：不可恢复，需要 manage 权限（§12.4 的出口清单）。非空目录必须显式
 * 传 `recursive=true`——一次误调用删掉整棵记忆树，比多传一个参数代价大。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  indexStatus,
  optionalBoolean,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

export const forgetTool: McpToolDefinition = {
  name: 'forget',
  kind: 'write',
  description:
    '确定某条记忆已经过时、且不应该再被检索到时才用这个，删除不可恢复。uri 指向目录时默认只允许删空目录，删整棵子树必须显式传 recursive=true。返回删除的文件数与索引状态；索引 pending 表示后台还没清理完。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '要删除的节点 URI' },
      recursive: { type: 'boolean', default: false, description: '是否删除整棵子树' },
    },
    required: ['uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'forget');
    const uri = Uri.parse(requiredString(args, 'uri', 'forget'));
    const recursive = optionalBoolean(args, 'recursive', false, 'forget');

    const stat = await context.filesystem.stat(uri);
    if (stat === null) {
      throw new ComemError('NOT_FOUND', `要删除的节点不存在：${uri.toString()}`, {
        uri: uri.toString(),
      });
    }
    if (!recursive && stat.kind === 'directory') {
      const children = await context.filesystem.list(uri);
      if (children.length > 0) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `目录不为空，需要 recursive=true 才能删除：${uri.toString()}`,
          { uri: uri.toString(), children: children.length },
        );
      }
    }

    const removed = await context.filesystem.remove(uri);
    const index = await indexStatus(context, uri, 'removed');
    context.logger.info('MCP forget 完成', {
      requestId: context.requestId,
      uri: uri.toString(),
      recursive,
      removedFiles: removed.removedFiles,
    });
    return textResult(
      `Deleted: ${uri.toString()}\nRemoved ${removed.removedFiles} file(s)\nIndex: ${index}`,
    );
  },
};
