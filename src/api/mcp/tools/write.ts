/**
 * `write`：写正文（架构文档 §10.6、§13.2）。
 *
 * 三种模式：
 * - `replace`：覆盖正文，保留磁盘上现有的 frontmatter（§10.6 元数据写保护）；
 * - `append`：只追加正文，同样不碰 frontmatter；
 * - `create`：目标已存在时抛 `ALREADY_EXISTS`，用于「只在没有时创建」。
 *
 * 索引由 `NodeWriteObserver` 在文件落盘后同步更新：返回时索引已经更新，结果里的
 * `Index:` 行就是它的状态，不需要额外的「等待」参数。
 */

import { WRITE_LEVEL } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import { WRITE_MODES, type WriteMode } from '../../write-mode.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  indexStatus,
  optionalEnum,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** `append` / `create` 需要先读现有正文；不存在按空串处理。 */
async function readExisting(context: McpToolContext, uri: Uri): Promise<string> {
  try {
    return (await context.filesystem.read(uri, context.principals)).text;
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return '';
    }
    throw error;
  }
}

export const writeTool: McpToolDefinition = {
  name: 'write',
  kind: 'write',
  description:
    '写整个文件正文。新建文件或整段替换时用；只改一小段用 edit，它不会覆盖没读到的内容。mode=replace 覆盖（保留 frontmatter）、append 追加、create 在目标已存在时报 ALREADY_EXISTS。返回字节数、是否新建与索引状态；pending 表示检索暂时看不到这个文件。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '文件 URI；~ 是当前身份的根' },
      content: { type: 'string', description: '正文；空串表示写空文件' },
      mode: { type: 'string', enum: WRITE_MODES, default: 'replace' },
    },
    required: ['uri', 'content'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'write');
    const uri = Uri.parse(requiredString(args, 'uri', 'write'));
    const content = requiredString(args, 'content', 'write');
    const mode = optionalEnum(args, 'mode', WRITE_MODES, 'replace', 'write');

    // `create` / `append` 在写盘前要判断目标是否存在、读现有正文——那是读操作。
    // 全新路径在物化表里没有行，而读路径只给「磁盘上已存在」的节点补物化，于是
    // 写操作会先撞上 read 求权并被误报成「需要 read（1）级别」。先按 write 求权
    // 一次（`InheritingAuthorizer` 会为写操作物化新节点），与 HTTP
    // `POST /content/write` 的顺序一致。
    await context.acl.assert(uri, WRITE_LEVEL, context.principals);

    const result = await writeWithMode(context, uri, content, mode);
    const index = await indexStatus(context, uri, 'indexed');
    context.logger.debug('MCP write 完成', {
      requestId: context.requestId,
      uri: uri.toString(),
      mode,
    });

    return textResult(
      `Wrote ${Buffer.byteLength(content, 'utf8')} byte(s) to ${uri.toString()} (mode: ${mode}, created: ${String(result.created)})\nIndex: ${index}`,
    );
  },
};

async function writeWithMode(
  context: McpToolContext,
  uri: Uri,
  content: string,
  mode: WriteMode,
): Promise<{ readonly created: boolean }> {
  switch (mode) {
    case 'replace':
      return context.filesystem.write(uri, content, context.principals);
    case 'append': {
      const existing = await readExisting(context, uri);
      return context.filesystem.write(uri, `${existing}${content}`, context.principals);
    }
    case 'create': {
      if ((await context.filesystem.stat(uri, context.principals)) !== null) {
        throw new ComemError('ALREADY_EXISTS', `目标已存在：${uri.toString()}`, {
          uri: uri.toString(),
        });
      }
      return context.filesystem.write(uri, content, context.principals);
    }
    default: {
      // `WRITE_MODES`（`api/write-mode.ts`）加一个模式时这一行编译失败——
      // 否则新模式会掉进「没有分支」的缝隙里，返回 `undefined` 而不是写盘。
      const exhaustive: never = mode;
      throw new ComemError('INVALID_ARGUMENT', `write 的 mode 不受支持：${String(exhaustive)}`, {
        mode: exhaustive,
      });
    }
  }
}
