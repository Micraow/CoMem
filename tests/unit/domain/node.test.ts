import { describe, expect, it } from 'vitest';

import { stableDigest } from '../../../src/domain/node.js';

describe('stableDigest', () => {
  it('相同输入得到相同输出', () => {
    expect(stableDigest('用户偏好 TypeScript 严格模式')).toBe(
      stableDigest('用户偏好 TypeScript 严格模式'),
    );
  });

  it('不同输入得到不同输出', () => {
    expect(stableDigest('alpha')).not.toBe(stableDigest('beta'));
    expect(stableDigest('alpha')).not.toBe(stableDigest('alpha '));
  });

  it('空串也有值，且是定长十六进制', () => {
    const digest = stableDigest('');

    expect(digest).not.toBe('');
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('emoji 与组合字符可区分', () => {
    expect(stableDigest('😀')).not.toBe(stableDigest('😁'));
    expect(stableDigest('e\u0301')).not.toBe(stableDigest('\u00e9'));
  });
});
