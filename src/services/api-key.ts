/**
 * API Key 的格式（架构文档 §12.7）。
 *
 * 一把 key 形如：
 *
 * ```
 * comem_<prefix 8 字符 base62>_<secret 32 字节 base64url>
 * ```
 *
 * `prefix` 明文存库并建唯一索引：校验时按它等值查找，再对 secret 做 scrypt
 * 比对。prefix 不是秘密——它只回答「这是哪一把 key」，泄露它拿不到任何权限。
 *
 * ## 为什么 secret 用 base64url 而不是 base62
 *
 * base62 需要自己实现编码；`randomBytes(32).toString('base64url')` 是标准库
 * 的常数时间实现，43 个字符提供 256 位熵。secret 里出现 `-` / `_` 不影响
 * 解析：分隔符是 `_`，但 base64url 的字母表里**没有** `_` 吗？有——`_` 就是
 * base64url 的第 63 个字符。所以解析必须按**前两个**下划线切分，不能 split
 * 全部。实现见 `parseApiKey`。
 *
 * 为了让「按前缀切分」没有歧义，prefix 只用 base62（没有 `_`），secret 里即使
 * 出现 `_` 也不会被误当成 prefix 的结尾。
 */

import { randomBytes, randomInt } from 'node:crypto';

/** base62 字母表：0-9 A-Z a-z。prefix 只用它。 */
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** prefix 长度。8 个 base62 字符约 47.6 位，单机部署撞不上。 */
const PREFIX_LENGTH = 8;

/** secret 的随机字节数。32 字节 = 256 位。 */
const SECRET_BYTES = 32;

/** 格式前缀。解析时先比它，避免把任意 bearer token 当 key。 */
const KEY_PREFIX = 'comem';

/** 解析结果。 */
export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

/** 生成 prefix。`randomInt` 走的是拒绝采样，没有取模偏差。 */
function generatePrefix(): string {
  let prefix = '';
  for (let index = 0; index < PREFIX_LENGTH; index += 1) {
    prefix += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }
  return prefix;
}

/**
 * 生成一把新 key。
 *
 * 返回明文 `raw`（只应出现在创建响应里一次）与拆开的 `prefix` / `secret`
 * （secret 要立刻哈希，不要保存明文）。
 */
export function generateApiKey(): {
  readonly raw: string;
  readonly prefix: string;
  readonly secret: string;
} {
  const prefix = generatePrefix();
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { raw: `${KEY_PREFIX}_${prefix}_${secret}`, prefix, secret };
}

/**
 * 解析 `comem_<prefix>_<secret>`。格式不对返回 `null`，**不抛**——认证头是
 * 调用方输入，非法输入应当表现为 401 而不是 500。
 *
 * 按**第一个**下划线切出 prefix、**第二个**切出 secret 的起点：secret 是
 * base64url，可能包含 `_`，`split('_')` 会把 secret 切成多段。
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const firstSeparator = raw.indexOf('_');
  if (firstSeparator === -1 || raw.slice(0, firstSeparator) !== KEY_PREFIX) {
    return null;
  }
  const secondSeparator = raw.indexOf('_', firstSeparator + 1);
  if (secondSeparator === -1) {
    return null;
  }
  const prefix = raw.slice(firstSeparator + 1, secondSeparator);
  const secret = raw.slice(secondSeparator + 1);
  if (prefix.length !== PREFIX_LENGTH || secret.length === 0) {
    return null;
  }
  for (const character of prefix) {
    if (!BASE62_ALPHABET.includes(character)) {
      return null;
    }
  }
  return { prefix, secret };
}
