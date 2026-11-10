import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeShape,
  compareShape,
  formatReport,
  updateBaseline,
  type ShapeActual,
  type ShapeBaseline,
} from '../../../scripts/check-shape.js';

/**
 * 临时目录 fixture：超限文件、未超限文件、超长函数、禁用指令、any 各一份，
 * 外加一个 500 行的 `tests/` 文件，用来确认作用域只在 `src/`。
 *
 * 断言的是判定口径，不依赖真实仓库里的具体数字（那里随时在变）。
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'comem-shape-'));

function write(relativePath: string, content: string): void {
  const fullPath = join(FIXTURE_ROOT, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function fillLines(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `export const value${String(index)} = ${String(index)};`)
    .join('\n')
    .concat('\n');
}

let measured: ShapeActual;

beforeAll(() => {
  // 255 行的文件：不在基线里 → 上限 250，必须报超限。
  write('src/over-limit.ts', fillLines(255));
  write('src/small.ts', 'export const small = 1;\n');
  // 函数体 130 行 > 120：进超长函数计数。
  write(
    'src/long-function.ts',
    [
      'export function longFunction(): number {',
      ...Array.from({ length: 128 }, (_, index) => `  const step${String(index)} = ${String(index)};`),
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  );
  // 禁用指令三类各一处；`as any` / `: any` 各一处，另有注释与字符串里的同形文本（不计数）。
  write(
    'src/forbidden.ts',
    [
      '// @ts-ignore',
      'export const a = 1;',
      '// @ts-expect-error',
      'export const b = 2;',
      '/* eslint-disable */',
      'export const c = 3;',
      'declare const raw: unknown;',
      'export const asserted = raw as any;',
      'export const annotated: any = 1;',
      "export const text = 'as any';",
      '// as any 与 : any 出现在注释里不算。',
      '',
    ].join('\n'),
  );
  // tests/ 不在作用域内：500 行也不能影响 src 口径。
  write('tests/huge.test.ts', fillLines(500));
  measured = analyzeShape(FIXTURE_ROOT);
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function fileLinesOf(actual: ShapeActual, file: string): number | undefined {
  return actual.files.find((record) => record.file === file)?.lines;
}

function baselineOf(overrides: Partial<ShapeBaseline> = {}): ShapeBaseline {
  return {
    files: {},
    functionsOver120: 0,
    srcLines: 0,
    asAny: 0,
    typeAny: 0,
    ...overrides,
  };
}

function actualOf(overrides: Partial<ShapeActual> = {}): ShapeActual {
  return {
    files: [],
    functions: [],
    directives: [],
    anyOccurrences: [],
    srcLines: 0,
    ...overrides,
  };
}

describe('check-shape 测量口径', () => {
  it('文件行数按 wc -l 计（含空行与注释），作用域只有 src/', () => {
    expect(fileLinesOf(measured, 'src/over-limit.ts')).toBe(255);
    expect(fileLinesOf(measured, 'src/small.ts')).toBe(1);
    expect(measured.files.some((record) => record.file.startsWith('tests/'))).toBe(false);
    expect(measured.srcLines).toBe(255 + 1 + 131 + 11);
  });

  it('函数体行数 > 120 的函数被计数，名称与行号可用', () => {
    expect(measured.functions).toHaveLength(1);
    expect(measured.functions[0]?.file).toBe('src/long-function.ts');
    expect(measured.functions[0]?.name).toBe('longFunction');
    expect(measured.functions[0]?.lines).toBeGreaterThan(120);
  });

  it('禁用指令三类都命中，且行号指向声明所在行', () => {
    const kinds = measured.directives.map((hit) => `${hit.kind}@${String(hit.line)}`);
    expect(kinds).toEqual(['@ts-ignore@1', '@ts-expect-error@3', 'eslint-disable@5']);
  });

  it('as any / : any 只数代码里的形态，注释与字符串不算', () => {
    expect(measured.anyOccurrences.map((occurrence) => occurrence.kind).sort()).toEqual([
      ': any',
      'as any',
    ]);
  });
});

