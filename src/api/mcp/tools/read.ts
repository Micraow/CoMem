/**
 * `read`：读节点正文（架构文档 §13.2）。
 *
 * 文本返回正文；图片与音频返回二进制块（MCP 的 `image` / `audio` 内容）。多个 URI
 * 只能一起读文本——把二进制和文本拼在一个结果里，模型没法区分边界。
 *
 * `offset` / `limit` 按 **Unicode 码点**切片，不是字节也不是 UTF-16 码元：中文与
 * emoji 才不会从中间断开。`limit = -1` 表示读到末尾。切片实现与 HTTP 的
 * `content/read` 共用 `api/text-slice.ts`，两个读出口不各写一份。
 *
 * ## 截断标记
 *
 * MCP 的返回是文本，没有独立的 `truncated` 字段。切片之后如果**还有码点没返回**，
 * 在正文之后追加独立一行 `... (truncated)`；`limit = -1`、以及恰好切到末尾
 * （`offset + 返回码点数 == 总码点数`）都不标记。判据与 HTTP `content/read` 的
 * `truncated` 字段一致：两边不能一边说读完、一边说没读完。
 *
 * 标记必须与正文区分开：不追加标记时调用方只能靠「返回长度小于 limit」猜，而
 * 恰好读最后一页时返回长度也可能等于 limit。
 */

import { ComemError } from '../../../domain/errors.js';
import { contextTypeOf } from '../../../domain/node.js';
import { Uri } from '../../../domain/uri.js';
import { sliceText } from '../../text-slice.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  nonNegativeInteger,
  optionalString,
  readLimit,
  stringArray,
  textResult,
  type McpToolDefinition,
} from '../registry.js';
import { TRUNCATED_MARKER } from '../text.js';

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

/**
 * 记忆正文后面的 `## provenance` 块（W97）：这条记忆由哪几次归档归纳出来。
 *
 * 只有记忆节点、且 frontmatter 的 `sources` 非空时才追加——旧文件与普通资源的输出
 * 逐字节不变。块在 `offset` / `limit` 切片**之后**追加，分页读到这里时总是完整的
 * 一份（它不是正文，切一半没有意义）。
 *
 * `find` / `search` 的命中不带这个信息：命中要喂进 ≤2000 token 的提示词，`sources`
 * 会随命中数线性膨胀，而命中只需要回答「去哪读」。溯源属于「需要时读一次」。
 */
async function provenanceBlock(uri: Uri, context: McpToolContext): Promise<string> {
  if (contextTypeOf(uri) !== 'memory') {
    return '';
  }
  const record = await context.memory.read(uri);
  if (record === null || record.sources.length === 0) {
    return '';
  }
  const lines = record.sources.map((source) => `  - ${source}`);
  return `\n\n## provenance\nsources:\n${lines.join('\n')}`;
}

export const readTool: McpToolDefinition = {
  name: 'read',
  kind: 'read',
  description:
    '按 URI 读正文。已知路径时用它，比 find 准且没有相关度误差；要找路径用 find / glob。长文件用 offset / limit 按码点分段，limit=-1 读到末尾；还有内容没返回时正文之后会另起一行标记 ... (truncated)，恰好读完最后一页不会标记。二进制（图片 / 音频）只能单个 uri。返回去掉 frontmatter 的正文，摘要不在里面。记忆正文末尾的 ## provenance 块是溯源（这条记忆由哪几次归档产生），不是正文。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '单个节点 URI；~ 是当前身份的根' },
      uris: {
        type: 'array',
        items: { type: 'string' },
        description: '多个节点 URI（只能读文本）；与 uri 二选一，~ 同样有效',
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
      const text = sliceText(document.text, offset, limit);
      // 与 HTTP `content/read` 同一判据（`routes/content.ts`）：只有「还有码点没
      // 返回」才是截断。恰好切到末尾时 `offset + 返回码点数 == 总码点数`，不标记。
      const truncated =
        limit >= 0 && offset + [...text].length < [...document.text].length;
      const provenance = await provenanceBlock(uri, context);
      const marker = truncated ? `\n${TRUNCATED_MARKER}` : '';
      documents.push({ uri: uri.toString(), text: `${text}${provenance}${marker}` });
    }

    if (documents.length === 1) {
      return textResult(documents[0]?.text ?? '');
    }
    return textResult(
      documents.map((document) => `# ${document.uri}\n${document.text}`).join('\n\n'),
    );
  },
};
