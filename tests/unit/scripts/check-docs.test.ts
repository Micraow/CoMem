import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeDocs,
  claimedSymbolAt,
  declaredNames,
  formatReport,
  type DocsAnalysis,
  type ReferenceCheck,
} from '../../../scripts/check-docs.js';

/**
 * 临时目录 fixture：每条判定各一条文档行。
 *
 * 断言的是判定口径，不依赖真实仓库里的具体文件。
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'comem-docs-'));

function write(relativePath: string, content: string): void {
  const fullPath = join(FIXTURE_ROOT, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

/** 文档行：每个引用一行，方便按 `docLine` 断言。 */
const DOC_LINES = [
  '符号在后：`src/pass.ts` `alpha`', // 1
  '符号在前：`beta`（`src/pass.ts`）', // 2
  '符号不存在：`src/other.ts` `alpha`', // 3
  '带目录路径缺失：`src/missing/file.ts`', // 4
  '带目录路径歧义：`services/session/archive.ts`', // 5
  '裸文件名多候选：`shared.ts`', // 6
  '无符号引用：`src/pass.ts`', // 7
  '语言词相邻：`src/pass.ts` `true`', // 8
  'Vue 符号：`web/pages/thing.vue` `load`', // 9
  'Vue 符号不存在：`web/pages/thing.vue` `nope`', // 10
  '裸文件名符号命中任一候选：`shared.ts` `two`', // 11
  '裸文件名符号不存在：`shared.ts` `zzz`', // 12
  '不在反引号里的路径不算引用：src/pass.ts', // 13
];

