/**
 * `read`：读节点正文（架构文档 §13.2）。
 *
 * 文本返回正文；图片与音频返回二进制块（MCP 的 `image` / `audio` 内容）。多个 URI
 * 只能一起读文本——把二进制和文本拼在一个结果里，模型没法区分边界。
 *
 * `offset` / `limit` 按 **Unicode 码点**切片，不是字节也不是 UTF-16 码元：中文与
 * emoji 才不会从中间断开。`limit = -1` 表示读到末尾。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  nonNegativeInteger,
  optionalString,
  readLimit,
  stringArray,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** 扩展名 → MIME。只收图片与音频：其它二进制没有对应的 MCP 内容块。 */
const BINARY_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  weba: 'audio/webm',
});

function binaryMimeType(uri: Uri): string | null {
  const name = uri.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  return BINARY_MIME_TYPES[name.slice(dot + 1)] ?? null;
}

/** 按码点切片。`limit = -1` 取到末尾。 */
function sliceText(text: string, offset: number, limit: number): string {
  const codePoints = [...text];
  return codePoints.slice(offset, limit < 0 ? undefined : offset + limit).join('');
}

export const readTool: McpToolDefinition = {
  name: 'read',
  kind: 'read',
  description:
    '已经知道确切路径时用这个，比 find 快且没有相关度误差。看长文件时用 offset / limit 分段读，limit 默认 -1 会读到末尾；二进制只支持单个 uri。返回是去掉 frontmatter 的正文，摘要不在里面，要摘要用 find。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '单个节点 URI' },
      uris: {
        type: 'array',
        items: { type: 'string' },
        description: '多个节点 URI；与 uri 二选一',
      },
      offset: { type: 'integer', minimum: 0, default: 0, description: '起始码点偏移' },
      limit: {
        type: 'integer',
        description: '最多读多少码点；-1 表示读到末尾',
        default: -1,
      },
    },
  },
  async execute(input, context) {
    const args = asRecord(input, 'read');
    const offset = nonNegativeInteger(args, 'offset', 0, 'read');
    const limit = readLimit(args, 'limit', -1, 'read');
    const single = optionalString(args, 'uri', 'read');
    const multiple = args['uris'] === undefined ? undefined : stringArray(args, 'uris', 'read');

    if (single !== undefined && multiple !== undefined) {
      throw new ComemError('INVALID_ARGUMENT', 'read 的 uri 与 uris 只能传一个。', {
        tool: 'read',
      });
    }
    if (single === undefined && multiple === undefined) {
      throw new ComemError('INVALID_ARGUMENT', 'read 需要 uri 或 uris。', { tool: 'read' });
    }

    const targets = multiple ?? [single ?? ''];
    const documents: { readonly uri: string; readonly text: string }[] = [];
    for (const value of targets) {
      const uri = Uri.parse(value);
      const mimeType = binaryMimeType(uri);
      if (mimeType !== null) {
        if (targets.length > 1) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `read 的多 URI 模式只能读文本，二进制请单独读：${uri.toString()}`,
            { tool: 'read', uri: uri.toString() },
          );
        }
        const bytes = await context.filesystem.readBytes(uri, context.principals);
        return { type: 'binary', mimeType, base64: Buffer.from(bytes).toString('base64') };
      }
      const document = await context.filesystem.read(uri, context.principals);
      documents.push({ uri: uri.toString(), text: sliceText(document.text, offset, limit) });
    }

    if (documents.length === 1) {
      return textResult(documents[0]?.text ?? '');
    }
    return textResult(
      documents.map((document) => `# ${document.uri}\n${document.text}`).join('\n\n'),
    );
  },
};