describe('check-shape 判定', () => {
  it('不在基线里的文件超过 250 行就失败', () => {
    const actual = actualOf({ files: [{ file: 'src/over-limit.ts', lines: 255 }], srcLines: 255 });
    const evaluation = compareShape(actual, baselineOf());
    expect(evaluation.fileViolations).toEqual([
      { file: 'src/over-limit.ts', actual: 255, limit: 250 },
    ]);
  });

  it('在基线记录值以内就通过，恰好等于也不报', () => {
    const actual = actualOf({ files: [{ file: 'src/over-limit.ts', lines: 300 }], srcLines: 300 });
    const evaluation = compareShape(actual, baselineOf({ files: { 'src/over-limit.ts': 300 } }));
    expect(evaluation.fileViolations).toEqual([]);
    expect(evaluation.fileTightenings).toEqual([]);
    expect(evaluation.next.files).toEqual({ 'src/over-limit.ts': 300 });
  });

  it('超过基线记录值就失败，上限取记录值', () => {
    const actual = actualOf({ files: [{ file: 'src/over-limit.ts', lines: 301 }], srcLines: 301 });
    const evaluation = compareShape(actual, baselineOf({ files: { 'src/over-limit.ts': 300 } }));
    expect(evaluation.fileViolations).toEqual([
      { file: 'src/over-limit.ts', actual: 301, limit: 300 },
    ]);
  });

  it('基线记录值下降时提示收紧（仍超 250）', () => {
    const actual = actualOf({ files: [{ file: 'src/over-limit.ts', lines: 260 }], srcLines: 260 });
    const evaluation = compareShape(actual, baselineOf({ files: { 'src/over-limit.ts': 300 } }));
    expect(evaluation.fileViolations).toEqual([]);
    expect(evaluation.fileTightenings).toEqual([
      { file: 'src/over-limit.ts', from: 300, to: 260 },
    ]);
    expect(evaluation.next.files).toEqual({ 'src/over-limit.ts': 260 });
  });

  it('文件回到 250 行以内时提示删除条目，文件被删除同理', () => {
    const shrunk = compareShape(
      actualOf({ files: [{ file: 'src/over-limit.ts', lines: 240 }], srcLines: 240 }),
      baselineOf({ files: { 'src/over-limit.ts': 300 } }),
    );
    expect(shrunk.fileTightenings).toEqual([{ file: 'src/over-limit.ts', from: 300, to: null }]);
    expect(shrunk.next.files).toEqual({});

    const removed = compareShape(actualOf(), baselineOf({ files: { 'src/gone.ts': 400 } }));
    expect(removed.fileTightenings).toEqual([{ file: 'src/gone.ts', from: 400, to: null }]);
  });

  it('单数字指标：多了失败、少了提示收紧、持平通过', () => {
    const base = baselineOf({ functionsOver120: 18, srcLines: 50000 });

    const over = compareShape(
      actualOf({
        srcLines: 50100,
        functions: Array.from({ length: 19 }, () => ({
          file: 'src/x.ts',
          line: 1,
          name: 'f',
          lines: 130,
        })),
      }),
      base,
    );
    // srcLines 只打印、不判失败：模块化会合法地增加 import 与签名的行数。
    expect(over.metricViolations.map((item) => item.key)).toEqual(['functionsOver120']);

    const under = compareShape(actualOf({ srcLines: 49000 }), base);
    expect(under.metricViolations).toEqual([]);
    expect(under.metricTightenings.map((item) => item.key)).toEqual(['functionsOver120']);
    expect(under.next.srcLines).toBe(49000);
    expect(under.next.functionsOver120).toBe(0);
  });

  it('禁用指令不参与基线：出现即由调用方判失败（比较器只做 ratchet）', () => {
    // 比较器不吞掉禁用指令，报告里单独计数；这里确认它没有被当成基线项。
    const actual = actualOf({
      directives: [{ file: 'src/x.ts', line: 1, kind: '@ts-ignore' }],
    });
    const evaluation = compareShape(actual, baselineOf());
    expect(evaluation.metricViolations).toEqual([]);
    expect(actual.directives).toHaveLength(1);
  });
});

describe('check-shape 输出格式', () => {
  it('失败行是 `文件:行 指标 实际值 上限`，最后一行给总数', () => {
    const actual = actualOf({ files: [{ file: 'src/big.ts', lines: 300 }], srcLines: 300 });
    const baseline = baselineOf({ srcLines: 100 });
    const report = formatReport(actual, baseline, compareShape(actual, baseline));
    expect(report).toContain('src/big.ts:1  行数  300  250');
    expect(report).toContain('src/:1  总行数  300  100');
    const lines = report.trimEnd().split('\n');
    expect(lines.at(-1)?.startsWith('总计：')).toBe(true);
    expect(lines.at(-1)).toContain('✗ 失败');
  });

  it('全部在基线内时只给通过结论，不列通过行', () => {
    const actual = actualOf({ files: [{ file: 'src/big.ts', lines: 300 }], srcLines: 300 });
    const baseline = baselineOf({ files: { 'src/big.ts': 300 }, srcLines: 300 });
    const report = formatReport(actual, baseline, compareShape(actual, baseline));
    expect(report).not.toContain('src/big.ts:1');
    expect(report.trimEnd().split('\n').at(-1)).toContain('✓ 通过');
  });
});

