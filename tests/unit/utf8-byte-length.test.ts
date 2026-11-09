/**
 * 两份 UTF-8 字节数实现的对齐保证。
 *
 * `domain/node.ts` 手写 UTF-8 区间计数，`services/resource.ts` 用
 * `Buffer.byteLength`。**不合并**：domain 层被 lint 禁止 import `node:*`，不能直接
 * 用 `Buffer`，只能复制一份。这与 `domain/identity.ts` 的 `URI_RESERVED_NAMES` 与
 * `adapters/fs/path.ts` 的 `RESERVED_NAMES` 是同一个范式——domain 不能依赖另一层，
 * 两边各写一份，靠测试对同一组语料断言结果相同。
 *
 * **这个测试是唯一的对齐保证**：改任一侧的计数区间而没改另一侧，这里会红。
 *
 * 语料包含最容易分叉的区间：ASCII、CJK、4 字节 emoji、代理对边界、超出 BMP、
 * 组合字符、空串，以及孤立代理项。孤立代理项那一行值得单独说明：`Buffer.byteLength`
 * 按 UTF-8 编码规则把它替换成 U+FFFD（3 字节），手写版按码点区间 `0x800..0xFFFF`
 * 算 3 字节——两条路径在这里恰好相同，不是巧合被绕过，而是「替换后的字节数」与
 * 「按码点区间算的字节数」对孤立代理项都等于 3。
 */

import { describe, expect, it } from 'vitest';

import { Document } from '../../src/domain/node.js';
import { Uri } from '../../src/domain/uri.js';
import { utf8ByteLength as bufferByteLength } from '../../src/services/resource.js';

const NOW = '2026-11-10T00:00:00.000Z';

/** `code` 是两边都必须给出的字节数（按实际写入磁盘的 UTF-8 编码）。 */
const CORPUS: readonly (readonly [name: string, text: string, code: number])[] = [
  ['纯 ASCII', 'hello', 5],
  ['CJK', '中文正文', 12],
  ['emoji（4 字节）', '😀🚀', 8],
  ['代理对边界', 'a😀b', 6],
  ['超出 BMP', '𠮷𝄞', 8],
  ['组合字符', 'e\u0301ñ', 5],
  ['空串', '', 0],
  ['孤立高代理项', '\uD800', 3],
  ['孤立低代理项', '\uDC00', 3],
  ['孤立代理项混在文本里', 'a\uD800b', 5],
];

function domainByteLength(text: string): number {
  // `utf8ByteLength` 是 domain 的私有函数，公开出口是 `Document.size`。
  return new Document({
    uri: Uri.parse('comem://user/alice/x'),
    content: text,
    updatedAt: NOW,
  }).size();
}

describe('utf8ByteLength：domain 手写版与 service 的 Buffer 版', () => {
  it.each(CORPUS)('%s：两边与磁盘字节数都相同', (_name, text, expected) => {
    // 磁盘上实际写入的编码（`fs.writeFile` 的 utf8 路径对孤立代理项写 U+FFFD）。
    const onDisk = Buffer.from(text, 'utf8').byteLength;

    expect(onDisk).toBe(expected);
    expect(domainByteLength(text)).toBe(expected);
    expect(bufferByteLength(text)).toBe(expected);
    expect(domainByteLength(text)).toBe(bufferByteLength(text));
  });

  it('孤立代理项写盘时变成 U+FFFD，手写版给出的 3 字节与之相符', () => {
    // 这是「本文档唯一的差异疑似点」的证据：两者都没有更严格，也没有更宽松。
    expect(Buffer.from('\uD800', 'utf8').toString('hex')).toBe('efbfbd');
    expect(domainByteLength('\uD800')).toBe(3);
    expect(bufferByteLength('\uD800')).toBe(3);
  });
});
