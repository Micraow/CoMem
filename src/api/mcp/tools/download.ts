/**
 * `download`：短期签名 URL（架构文档 §13.2）。
 *
 * 原始附件必须能被浏览器或 `curl` 直接下载，MCP 的文本/二进制块不适合大文件。
 * URL 带 `expires` 与 HMAC-SHA256 签名，10 分钟后失效；签名密钥是**进程级随机
 * 值**——单进程部署下 URL 只在签发它的进程里有效，重启即全部作废，这是刻意的：
 * 泄露的链接不应该跨越重启继续可用。
 *
 * HTTP 层验证签名时复用本文件导出的 `verifyDownloadToken`，保证签发与验证只有
 * 一份实现。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ComemConfig } from '../../../config/index.js';
import { ComemError } from '../../../domain/errors.js';
import { MILLISECONDS_PER_SECOND } from '../../../domain/time.js';
import { Uri } from '../../../domain/uri.js';
import { asRecord, requiredString, textResult, type McpToolDefinition } from '../registry.js';

/** 10 分钟（§13.2）。 */
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;

/** 进程级签名密钥。见文件头：重启作废是刻意的。 */
const DOWNLOAD_SECRET = randomBytes(32);

function sign(payload: string): string {
  return createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('base64url');
}

function payloadOf(uri: string, expiresSeconds: number): string {
  return `${uri}\n${expiresSeconds}`;
}

/** 签发一个 10 分钟有效的下载 URL。 */
export function createDownloadUrl(uri: Uri, config: ComemConfig): string {
  const expiresSeconds = Math.floor((Date.now() + DOWNLOAD_TTL_MS) / MILLISECONDS_PER_SECOND);
  const signature = sign(payloadOf(uri.toString(), expiresSeconds));
  const query = new URLSearchParams({
    uri: uri.toString(),
    expires: String(expiresSeconds),
    signature,
  });
  return `http://${config.server.host}:${config.server.port}/api/v1/content/download?${query.toString()}`;
}

/** 校验签名与过期时间。HTTP 层的下载端点调用它。 */
export function verifyDownloadToken(
  uri: string,
  expires: string,
  signature: string,
  now: number = Date.now(),
): boolean {
  const expiresSeconds = Number(expires);
  if (!Number.isFinite(expiresSeconds) || expiresSeconds * MILLISECONDS_PER_SECOND < now) {
    return false;
  }
  const expected = Buffer.from(sign(payloadOf(uri, expiresSeconds)), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const downloadTool: McpToolDefinition = {
  name: 'download',
  kind: 'read',
  description:
    '签发一个 10 分钟有效的下载 URL。要把原始文件交给用户或外部工具时用；自己看内容用 read 更直接。uri 必须指向文件，目录会报 NOT_FOUND。链接不要写进长期配置，也不要转给别人。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '要下载的文件 URI；~ 是当前身份的根' },
    },
    required: ['uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'download');
    const uri = Uri.parse(requiredString(args, 'uri', 'download'));

    // `stat` 会先过 Authorizer（read），不存在时返回 null。
    const stat = await context.filesystem.stat(uri, context.principals);
    if (stat === null || stat.kind !== 'file') {
      throw new ComemError('NOT_FOUND', `下载目标不是文件：${uri.toString()}`, {
        uri: uri.toString(),
      });
    }

    const url = createDownloadUrl(uri, context.config);
    context.logger.debug('MCP download 已签发', {
      requestId: context.requestId,
      uri: uri.toString(),
    });
    return textResult(`Download URL (expires in 10 minutes):\n${url}`);
  },
};