describe('check-shape 基线写入', () => {
  const baselinePath = join(FIXTURE_ROOT, 'scripts', 'shape-baseline.json');

  function writeBaselineFile(body: unknown): void {
    mkdirSync(join(FIXTURE_ROOT, 'scripts'), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`);
  }

  function readBaselineFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
  }

  it('基线不存在时按当前测量创建，只记录超过 250 行的文件', () => {
    rmSync(baselinePath, { force: true });
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({
        files: [
          { file: 'src/big.ts', lines: 300 },
          { file: 'src/small.ts', lines: 100 },
        ],
        srcLines: 400,
        functions: [{ file: 'src/big.ts', line: 1, name: 'f', lines: 130 }],
      }),
      null,
    );
    expect(result.status).toBe('created');
    expect(readBaselineFile()).toEqual({
      functionsOver120: 1,
      srcLines: 400,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 300,
    });
  });

  it('文件变大时拒绝写入（exit 2 的判定），基线文件保持原样', () => {
    writeBaselineFile({
      functionsOver120: 1,
      srcLines: 400,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 300,
    });
    const before = readFileSync(baselinePath, 'utf8');
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({
        files: [{ file: 'src/big.ts', lines: 320 }],
        srcLines: 320,
        functions: [{ file: 'src/big.ts', line: 1, name: 'f', lines: 130 }],
      }),
      {
        files: { 'src/big.ts': 300 },
        functionsOver120: 1,
        srcLines: 400,
        asAny: 0,
        typeAny: 0,
      },
    );
    expect(result.status).toBe('refused');
    expect(result.refusals.join('\n')).toContain('只能收紧');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });

  it('基线存在后，新的超限文件也不能靠更新基线进来', () => {
    writeBaselineFile({
      functionsOver120: 0,
      srcLines: 300,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 300,
    });
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({
        files: [
          { file: 'src/big.ts', lines: 300 },
          { file: 'src/new-large.ts', lines: 260 },
        ],
        srcLines: 560,
      }),
      {
        files: { 'src/big.ts': 300 },
        functionsOver120: 0,
        srcLines: 300,
        asAny: 0,
        typeAny: 0,
      },
    );
    expect(result.status).toBe('refused');
    expect(result.refusals.join('\n')).toContain('src/new-large.ts');
  });

  it('数值下降时写入收紧后的基线', () => {
    writeBaselineFile({
      functionsOver120: 2,
      srcLines: 500,
      asAny: 1,
      typeAny: 1,
      'src/big.ts': 300,
    });
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({
        files: [
          { file: 'src/big.ts', lines: 260 },
          { file: 'src/small.ts', lines: 100 },
        ],
        srcLines: 360,
      }),
      {
        files: { 'src/big.ts': 300 },
        functionsOver120: 2,
        srcLines: 500,
        asAny: 1,
        typeAny: 1,
      },
    );
    expect(result.status).toBe('tightened');
    expect(result.changes.length).toBeGreaterThan(0);
    expect(readBaselineFile()).toEqual({
      functionsOver120: 0,
      srcLines: 360,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 260,
    });
  });

  it('树里还有禁用指令时，更新基线也拒绝', () => {
    writeBaselineFile({
      functionsOver120: 0,
      srcLines: 300,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 300,
    });
    const before = readFileSync(baselinePath, 'utf8');
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({
        files: [{ file: 'src/big.ts', lines: 300 }],
        srcLines: 300,
        directives: [{ file: 'src/big.ts', line: 2, kind: 'eslint-disable' }],
      }),
      {
        files: { 'src/big.ts': 300 },
        functionsOver120: 0,
        srcLines: 300,
        asAny: 0,
        typeAny: 0,
      },
    );
    expect(result.status).toBe('refused');
    expect(result.refusals.join('\n')).toContain('禁用指令必须为 0');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });

  it('没有变化时不改写文件', () => {
    writeBaselineFile({
      functionsOver120: 0,
      srcLines: 300,
      asAny: 0,
      typeAny: 0,
      'src/big.ts': 300,
    });
    const before = readFileSync(baselinePath, 'utf8');
    const result = updateBaseline(
      FIXTURE_ROOT,
      actualOf({ files: [{ file: 'src/big.ts', lines: 300 }], srcLines: 300 }),
      {
        files: { 'src/big.ts': 300 },
        functionsOver120: 0,
        srcLines: 300,
        asAny: 0,
        typeAny: 0,
      },
    );
    expect(result.status).toBe('unchanged');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });
});
