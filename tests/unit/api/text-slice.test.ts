/**
 * `api/text-slice.ts` 的码点分页语义。
 *
 * 这个函数同时服务 MCP `read` 与 HTTP `GET /content/read`。这里把两个入口共同依赖
 * 的边界钉死：`limit = -1` 读到末尾、`limit = 0` 返回空串、`offset` 越界返回空串、
 * 代理对被整体对待（不会从中间断开）、孤立代理项原样保留。
 *
 * 两个入口是否真的共用这份实现，由 `tests/integration/api/mcp-http-parity.test.ts`
 * 的「read 的分页语义」断言——只锁函数本身挡不住某个入口又抄一份。
 */

import { describe, expect, it } from 'vitest';

import { sliceText } from '../../../src/api/text-slice.js';

/** 5 个码点：ASCII / 4 字节 emoji（代理对）/ ASCII / 超出 BMP / ASCII。 */
const MIXED = 'a😀b𠮷c';

describe('sliceText', () => {
  it('limit = -1 读到末尾，offset = 0 时全文原样返回', () => {
    expect(sliceText(MIXED, 0, -1)).toBe(MIXED);
    expect(sliceText('', 0, -1)).toBe('');
  });

  it('limit = 0 返回空串，不论 offset 在哪', () => {
    expect(sliceText(MIXED, 0, 0)).toBe('');
    expect(sliceText(MIXED, 3, 0)).toBe('');
  });

  it('offset / limit 都是码点下标，代理对不会被切开', () => {
    // UTF-16 码元下 😀 占 2 位；按码点切 offset=1 就是整个 emoji。
    expect(sliceText(MIXED, 1, 1)).toBe('😀');
    expect(sliceText('😀', 0, 1)).toBe('😀');
    expect(sliceText(MIXED, 0, 2)).toBe('a😀');
    expect(sliceText(MIXED, 2, 2)).toBe('b𠮷');
    expect(sliceText(MIXED, 4, -1)).toBe('c');
  });

  it('中文按码点切，不会按 UTF-16 或字节切', () => {
    expect(sliceText('中文内容😀', 0, 3)).toBe('中文内');
    expect(sliceText('中文内容😀', 2, -1)).toBe('内容😀');
  });

  it('offset 越界或 limit 超过剩余长度都不会报错', () => {
    expect(sliceText(MIXED, 5, 3)).toBe('');
    expect(sliceText(MIXED, 99, -1)).toBe('');
    expect(sliceText(MIXED, 3, 99)).toBe('𠮷c');
  });

  it('孤立代理项按一个码点切片并原样保留', () => {
    // 与 `Buffer` 的差别只影响「字节数」的推导，不影响切片：`[...text]` 把它当成
    // 一个码点，不替换、不拆开。
    expect(sliceText('a\uD800b', 1, 1)).toBe('\uD800');
    expect(sliceText('a\uD800b', 0, -1)).toBe('a\uD800b');
  });
});
