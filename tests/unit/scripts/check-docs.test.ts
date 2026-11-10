import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeDocs,
  claimedSymbolAt,
  countLines,
  formatReport,
  type DocsAnalysis,
  type ReferenceCheck,
} from '../../../scripts/check-docs.js';

/**
 * 临时目录 fixture：每条判定各一条文档行。
 *
 * 断言的是判定口径，不依赖真实仓库里的具体文件与行号。
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'comem-docs-'));

function write(relativePath: string, content: string): void {
  const fullPath = join(FIXTURE_ROOT, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

/** 文档行：每个引用一行，方便按 `docLine` 断言。 */
const DOC_LINES = [
  '符号对得上：`src/pass.ts:1` `alpha`', // 1
  '符号对得上（函数）：`src/pass.ts:2` `beta`', // 2
  '符号对不上：`src/mismatch.ts:1` `beta`', // 3
  '路径不存在：`src/missing.ts:1`', // 4
  '行号越界：`src/short.ts:9`', // 5
  '没有紧邻标识符：只有引用 `src/pass.ts:1`', // 6
  '非符号词：`src/pass.ts:1` `true`', // 7
  '路径不唯一：`shared.ts:1`', // 8
  'Vue 的 async function：`web/pages/thing.vue:3` `load`', // 9
  '窗口内命中的声明：`src/window.ts:5` `offsetName`', // 10
  '窗口外的声明：`src/window.ts:5` `farName`', // 11
];

