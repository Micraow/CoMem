/**
 * 密码与 API Key secret 的哈希（架构文档 §12.7）。
 *
 * 用 `node:crypto` 的 `scrypt`，**不引入 `argon2` 原生依赖**：AGENTS.md §1 的
 * 判断标准是「别人按文档部署后能不能用」，原生编译是部署门槛——`node:crypto`
 * 开箱即有，`argon2` 要过一遍 node-gyp。scrypt 也是 OWASP 推荐的密码哈希之一。
 *
 * ## 参数
 *
 * `N=16384, r=8, p=1, keylen=64`，salt 16 字节随机。这组参数是 Node 文档
 * `scrypt` 的推荐下界（`N` 是 CPU/内存代价，`r` / `p` 是块大小与并行度），
 * 单次约几十毫秒，足以让离线爆破不可行，又不会让登录路径不可用。
 *
 * ## 存储格式
 *
 * `scrypt$N$r$p$<salt_b64>$<hash_b64>`。参数写进哈希串而不是只放常量：以后调
 * 参数时旧哈希仍然可校验，不需要「先全部重置密码」。
 *
 * ## 为什么校验用 `timingSafeEqual`
 *
 * 逐字节比较会在第一个不同的字节提前返回，攻击者能据此逐位试探哈希。比较前先
 * 比长度——长度不同直接 false，不需要常数时间。
 *
 * ## 这个模块不是密码强度策略
 *
 * 长度 / 字符集校验在路由层（请求体校验），这里只回答「怎么哈希、怎么比对」。
 * 两者混在一起会让「换哈希参数」和「换密码策略」变成同一次改动。
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { ComemError } from '../domain/errors.js';

/** 架构文档 §12.7 的参数；改动必须能校验旧哈希（见文件头的格式说明）。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** 编码前缀。解析时先比它，避免把任意字符串当哈希。 */
const ALGORITHM = 'scrypt';

interface ScryptOptions {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem?: number;
}

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `maxmem` 默认 32MB，够 N=16384, r=8（约 16MB）。不传让它用默认值，
    // 显式传一个更大的值反而会掩盖「参数被调到内存不够」这件事。
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/**
 * 哈希一个密码（或 API Key 的 secret），返回可存库的编码串。
 *
 * 输入是明文，输出包含随机 salt，**同一输入两次调用的结果不同**——这是 salt
 * 的作用，不是 bug。
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    ALGORITHM,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验明文与存储的哈希串是否匹配。
 *
 * 哈希串格式不合法（不是本模块产出的、参数不是正整数、base64 解出来长度不对）
 * 一律返回 `false`，**不抛**：库里的脏数据应该表现为「这次登录失败」，而不是
 * 登录端点 500。
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) {
    return false;
  }
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  if (
    algorithm !== ALGORITHM ||
    rawN === undefined ||
    rawR === undefined ||
    rawP === undefined ||
    rawSalt === undefined ||
    rawHash === undefined
  ) {
    return false;
  }

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  if (N <= 0 || r <= 0 || p <= 0) {
    return false;
  }

  const salt = Buffer.from(rawSalt, 'base64');
  const expected = Buffer.from(rawHash, 'base64');
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let actual: Buffer;
  try {
    actual = await derive(secret, salt, expected.length, { N, r, p });
  } catch {
    // 参数超出资源上限、内存不够等：当作「这次校验失败」。不要把内部错误透出去。
    return false;
  }
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * 密码强度策略（唯一入口，路由与命令都调它）。
 *
 * 之前仓库里没有策略：`POST /admin/users/{id}/password` 只要求非空串，
 * `pnpm password` 也只拒绝空串。这里补一条**下界**，不引入大小写 / 数字 / 符号的
 * 组合规则——NIST SP 800-63B §5.1.1.2 明确建议不要用组合规则（它们把用户推向
 * `Password1!` 这类可预测的形态，且不提高熵）。长度下界取 8，是同一节的建议值。
 *
 * 全空白密码单独拒绝：它满足长度下界，但输入法误触（连按空格）会产出这种口令。
 */
const MIN_PASSWORD_LENGTH = 8;

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.trim() === '') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符，且不能全是空白。`,
      { field: 'password', minLength: MIN_PASSWORD_LENGTH },
    );
  }
}
