/**
 * 稳定消息 ID 的公式锁死（架构文档 §11.9、§15.4）。
 *
 * `archivedMessageIds` 是落盘的：ID 一旦漂移，升级前归档过的消息在升级后就认不出来，
 * 重投会重复追加。所以这里用固定输入 + 固定摘要锁住「角色 NUL 正文 NUL 时间戳 的
 * sha256 十六进制」，改公式必须同时想清楚已落盘归档怎么办。
 *
 * **公式只有一份**：`stableMessageId`（`services/session.ts`）是唯一实现，
 * `remember`（`api/mcp/tools/remember.ts`）与 `ingest`（`services/ingest.ts`）都
 * import 它。跨路径的行为等价（`remember` 落盘的 ID 就是它，且能命中按它算出的
 * 已存在 ID）在 `tests/integration/mcp/tools.test.ts` 里验证；本文件另外加一条
 * 结构性断言，防止 `remember.ts` 再长出第二份公式。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { stableMessageId } from '../../../src/services/session.js';

const REMEMBER_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/api/mcp/tools/remember.ts'),
  'utf8',
);

describe('stableMessageId', () => {
  it('公式不变：sha256(role + \\0 + text + \\0 + createdAt) 的十六进制', () => {
    expect(stableMessageId('user', 'hello', '2026-11-08T00:00:00.000Z')).toBe(
      'b524dcf734ba6064fe3e7261785142876b8ea19661264f6351c91726bce3f1ef',
    );
  });

  it('NUL 分隔符让字段拼接不产生歧义', () => {
    expect(stableMessageId('user', 'ab', 'c')).not.toBe(stableMessageId('user', 'a', 'bc'));
  });

  it('角色、正文、时间戳任一变化都会得到不同的 ID', () => {
    const base = stableMessageId('user', '同一句', '2026-11-08T00:00:00.000Z');
    expect(stableMessageId('assistant', '同一句', '2026-11-08T00:00:00.000Z')).not.toBe(base);
    expect(stableMessageId('user', '另一句', '2026-11-08T00:00:00.000Z')).not.toBe(base);
    expect(stableMessageId('user', '同一句', '2026-11-08T00:00:01.000Z')).not.toBe(base);
  });
});

describe('公式只有一份', () => {
  it('remember.ts 不再自己拼接 sha256，也不自带分隔符常量', () => {
    // `createHash` 是第二份实现的入口；sha256 字符串出现在注释里也值得改注释，
    // 所以两者一起挡。
    expect(REMEMBER_SOURCE).not.toMatch(/createHash|sha256/u);
    // NUL：既挡源码里的真实 NUL 字节，也挡 `'\u0000'` 这种转义写法。
    expect(REMEMBER_SOURCE).not.toContain('\u0000');
    expect(REMEMBER_SOURCE).not.toMatch(/\\u0000/u);
  });

  it('remember.ts 从服务端那份实现 import', () => {
    expect(REMEMBER_SOURCE).toContain(
      "import { stableMessageId } from '../../../services/session.js';",
    );
    expect(REMEMBER_SOURCE).toContain('stableMessageId(role, text, createdAt)');
  });
});