beforeAll(() => {
  write('docs/a.md', `${DOC_LINES.join('\n')}\n`);

  write(
    'src/pass.ts',
    ['export const alpha = 1;', 'export function beta(): void', ''].join('\n'),
  );
  write('src/mismatch.ts', ['export const gamma = 1;', ''].join('\n'));
  write('src/short.ts', ['export const only = 1;', ''].join('\n'));
  write(
    'src/window.ts',
    [
      '// 1',
      '// 2',
      'export function offsetName(): void',
      '// 4',
      '// 5',
      '// 6',
      '// 7',
      '// 8',
      'export function farName(): void',
      '',
    ].join('\n'),
  );
  write('src/dup/one/shared.ts', ['export const one = 1;', ''].join('\n'));
  write('src/dup/two/shared.ts', ['export const two = 1;', ''].join('\n'));
  write(
    'web/pages/thing.vue',
    [
      '<script setup lang="ts">',
      'const count = 1',
      'async function load(): Promise<void>',
      '</script>',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

let measured: DocsAnalysis;

function resultAt(analysis: DocsAnalysis, docLine: number): ReferenceCheck {
  const found = analysis.references.find((reference) => reference.docLine === docLine);
  if (found === undefined) {
    throw new Error(`文档第 ${String(docLine)} 行没有检查结果`);
  }
  return found;
}

beforeAll(() => {
  measured = analyzeDocs(FIXTURE_ROOT);
});

describe('check-docs 判定', () => {
  it('路径存在且符号在目标行 ±2 行的声明里就通过', () => {
    const variable = resultAt(measured, 1);
    expect(variable.status).toBe('pass');
    expect(variable.resolvedPath).toBe('src/pass.ts');
    expect(variable.claimedSymbol).toBe('alpha');

    const fn = resultAt(measured, 2);
    expect(fn.status).toBe('pass');
    expect(fn.claimedSymbol).toBe('beta');
  });

  it('符号对不上时失败，并给出窗口内最近的声明', () => {
    const mismatch = resultAt(measured, 3);
    expect(mismatch.status).toBe('fail');
    expect(mismatch.failure).toBe('symbol-mismatch');
    expect(mismatch.claimedSymbol).toBe('beta');
    expect(mismatch.actual).toEqual({ name: 'gamma', line: 1 });
  });

  it('路径不存在失败（规则 1）', () => {
    const missing = resultAt(measured, 4);
    expect(missing.status).toBe('fail');
    expect(missing.failure).toBe('path-missing');
    expect(missing.resolvedPath).toBeNull();
  });

  it('行号越界失败（规则 2）', () => {
    const range = resultAt(measured, 5);
    expect(range.status).toBe('fail');
    expect(range.failure).toBe('line-out-of-range');
    expect(range.fileLines).toBe(1);
  });

  it('没有紧邻的反引号标识符时跳过第 3 条，只做 1、2', () => {
    const skip = resultAt(measured, 6);
    expect(skip.status).toBe('skip');
    expect(skip.skipReason).toBe('no-adjacent-symbol');
    expect(skip.claimedSymbol).toBeNull();
    expect(skip.failure).toBeNull();
  });

  it('紧邻的标识符是语言词时跳过第 3 条', () => {
    const skip = resultAt(measured, 7);
    expect(skip.status).toBe('skip');
    expect(skip.skipReason).toBe('non-symbol-token');
    expect(skip.claimedSymbol).toBeNull();
  });

  it('同一后缀解析到多个文件时失败，并列出候选（规则 1）', () => {
    const ambiguous = resultAt(measured, 8);
    expect(ambiguous.status).toBe('fail');
    expect(ambiguous.failure).toBe('path-ambiguous');
    expect(ambiguous.candidates).toEqual(['src/dup/one/shared.ts', 'src/dup/two/shared.ts']);
  });

  it('.vue 用正则取声明（async function 也算）', () => {
    const vue = resultAt(measured, 9);
    expect(vue.status).toBe('pass');
    expect(vue.claimedSymbol).toBe('load');
    expect(vue.resolvedPath).toBe('web/pages/thing.vue');
  });

  it('声明在目标行 ±2 行内算命中，超出窗口不算', () => {
    const inside = resultAt(measured, 10);
    expect(inside.status).toBe('pass');
    expect(inside.claimedSymbol).toBe('offsetName');
    expect(inside.actual).toEqual({ name: 'offsetName', line: 3 });

    const outside = resultAt(measured, 11);
    expect(outside.status).toBe('fail');
    expect(outside.claimedSymbol).toBe('farName');
    expect(outside.actual).toEqual({ name: 'offsetName', line: 3 });
  });

  it('统计：通过 / 失败 / 跳过三类相加等于检查总数', () => {
    expect(measured.total).toBe(DOC_LINES.length);
    expect(measured.passed).toBe(4);
    expect(measured.failed).toBe(5);
    expect(measured.skipped).toBe(2);
    expect(measured.passed + measured.failed + measured.skipped).toBe(measured.total);
    expect(measured.skipsByReason).toEqual({
      'no-adjacent-symbol': 1,
      'non-symbol-token': 1,
    });
  });
});

describe('check-docs 输出格式', () => {
  it('失败行是 `文档:行 路径:行号 声称 … → 实际 …`，按文件分组，末尾给统计', () => {
    const report = formatReport(measured);
    expect(report).toContain('docs/a.md:3  src/mismatch.ts:1  声称 beta → 实际 gamma（:1）');
    expect(report).toContain('docs/a.md:4  src/missing.ts:1  路径不存在');
    expect(report).toContain('docs/a.md:5  src/short.ts:9  行号越界（文件 1 行）');
    expect(report).toContain('docs/a.md:8  shared.ts:1  路径不唯一');
    expect(report).toContain('docs/a.md:11  src/window.ts:5  声称 farName → 实际 offsetName（:3）');
    expect(report).not.toContain('docs/a.md:1 ');
    expect(report).not.toContain('docs/a.md:6 ');
    expect(report.trimEnd().split('\n').at(-1)).toContain(
      '统计：检查 11 处，通过 4，失败 5，跳过 2',
    );
    expect(report.trimEnd().split('\n').at(-1)).toContain('✗ 失败 5 项');
  });
});

describe('check-docs 声称符号的取法', () => {
  it('引用之后的标识符优先', () => {
    const line = '引用 `src/a.ts:1` `alpha` 在这里';
    const start = line.indexOf('src/a.ts:1');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts:1'.length)).toEqual({
      symbol: 'alpha',
      skipReason: null,
    });
  });

  it('引用之前隔着「的」也算紧邻', () => {
    const line = '默认引擎（`src/a.ts:1` 的 `engine` 默认值）';
    const start = line.indexOf('src/a.ts:1');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts:1'.length)).toEqual({
      symbol: 'engine',
      skipReason: null,
    });
  });

  it('引用之前隔着句读不取，避免把上一句的符号算进来', () => {
    const line = '写 `recordHits`；`src/a.ts:1`';
    const start = line.indexOf('src/a.ts:1');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts:1'.length)).toEqual({
      symbol: null,
      skipReason: 'no-adjacent-symbol',
    });
  });
});

describe('check-docs 行数口径', () => {
  it('结尾有换行时不把空元素算成一行', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});
