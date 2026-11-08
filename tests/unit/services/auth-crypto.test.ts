import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateApiKey, parseApiKey } from '../../../src/services/api-key.js';
import { hashSecret, verifySecret } from '../../../src/services/password.js';
import { issueSessionToken, verifySessionToken } from '../../../src/services/session-token.js';

describe('password', () => {
  it('哈希带算法参数与盐，同一密码两次哈希不同', async () => {
    const first = await hashSecret('correct horse battery staple');
    const second = await hashSecret('correct horse battery staple');

    expect(first).not.toBe(second);
    expect(first.startsWith('scrypt$16384$8$1$')).toBe(true);
    // 两个字段：16 字节盐、64 字节摘要，都是 base64。
    const [salt, digest] = first.split('$').slice(4);
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(digest ?? '', 'base64')).toHaveLength(64);
  });

  it('正确密码通过、错误密码不通过', async () => {
    const stored = await hashSecret('s3cret');
    await expect(verifySecret('s3cret', stored)).resolves.toBe(true);
    await expect(verifySecret('s3cret ', stored)).resolves.toBe(false);
    await expect(verifySecret('', stored)).resolves.toBe(false);
  });

  it('编码不合法时返回 false，不抛（认证头是调用方输入）', async () => {
    for (const stored of ['', 'plain', 'scrypt$1$2$3', 'bcrypt$16384$8$1$AAAA$BBBB']) {
      await expect(verifySecret('x', stored)).resolves.toBe(false);
    }
  });
});

describe('api-key', () => {
  it('格式是 comem_<8 位 base62>_<secret>，prefix 与 secret 可拆回', () => {
    const { raw, prefix, secret } = generateApiKey();

    expect(raw.startsWith('comem_')).toBe(true);
    expect(raw).toContain(`comem_${prefix}_`);
    expect(prefix).toHaveLength(8);
    expect(prefix).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(secret).not.toBe('');
    expect(parseApiKey(raw)).toEqual({ prefix, secret });
  });

  it('secret 里的下划线不会被当成 prefix 分隔符', () => {
    // 直接构造一个 secret 含 `_` 的串：base64url 字母表含 `_`，按前两个下划线切分
    // 才不会截断。
    expect(parseApiKey('comem_abcd1234_AA_BB_CC')).toEqual({
      prefix: 'abcd1234',
      secret: 'AA_BB_CC',
    });
  });

  it('格式不对返回 null', () => {
    for (const raw of [
      '',
      'comem_',
      'comem_abcd1234',
      'comem_abcd1234_',
      'comem_abc_xyz',
      'bearer comem_abcd1234_secret',
      'OCMEM_abcd1234_secret',
    ]) {
      expect(parseApiKey(raw), raw).toBeNull();
    }
  });
});

describe('session-token', () => {
  const SECRET = 'test-secret';
  const NOW = new Date('2026-01-01T00:00:00Z');

  /** 手工签一个载荷任意的 token：用于构造「协议上不该出现」的形态。 */
  function tokenWithPayload(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signed = `v1.${encoded}`;
    return `${signed}.${createHmac('sha256', SECRET).update(signed).digest('base64url')}`;
  }

  it('签发的 token 可以被同一 secret 校验，载荷是用户、身份版本与过期时刻', () => {
    const { token, expiresAt } = issueSessionToken(SECRET, 'alice', 'epoch-1', 3600, NOW);
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 3600);
    expect(verifySessionToken(SECRET, token, NOW)).toEqual({
      userId: 'alice',
      epoch: 'epoch-1',
      expiresAt,
    });
  });

  it('换 secret、改载荷、过期都校验失败', () => {
    const { token } = issueSessionToken(SECRET, 'alice', 'epoch-1', 1, NOW);
    const [version, payload, signature] = token.split('.');
    expect(verifySessionToken('other-secret', token, NOW)).toBeNull();
    expect(
      verifySessionToken(SECRET, `${version}.${payload}x.${signature}`, NOW),
    ).toBeNull();
    // TTL 1 秒，两秒后过期。
    expect(verifySessionToken(SECRET, token, new Date(NOW.getTime() + 2000))).toBeNull();
  });

  it('载荷缺少身份版本或版本为空串时校验失败', () => {
    // 空串是迁移遗留的「版本未知」。如果这里放行，`IdentityService` 的比对会因为
    // 两边都是空串而通过——旧 token 在账号重建后继续有效，正是这次要修的缺陷。
    for (const payload of [
      { sub: 'alice', iat: 0, exp: 4_102_444_800 },
      { sub: 'alice', iat: 0, exp: 4_102_444_800, epoch: '' },
      { sub: 'alice', iat: 0, exp: 4_102_444_800, epoch: 42 },
    ]) {
      expect(verifySessionToken(SECRET, tokenWithPayload(payload), NOW), JSON.stringify(payload)).toBeNull();
    }
  });

  it('任意畸形串返回 null，不抛', () => {
    for (const token of ['', 'a.b', 'a.b.c', 'v1..', 'v2.abc.def', 'v1.!!!.???']) {
      expect(verifySessionToken(SECRET, token, NOW)).toBeNull();
    }
  });
});
