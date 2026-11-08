/**
 * `write`：写正文（架构文档 §10.6、§13.2）。
 *
 * 三种模式：
 * - `replace`：覆盖正文，保留磁盘上现有的 frontmatter（§10.6 元数据写保护）；
 * - `append`：只追加正文，同样不碰 frontmatter；
 * - `create`：目标已存在时抛 `ALREADY_EXISTS`，用于「只在没有时创建」。
 *
 * `wait` 是给「写后立刻读」的调用方的：观察者是同步调用的，返回时索引已经更新；
 * 传 true 只影响日志，不改变行为。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  indexStatus,
  optionalBoolean,
  optionalEnum,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

const MODES = ['replace', 'append', 'create'] as const;

type WriteMode = (typeof MODES)[number];

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
      mode: { type: 'string', enum: MODES, default: 'replace' },
      wait: { type: 'boolean', default: false, description: '写后是否等待索引更新' },
    },
    required: ['uri', 'content'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'write');
    const uri = Uri.parse(requiredString(args, 'uri', 'write'));
    const content = requiredString(args, 'content', 'write');
    const mode = optionalEnum(args, 'mode', MODES, 'replace', 'write');
    const wait = optionalBoolean(args, 'wait', false, 'write');

    const result = await writeWithMode(context, uri, content, mode);
    const index = await indexStatus(context, uri, 'indexed');
    context.logger.debug('MCP write 完成', {
      requestId: context.requestId,
      uri: uri.toString(),
      mode,
      wait,
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
  }
}
