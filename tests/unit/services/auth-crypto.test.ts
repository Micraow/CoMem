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

  it('签发的 token 可以被同一 secret 校验，载荷是用户与过期时刻', () => {
    const { token, expiresAt } = issueSessionToken(SECRET, 'alice', 3600, NOW);
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 3600);
    expect(verifySessionToken(SECRET, token, NOW)).toEqual({
      userId: 'alice',
      expiresAt,
    });
  });

  it('换 secret、改载荷、过期都校验失败', () => {
    const { token } = issueSessionToken(SECRET, 'alice', 1, NOW);
    const [version, payload, signature] = token.split('.');
    expect(verifySessionToken('other-secret', token, NOW)).toBeNull();
    expect(
      verifySessionToken(SECRET, `${version}.${payload}x.${signature}`, NOW),
    ).toBeNull();
    // TTL 1 秒，两秒后过期。
    expect(verifySessionToken(SECRET, token, new Date(NOW.getTime() + 2000))).toBeNull();
  });

  it('任意畸形串返回 null，不抛', () => {
    for (const token of ['', 'a.b', 'a.b.c', 'v1..', 'v2.abc.def', 'v1.!!!.???']) {
      expect(verifySessionToken(SECRET, token, NOW)).toBeNull();
    }
  });
});
