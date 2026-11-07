/**
 * `edit`：SEARCH/REPLACE 替换（架构文档 §11.2、§13.2）。
 *
 * 默认要求 `oldString` **唯一命中**：多处命中时宁可报错也不猜一处（§11.2）。要替换
 * 全部命中必须显式传 `replaceAll=true`，这样「一次改多行」是调用方的决定，不是
 * 工具的启发式。
 */

import { ComemError } from '../../../domain/errors.js';
import { stableDigest } from '../../../domain/node.js';
import { Uri } from '../../../domain/uri.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  indexStatus,
  nonEmptyString,
  optionalBoolean,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

export const editTool: McpToolDefinition = {
  name: 'edit',
  kind: 'write',
  description:
    '改一小段正文时用这个，比 write 安全——write 会覆盖整个文件。oldString 必须与磁盘上的正文完全一致（含空白），默认只能命中一处；明确要改多处的才传 replaceAll=true。返回替换次数；命中零处或多处时不会写文件。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '文件 URI' },
      oldString: { type: 'string', description: '要替换的原文，必须精确匹配' },
      newString: { type: 'string', description: '替换后的文本，允许空串' },
      replaceAll: { type: 'boolean', default: false },
    },
    required: ['uri', 'oldString', 'newString'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'edit');
    const uri = Uri.parse(requiredString(args, 'uri', 'edit'));
    const oldString = nonEmptyString(args, 'oldString', 'edit');
    const newString = requiredString(args, 'newString', 'edit');
    const replaceAll = optionalBoolean(args, 'replaceAll', false, 'edit');

    const applied = replaceAll
      ? await replaceEverywhere(context, uri, oldString, newString)
      : (await context.filesystem.edit(uri, [{ search: oldString, replace: newString }])).applied;

    const index = await indexStatus(context, uri, 'indexed');
    context.logger.debug('MCP edit 完成', {
      requestId: context.requestId,
      uri: uri.toString(),
      replaceAll,
      applied,
    });
    return textResult(
      `Replaced ${applied} occurrence(s) in ${uri.toString()}\nIndex: ${index}`,
    );
  },
};

/**
 * 替换全部命中。
 *
 * 不用 `String.prototype.replaceAll`：它把替换串里的 `$&`、`$1` 当特殊语法，模型
 * 写出的 `newString` 会被静默改写。`split` / `join` 是字面替换。
 */
async function replaceEverywhere(
  context: McpToolContext,
  uri: Uri,
  oldString: string,
  newString: string,
): Promise<number> {
  const document = await context.filesystem.read(uri);
  const applied = document.text.split(oldString).length - 1;
  if (applied === 0) {
    throw new ComemError('INVALID_ARGUMENT', `补丁应用失败：没有命中 ${oldString}`, {
      uri: uri.toString(),
      reason: 'not_found',
    });
  }
  await context.filesystem.write(uri, document.text.split(oldString).join(newString), {
    expectedDigest: stableDigest(document.text),
  });
  return applied;
}
