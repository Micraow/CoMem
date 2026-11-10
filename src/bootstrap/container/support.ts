/**
 * 装配共用的小工具：常量、路径、错误与选项读取。
 *
 * 全部是无状态的纯函数/常量，阶段文件只 import 不写回——装配阶段之间没有经由这里的
 * 可变状态。
 */

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { ComemError, errorMessage } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
export const META_DIRECTORY = '_meta';

/**
 * 模板里的占位地址。`api.example.com` 是 IANA 保留域名（RFC 2606），永远不可达。
 *
 * 按**主机名**判断而不是整串相等：路径、端口、协议都可能被改成看起来更真实的
 * 样子，但保留域名本身仍然是占位。`new URL` 解析失败时不算占位——那是另一种
 * 配置错误，不该被这条 warn 掩盖。
 */
const PLACEHOLDER_LLM_BASE_URL_HOST = 'api.example.com';

/** 数据根下 `_meta` 的绝对路径。 */
export function metaPath(dataDir: string, ...segments: readonly string[]): string {
  return join(dataDir, META_DIRECTORY, ...segments);
}

/** `MemoryService.prefetch` 传的是 `{scopes, limit}`；身份由装配方补。 */
export function readScopesOption(
  options: unknown,
  fallback: readonly string[],
): readonly string[] {
  if (!isRecord(options)) {
    return fallback;
  }
  const scopes = options['scopes'];
  if (!Array.isArray(scopes)) {
    return fallback;
  }
  const strings = scopes.filter((item): item is string => typeof item === 'string');
  return strings.length === 0 ? fallback : strings;
}

export function readLimitOption(options: unknown): number | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  const limit = options['limit'];
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export function llmBaseUrlIsPlaceholder(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === PLACEHOLDER_LLM_BASE_URL_HOST;
  } catch {
    return false;
  }
}

/**
 * 启动自检：数据根可写。
 *
 * 只读数据根时服务能起来，但第一次写入才失败——那时已经在处理用户请求了。启动期
 * 拒绝比运行期 500 好。
 */
export async function assertDataDirWritable(dataDir: string): Promise<void> {
  try {
    await access(dataDir, fsConstants.W_OK);
    await access(join(dataDir, META_DIRECTORY), fsConstants.W_OK);
  } catch (error) {
    throw new ComemError('INTERNAL', `数据根不可写：${dataDir}`, {
      dataDir,
      error: errorMessage(error),
    });
  }
}