beforeAll(() => {
  write('docs/a.md', `${DOC_LINES.join('\n')}\n`);

  write('src/pass.ts', ['export const alpha = 1;', 'export function beta(): void', ''].join('\n'));
  write('src/other.ts', ['export const gamma = 1;', ''].join('\n'));
  write('src/dup/one/shared.ts', ['export const one = 1;', ''].join('\n'));
  write('src/dup/two/shared.ts', ['export const two = 1;', ''].join('\n'));
  write('src/dup/one/services/session/archive.ts', ['export const first = 1;', ''].join('\n'));
  write('src/dup/two/services/session/archive.ts', ['export const second = 1;', ''].join('\n'));
  write(
    'web/pages/thing.vue',
    ['<script setup lang="ts">', 'const count = 1', 'async function load(): Promise<void>', '</script>', ''].join(
      '\n',
    ),
  );
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

let measured: DocsAnalysis;

beforeAll(() => {
  measured = analyzeDocs(FIXTURE_ROOT);
});

function resultAt(analysis: DocsAnalysis, docLine: number): ReferenceCheck {
  const found = analysis.references.find((reference) => reference.docLine === docLine);
  if (found === undefined) {
    throw new Error(`文档第 ${String(docLine)} 行没有检查结果`);
  }
  return found;
}

describe('check-docs 路径判定', () => {
  it('带目录的路径唯一命中时通过', () => {
    const reference = resultAt(measured, 1);
    expect(reference.status).toBe('pass');
    expect(reference.failure).toBeNull();
    expect(reference.resolvedPath).toBe('src/pass.ts');
  });

  it('带目录的路径不存在时失败', () => {
    const missing = resultAt(measured, 4);
    expect(missing.status).toBe('fail');
    expect(missing.failure).toBe('path-missing');
    expect(missing.resolvedPath).toBeNull();
    expect(missing.candidates).toEqual([]);
  });

  it('带目录的路径命中多个文件时失败并列出候选', () => {
    const ambiguous = resultAt(measured, 5);
    expect(ambiguous.status).toBe('fail');
    expect(ambiguous.failure).toBe('path-ambiguous');
    expect(ambiguous.resolvedPath).toBeNull();
    expect([...ambiguous.candidates].sort()).toEqual([
      'src/dup/one/services/session/archive.ts',
      'src/dup/two/services/session/archive.ts',
    ]);
  });

  it('只有文件名的引用命中多个文件不算失败', () => {
    const bare = resultAt(measured, 6);
    expect(bare.status).toBe('pass');
    expect(bare.failure).toBeNull();
    expect(bare.resolvedPath).toBeNull();
    expect([...bare.candidates].sort()).toEqual(['src/dup/one/shared.ts', 'src/dup/two/shared.ts']);
  });
});

describe('check-docs 符号判定', () => {
  it('引用之后的符号在该文件里有声明就通过', () => {
    const reference = resultAt(measured, 1);
    expect(reference.claimedSymbol).toBe('alpha');
    expect(reference.failure).toBeNull();
  });

  it('引用之前隔着「的」的符号也算紧邻', () => {
    const reference = resultAt(measured, 2);
    expect(reference.status).toBe('pass');
    expect(reference.claimedSymbol).toBe('beta');
  });

  it('符号在解析到的文件里没有声明时失败', () => {
    const missing = resultAt(measured, 3);
    expect(missing.status).toBe('fail');
    expect(missing.failure).toBe('symbol-missing');
    expect(missing.claimedSymbol).toBe('alpha');
    expect(missing.resolvedPath).toBe('src/other.ts');
  });

  it('没有符号的引用只查路径，算通过', () => {
    const pathOnly = resultAt(measured, 7);
    expect(pathOnly.status).toBe('pass');
    expect(pathOnly.claimedSymbol).toBeNull();
    expect(pathOnly.failure).toBeNull();
  });

  it('紧邻的语言词视同没有符号', () => {
    const languageWord = resultAt(measured, 8);
    expect(languageWord.status).toBe('pass');
    expect(languageWord.claimedSymbol).toBeNull();
    expect(languageWord.failure).toBeNull();
  });

  it('只有文件名的引用命中多个文件时，任一文件有声明即通过', () => {
    const reference = resultAt(measured, 11);
    expect(reference.status).toBe('pass');
    expect(reference.claimedSymbol).toBe('two');
  });

  it('只有文件名的引用在多候选里都找不到符号时失败', () => {
    const missing = resultAt(measured, 12);
    expect(missing.status).toBe('fail');
    expect(missing.failure).toBe('symbol-missing');
    expect(missing.claimedSymbol).toBe('zzz');
  });

  it('.vue 用正则取声明', () => {
    const vue = resultAt(measured, 9);
    expect(vue.status).toBe('pass');
    expect(vue.claimedSymbol).toBe('load');
    expect(vue.resolvedPath).toBe('web/pages/thing.vue');

    const absent = resultAt(measured, 10);
    expect(absent.status).toBe('fail');
    expect(absent.failure).toBe('symbol-missing');
  });
});

describe('check-docs 统计', () => {
  it('通过 / 失败两类相加等于检查总数，且只统计反引号里的引用', () => {
    expect(measured.total).toBe(DOC_LINES.length - 1);
    expect(measured.passed).toBe(7);
    expect(measured.failed).toBe(5);
    expect(measured.passed + measured.failed).toBe(measured.total);
    expect(measured.perDoc).toHaveLength(1);
    expect(measured.perDoc[0]?.failed).toBe(5);
  });
});

describe('check-docs 输出格式', () => {
  it('失败行是 `文档:行 路径 原因`，按文件分组，末尾给统计', () => {
    const report = formatReport(measured);
    expect(report).toContain('docs/a.md:3  src/other.ts  声称 alpha，src/other.ts 里没有声明');
    expect(report).toContain('docs/a.md:4  src/missing/file.ts  路径不存在');
    expect(report).toContain('docs/a.md:5  services/session/archive.ts  路径不唯一：');
    expect(report).toContain('docs/a.md:12  shared.ts  声称 zzz，候选文件（');
    expect(report).not.toContain('docs/a.md:1 ');
    expect(report).not.toContain('docs/a.md:7 ');
    expect(report.trimEnd().split('\n').at(-1)).toContain('统计：检查 12 处，通过 7，失败 5');
    expect(report.trimEnd().split('\n').at(-1)).toContain('✗ 失败 5 项');
  });
});

describe('check-docs 声称符号的取法', () => {
  it('引用之后的标识符优先', () => {
    const line = '引用 `src/a.ts` `alpha` 在这里';
    const start = line.indexOf('src/a.ts');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts'.length)).toBe('alpha');
  });

  it('引用之前隔着「的」也算紧邻', () => {
    const line = '默认引擎（`src/a.ts` 的 `engine` 默认值）';
    const start = line.indexOf('src/a.ts');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts'.length)).toBe('engine');
  });

  it('引用之前隔着句读不取，避免把上一句的符号算进来', () => {
    const line = '写 `recordHits`；`src/a.ts`';
    const start = line.indexOf('src/a.ts');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts'.length)).toBeNull();
  });

  it('紧邻的语言词不算符号', () => {
    const line = '字面量 `src/a.ts` `undefined`';
    const start = line.indexOf('src/a.ts');
    expect(claimedSymbolAt(line, start, start + 'src/a.ts'.length)).toBeNull();
  });
});

describe('check-docs 声明口径', () => {
  it('TS 语法树取函数、类、接口、类型别名、变量、枚举与枚举成员', () => {
    const names = declaredNames(
      'src/thing.ts',
      [
        'export function fn(): void {}',
        'export class Klass {}',
        'export interface Shape {}',
        'export type Alias = string;',
        'export enum Color { Red }',
        'export const constant = 1;',
        'let mutable = 2;',
      ].join('\n'),
    );
    for (const name of ['fn', 'Klass', 'Shape', 'Alias', 'Color', 'Red', 'constant', 'mutable']) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('方法、getter / setter 也算声明', () => {
    const names = declaredNames(
      'src/thing.ts',
      ['export class Holder {', '  get value(): number { return 1; }', '  run(): void {}', '}'].join('\n'),
    );
    expect(names.has('value')).toBe(true);
    expect(names.has('run')).toBe(true);
  });
});
