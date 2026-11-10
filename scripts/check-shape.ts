/**
 * 形状检查：文件只能变短。
 *
 * ## 为什么需要它
 *
 * 这个仓库的结构问题不是某一处写错了，而是**只有加法、没有减法**：`search.ts` 涨到
 * 2163 行、`memory.ts` 涨到 1524 行，一个类有五个改变的理由，任何改动都落在五六个
 * 契约的交界处。拆一次能降下来，但没有任何检查拦着它涨回去——三个月后同一个文件会
 * 重新长到同样大小，而这次没人记得上次为什么拆。
 *
 * 本脚本把「只减不增」变成门禁，四项：
 *
 * | 项 | 口径 | 基线 |
 * |---|---|---|
 * | 单文件行数 | `wc -l`（含空行与注释），默认上限 250 | 每个超限文件记一个上限，只能降 |
 * | 超长函数 | 函数体行数 > 120 的个数 | 单个数字，只能降 |
 * | src 总行数 | `src/` 下全部 `.ts` 的 `wc -l` 合计 | 单个数字，只能降 |
 * | 禁用指令 / any | `@ts-ignore`、`@ts-expect-error`、`eslint-disable` 必须为 0；`as any`、`: any` 记数 | 两个数字，只能降 |
 *
 * 单文件上限存在的唯一理由是「存量已经超了」：把它们一次拆到 250 以下不在本检查的
 * 职责内。基线里每一项都是**上限 ratchet**，只能降；文件被拆小或删除时报告「基线可
 * 收紧」，但**不自动写文件**——检查是只读的，跑一次门禁不该弄脏工作区。收紧要显式跑
 * `--update-baseline`，它拒绝任何会让上限变大的写入（exit 2）。
 *
 * 没有文件级白名单：超限文件的例外只有基线里那一行数字，而它只能降。新文件一律按
 * 250 行判，**基线存在之后**，一个 260 行的新文件也不能靠 `--update-baseline` 进来。
 *
 * ## 阈值的来源
 *
 * 250 行与 120 行是本次门禁给定的口径，不是从数据里拟合出来的最优值，也没有证据说明
 * 跨过这两条线必然出问题。它们的作用是让「结构回涨」变成一次显式决定：已经超限的文件
 * 记下当前值，之后只能降；没超限的文件没有余量可借。阈值要调整就得同时改基线，
 * 那是一次能被人看见的改动。
 *
 * ## 判定
 *
 * - 文件在基线里 → 超过记录值即失败；不在基线里 → 超过 250 即失败。
 * - 超长函数 / src 总行数 / any 计数：当前 > 基线即失败，< 基线只提示可收紧。
 * - 禁用指令：任何一处即失败，没有基线与例外。
 *
 * ## 为什么不做「注释掉的代码」
 *
 * 这一项写不成可靠的静态检查。判据只能是「连续 3 行以上以 `//` 开头、看起来像代码」，
 * 而「看起来像代码」没有可执行的判据：ASCII 表格、被注释掉的路径清单、带 `=>` 的
 * 说明、`foo()` 形式的接口示例、模板字符串里被引用的代码片段，全都会命中；反过来
 * 被注释掉的真实代码块只要有一行不以 `//` 开头（块注释、缩进后接续上一行）就漏掉。
 * 一个高频误报的硬零项只会训练人绕过检查——而绕过的第一选择就是把整个文件加进白名单，
 * 这又违反「不许有文件级白名单」。宁可只做前三类能给出确定判据的检查。
 *
 * ## 抓不到的那一类（残余）
 *
 * - **文件行数不是职责划分**：把 1500 行拆成 6 个 250 行的文件，检查全绿，耦合没变。
 * - **函数长度可以绕过**：把 130 行拆成两个 65 行的私有方法加一串参数；超长表达式、
 *   超长类、超长 `switch` 不统计；注释与空行不计入函数体行数，所以可以往函数里堆注释。
 * - **any 只认两种写法**：`Array<any>`、`<any>x`、`Record<string, any>` 里的 `any` 不算
 *   进 `: any`；`as unknown as T` 与 `satisfies` 不在检查范围。
 * - **禁用指令只匹配文本**：`@ts-ignore` 出现在字符串里也会命中（硬零项，宁可多报）；
 *   反之 `@ts-expect-error` 的等价抑制手段（放宽 tsconfig、`// @ts-nocheck`）不在检查内。
 * - **src 总行数**：搬代码到 `tests/` 或 `scripts/` 就能让总数下降，检查看不出这是搬走
 *   还是删掉。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 作用域：只查生产源码。`tests/` 与 `scripts/` 的长短不反映结构失控。 */
const SRC_ROOT = 'src';
/** 单文件行数上限（`wc -l` 口径）。 */
export const FILE_LINE_LIMIT = 250;
/** 函数体行数上限。 */
export const FUNCTION_LINE_LIMIT = 120;
export const SHAPE_BASELINE_PATH = 'scripts/shape-baseline.json';

const METRIC_KEYS = ['functionsOver120', 'srcLines', 'asAny', 'typeAny'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  functionsOver120: '超长函数个数',
  srcLines: 'src 总行数',
  asAny: 'as any',
  typeAny: ': any',
};

export interface FileLineRecord {
  /** 相对仓库根的路径，如 `src/services/acl.ts`。 */
  readonly file: string;
  /** `wc -l`：正文里换行符的个数。 */
  readonly lines: number;
}

export interface LongFunction {
  readonly file: string;
  /** 1-based 行号，取函数声明的起始行。 */
  readonly line: number;
  readonly name: string;
  /** 函数体行数（含花括号），`end - start + 1`。 */
  readonly lines: number;
}

export type DirectiveKind = '@ts-ignore' | '@ts-expect-error' | 'eslint-disable';

export interface DirectiveHit {
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly kind: DirectiveKind;
}

export interface AnyOccurrence {
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly kind: 'as any' | ': any';
}

/** 一次测量结果。 */
export interface ShapeActual {
  readonly files: readonly FileLineRecord[];
  /** 函数体行数 > `FUNCTION_LINE_LIMIT` 的函数，按文件 / 行排序。 */
  readonly functions: readonly LongFunction[];
  readonly directives: readonly DirectiveHit[];
  readonly anyOccurrences: readonly AnyOccurrence[];
  readonly srcLines: number;
}

/** 可提交的基线：文件上限表 + 四个只降不升的数字。 */
export interface ShapeBaseline {
  readonly files: Readonly<Record<string, number>>;
  readonly functionsOver120: number;
  readonly srcLines: number;
  readonly asAny: number;
  readonly typeAny: number;
}

export interface FileViolation {
  readonly file: string;
  readonly actual: number;
  readonly limit: number;
}

export interface FileTightening {
  readonly file: string;
  readonly from: number;
  /** `null`：文件已回到 250 行以内，条目应从基线删除。 */
  readonly to: number | null;
}

export interface MetricViolation {
  readonly key: MetricKey;
  readonly actual: number;
  readonly limit: number;
}

export interface MetricTightening {
  readonly key: MetricKey;
  readonly from: number;
  readonly to: number;
}

export interface ShapeEvaluation {
  readonly fileViolations: readonly FileViolation[];
  readonly fileTightenings: readonly FileTightening[];
  readonly metricViolations: readonly MetricViolation[];
  readonly metricTightenings: readonly MetricTightening[];
  /** 收紧后的基线；`fileViolations` / `metricViolations` 非空时保持原值。 */
  readonly next: ShapeBaseline;
}

export interface BaselineUpdateResult {
  readonly status: 'created' | 'tightened' | 'unchanged' | 'refused';
  readonly changes: readonly string[];
  readonly refusals: readonly string[];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

/** `wc -l` 口径：数换行符，不数最后一行没有换行结尾的残留。 */
function countLines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function memberNameOf(node: ts.PropertyName | ts.PrivateIdentifier | ts.Expression): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return node.text;
  }
  return '<computed>';
}

/** 带块体的函数一律计数；返回 `undefined` 表示这个节点没有可测量的函数体。 */
function functionBodyOf(node: ts.Node): ts.Block | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    const body = node.body;
    return body !== undefined && ts.isBlock(body) ? body : undefined;
  }
  return undefined;
}

function functionNameOf(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text ?? '<default>';
  }
  if (ts.isMethodDeclaration(node)) {
    return memberNameOf(node.name);
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isGetAccessorDeclaration(node)) {
    return `get ${memberNameOf(node.name)}`;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    return `set ${memberNameOf(node.name)}`;
  }
  // 函数表达式 / 箭头函数：从最近的父节点取名字，取不到就是匿名。
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return memberNameOf(parent.name);
  }
  if (ts.isExportAssignment(parent)) {
    return '<default>';
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return '<callback>';
  }
  return '<anonymous>';
}

function collectLongFunctions(
  sourceFile: ts.SourceFile,
  file: string,
): LongFunction[] {
  const found: LongFunction[] = [];
  const visit = (node: ts.Node): void => {
    const body = functionBodyOf(node);
    if (body !== undefined) {
      const start = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile)).line;
      const end = sourceFile.getLineAndCharacterOfPosition(body.getEnd()).line;
      const lines = end - start + 1;
      if (lines > FUNCTION_LINE_LIMIT) {
        found.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          name: functionNameOf(node),
          lines,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const DIRECTIVE_PATTERNS: readonly { readonly kind: DirectiveKind; readonly pattern: RegExp }[] = [
  { kind: '@ts-ignore', pattern: /@ts-ignore\b/ },
  { kind: '@ts-expect-error', pattern: /@ts-expect-error\b/ },
  // 「任何形式」：`eslint-disable`、`eslint-disable-next-line`、`eslint-disable-line`。
  { kind: 'eslint-disable', pattern: /eslint-disable/ },
];

function collectDirectives(text: string, file: string): DirectiveHit[] {
  const hits: DirectiveHit[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const { kind, pattern } of DIRECTIVE_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ file, line: index + 1, kind });
      }
    }
  }
  return hits;
}

/**
 * `as any` 与 `: any` 的计数。
 *
 * 用扫描器而不是正则：注释与字符串里的 `as any` 不会被数进来（`skipTrivia` 丢注释、
 * 字符串是完整 token），跨行写法也能认。口径只认相邻的 `as`+`any` 与 `:`+`any` 两个
 * token，`Array<any>` / `<any>` 不算——那是另一种断言，不属于本项。
 */
function collectAnyOccurrences(sourceFile: ts.SourceFile, file: string): AnyOccurrence[] {
  const found: AnyOccurrence[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    sourceFile.text,
  );
  let previous: ts.SyntaxKind | null = null;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.AnyKeyword) {
      const kind =
        previous === ts.SyntaxKind.AsKeyword
          ? 'as any'
          : previous === ts.SyntaxKind.ColonToken
            ? ': any'
            : null;
      if (kind !== null) {
        const line = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1;
        found.push({ file, line, kind });
      }
    }
    previous = token;
  }
  return found;
}

/** 测量一个项目根（仓库根，或测试 fixture 根），不打印、不写文件。 */
export function analyzeShape(rootDir: string): ShapeActual {
  const srcDir = join(rootDir, SRC_ROOT);
  const files: FileLineRecord[] = [];
  const functions: LongFunction[] = [];
  const directives: DirectiveHit[] = [];
  const anyOccurrences: AnyOccurrence[] = [];
  let srcLines = 0;

  for (const file of collectSourceFiles(srcDir)) {
    const relativePath = relative(rootDir, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const lines = countLines(text);
    files.push({ file: relativePath, lines });
    srcLines += lines;

    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    functions.push(...collectLongFunctions(sourceFile, relativePath));
    directives.push(...collectDirectives(text, relativePath));
    anyOccurrences.push(...collectAnyOccurrences(sourceFile, relativePath));
  }

  functions.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  directives.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  anyOccurrences.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );

  return { files, functions, directives, anyOccurrences, srcLines };
}

function actualMetrics(actual: ShapeActual): Readonly<Record<MetricKey, number>> {
  return {
    functionsOver120: actual.functions.length,
    srcLines: actual.srcLines,
    asAny: actual.anyOccurrences.filter((occurrence) => occurrence.kind === 'as any').length,
    typeAny: actual.anyOccurrences.filter((occurrence) => occurrence.kind === ': any').length,
  };
}

/**
 * 判定：文件按「基线记录值，否则 250」，三个数字按「基线即上限」（`srcLines` 只打印）。
 *
 * 只做比较，不读写磁盘——测试直接喂构造出来的 `actual` / `baseline`。
 */
export function compareShape(actual: ShapeActual, baseline: ShapeBaseline): ShapeEvaluation {
  const fileViolations: FileViolation[] = [];
  const fileTightenings: FileTightening[] = [];
  const nextFiles: Record<string, number> = {};
  const actualByFile = new Map(actual.files.map((record) => [record.file, record.lines]));

  const files = [...new Set([...actualByFile.keys(), ...Object.keys(baseline.files)])].sort();
  for (const file of files) {
    const actualLines = actualByFile.get(file);
    const recorded = baseline.files[file];

    if (actualLines === undefined) {
      // 文件被删除：基线里的上限已经没有意义。
      if (recorded !== undefined) {
        fileTightenings.push({ file, from: recorded, to: null });
      }
      continue;
    }

    const limit = recorded ?? FILE_LINE_LIMIT;
    if (actualLines > limit) {
      fileViolations.push({ file, actual: actualLines, limit });
      if (recorded !== undefined) {
        nextFiles[file] = recorded;
      }
      continue;
    }

    // 基线只记「当前超过 250 行」的文件；回到 250 以内的条目应删除。
    if (actualLines <= FILE_LINE_LIMIT) {
      if (recorded !== undefined) {
        fileTightenings.push({ file, from: recorded, to: null });
      }
      continue;
    }

    nextFiles[file] = actualLines;
    if (recorded !== undefined && actualLines < recorded) {
      fileTightenings.push({ file, from: recorded, to: actualLines });
    }
  }

  const metrics = actualMetrics(actual);
  const metricViolations: MetricViolation[] = [];
  const metricTightenings: MetricTightening[] = [];
  const nextMetrics: Record<MetricKey, number> = {
    functionsOver120: metrics.functionsOver120,
    srcLines: metrics.srcLines,
    asAny: metrics.asAny,
    typeAny: metrics.typeAny,
  };
  for (const key of METRIC_KEYS) {
    const current = metrics[key];
    const limit = baseline[key];
    if (key === 'srcLines') {
      // 总行数只打印、不判失败：模块化会合法地增加 import 与签名的行数，用总数当门禁等于
      // 惩罚拆分。真正该守的是单文件上限与超长函数个数。基线跟着当前值走，读数仍然可见。
      nextMetrics[key] = current;
      continue;
    }
    if (current > limit) {
      metricViolations.push({ key, actual: current, limit });
      nextMetrics[key] = limit;
      continue;
    }
    nextMetrics[key] = current;
    if (current < limit) {
      metricTightenings.push({ key, from: limit, to: current });
    }
  }

  return {
    fileViolations,
    fileTightenings,
    metricViolations,
    metricTightenings,
    next: {
      files: nextFiles,
      functionsOver120: nextMetrics.functionsOver120,
      srcLines: nextMetrics.srcLines,
      asAny: nextMetrics.asAny,
      typeAny: nextMetrics.typeAny,
    },
  };
}

function baselineFromActual(actual: ShapeActual): ShapeBaseline {
  const metrics = actualMetrics(actual);
  const files: Record<string, number> = {};
  for (const record of actual.files) {
    if (record.lines > FILE_LINE_LIMIT) {
      files[record.file] = record.lines;
    }
  }
  return {
    files,
    functionsOver120: metrics.functionsOver120,
    srcLines: metrics.srcLines,
    asAny: metrics.asAny,
    typeAny: metrics.typeAny,
  };
}

function readBaseline(rootDir: string): ShapeBaseline | null {
  const path = join(rootDir, SHAPE_BASELINE_PATH);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`${path} 必须是 JSON 对象，形如 {"src/x.ts": 300, "srcLines": 50000}`);
  }
  const record = parsed as Record<string, unknown>;
  const readCount = (key: MetricKey): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail(`${path} 的 ${key} 必须是非负整数（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  };

  const files: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((METRIC_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (!key.startsWith(`${SRC_ROOT}/`)) {
      fail(
        `${path} 里有无法识别的键 ${JSON.stringify(key)}：` +
          `文件路径必须以 \`${SRC_ROOT}/\` 开头，数字项只能是 ${METRIC_KEYS.join(' / ')}。`,
      );
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail(`${path} 的 ${key} 必须是非负整数（当前 ${JSON.stringify(value)}）`);
    }
    files[key] = value;
  }

  return {
    files,
    functionsOver120: readCount('functionsOver120'),
    srcLines: readCount('srcLines'),
    asAny: readCount('asAny'),
    typeAny: readCount('typeAny'),
  };
}

function writeBaseline(rootDir: string, baseline: ShapeBaseline): void {
  const path = join(rootDir, SHAPE_BASELINE_PATH);
  const body: Record<string, number> = {};
  for (const key of METRIC_KEYS) {
    body[key] = baseline[key];
  }
  for (const file of Object.keys(baseline.files).sort()) {
    const lines = baseline.files[file];
    if (lines !== undefined) {
      body[file] = lines;
    }
  }
  mkdirSync(join(rootDir, 'scripts'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function describeTightenings(evaluation: ShapeEvaluation): string[] {
  const changes: string[] = [];
  for (const item of evaluation.fileTightenings) {
    if (item.to === null) {
      changes.push(`${item.file} 删除条目（${String(item.from)}，已在 ${String(FILE_LINE_LIMIT)} 以内）`);
    } else {
      changes.push(`${item.file} ${String(item.from)} → ${String(item.to)}`);
    }
  }
  for (const item of evaluation.metricTightenings) {
    changes.push(`${METRIC_LABELS[item.key]} ${String(item.from)} → ${String(item.to)}`);
  }
  return changes;
}

/**
 * `--update-baseline`：显式写入收紧后的基线，任何会放宽上限的写入都拒绝。
 *
 * 基线不存在时按当前测量创建；存在时只允许持平或收紧。文件这一级没有「新增条目」的
 * 通道：新文件一旦超过 250 行就是失败，不能靠更新基线把它放进来。
 */
export function updateBaseline(
  rootDir: string,
  actual: ShapeActual,
  baseline: ShapeBaseline | null,
): BaselineUpdateResult {
  // 硬零项不进基线：树里还有禁用指令时，更新基线不该给出「成功」的信号。
  if (actual.directives.length > 0) {
    return {
      status: 'refused',
      changes: [],
      refusals: actual.directives.map(
        (hit) => `${hit.file}:${String(hit.line)} ${hit.kind}：禁用指令必须为 0，删掉后再更新基线。`,
      ),
    };
  }

  if (baseline === null) {
    writeBaseline(rootDir, baselineFromActual(actual));
    return { status: 'created', changes: [], refusals: [] };
  }

  const evaluation = compareShape(actual, baseline);
  const refusals: string[] = [];
  for (const item of evaluation.fileViolations) {
    const recorded = baseline.files[item.file];
    refusals.push(
      recorded === undefined
        ? `${item.file} 行数 ${String(item.actual)} > ${String(item.limit)}（基线里没有记录）：` +
            '新文件不能超过 250 行，--update-baseline 不会把它加进基线。'
        : `${item.file} 行数 ${String(item.actual)} > 记录 ${String(recorded)}：` +
            '--update-baseline 只能收紧，不能放宽。',
    );
  }
  for (const item of evaluation.metricViolations) {
    refusals.push(
      `${METRIC_LABELS[item.key]} ${String(item.actual)} > 基线 ${String(item.limit)}：` +
        '--update-baseline 只能收紧，不能放宽。',
    );
  }
  if (refusals.length > 0) {
    return { status: 'refused', changes: [], refusals };
  }

  const changes = describeTightenings(evaluation);
  writeBaseline(rootDir, evaluation.next);
  return { status: changes.length > 0 ? 'tightened' : 'unchanged', changes, refusals: [] };
}

// ────────────────────────────── 输出 ──────────────────────────────

function formatCountRow(
  file: string,
  line: number,
  metric: string,
  actual: number,
  limit: number,
  note: string,
): string {
  return `  ${file}:${String(line)}  ${metric}  ${String(actual)}  ${String(limit)}${note}`;
}

export function formatReport(
  actual: ShapeActual,
  baseline: ShapeBaseline,
  evaluation: ShapeEvaluation,
): string {
  const metrics = actualMetrics(actual);
  const out: string[] = [];
  const baselineFiles = Object.keys(baseline.files).length;

  out.push(
    `形状检查：${SRC_ROOT}/ 共 ${String(actual.files.length)} 个文件，${String(actual.srcLines)} 行`,
  );
  out.push(
    `口径：单文件 > ${String(FILE_LINE_LIMIT)} 行失败（基线内按记录值）；` +
      `函数体 > ${String(FUNCTION_LINE_LIMIT)} 行按个计数；` +
      '禁用指令必须 0；as any / : any 计数只降不升。',
  );

  // ── 1. 单文件行数 ──
  out.push('');
  out.push(
    `── 单文件行数（基线记录 ${String(baselineFiles)} 个超限文件，其余上限 ${String(
      FILE_LINE_LIMIT,
    )}）──`,
  );
  if (evaluation.fileViolations.length === 0) {
    out.push(`  ✓ ${String(actual.files.length)} 个文件都没有超过各自上限`);
  } else {
    for (const item of evaluation.fileViolations) {
      out.push(
        formatCountRow(
          item.file,
          1,
          '行数',
          item.actual,
          item.limit,
          `  ← 超出 ${String(item.actual - item.limit)}`,
        ),
      );
    }
  }
  if (evaluation.fileTightenings.length > 0) {
    out.push('  ! 基线可收紧（只提示，不写文件；确认后运行 `pnpm check:shape --update-baseline`）');
    for (const item of evaluation.fileTightenings) {
      const actualLines = actual.files.find((record) => record.file === item.file)?.lines;
      if (item.to === null) {
        out.push(
          formatCountRow(
            item.file,
            1,
            '行数',
            actualLines ?? 0,
            item.from,
            `  ← 基线可收紧：${String(item.from)} → 删除条目（已在 ${String(FILE_LINE_LIMIT)} 以内）`,
          ),
        );
        continue;
      }
      out.push(
        formatCountRow(
          item.file,
          1,
          '行数',
          actualLines ?? item.to,
          item.from,
          `  ← 基线可收紧：${String(item.from)} → ${String(item.to)}`,
        ),
      );
    }
  }

  // ── 2. 超长函数 ──
  out.push('');
  out.push(`── 超长函数（函数体 > ${String(FUNCTION_LINE_LIMIT)} 行）──`);
  out.push(
    `  实际 ${String(metrics.functionsOver120)} 个 / 基线 ${String(
      baseline.functionsOver120,
    )} 个`,
  );
  const functionViolation = evaluation.metricViolations.find(
    (item) => item.key === 'functionsOver120',
  );
  if (functionViolation !== undefined) {
    out.push(
      `  ✗ 超出基线（多 ${String(functionViolation.actual - functionViolation.limit)} 个），全部超限函数：`,
    );
    for (const item of actual.functions) {
      out.push(
        formatCountRow(item.file, item.line, item.name, item.lines, FUNCTION_LINE_LIMIT, ''),
      );
    }
  }
  const functionTightening = evaluation.metricTightenings.find(
    (item) => item.key === 'functionsOver120',
  );
  if (functionTightening !== undefined) {
    out.push(
      `  ! 基线可收紧：${String(functionTightening.from)} → ${String(
        functionTightening.to,
      )}（减少 ${String(functionTightening.from - functionTightening.to)} 个，确认后运行 --update-baseline）`,
    );
  }

  // ── 3. src 总行数 ──
  out.push('');
  out.push('── src 总行数 ──');
  const lineViolation = evaluation.metricViolations.find((item) => item.key === 'srcLines');
  const lineTightening = evaluation.metricTightenings.find((item) => item.key === 'srcLines');
  out.push(
    formatCountRow(
      `${SRC_ROOT}/`,
      1,
      '总行数',
      actual.srcLines,
      baseline.srcLines,
      lineViolation === undefined
        ? ''
        : `  ← 比基线多 ${String(lineViolation.actual - lineViolation.limit)} 行`,
    ),
  );
  if (lineTightening !== undefined) {
    out.push(
      `  ! 基线可收紧：${String(lineTightening.from)} → ${String(lineTightening.to)}（减少 ${String(
        lineTightening.from - lineTightening.to,
      )} 行，确认后运行 --update-baseline）`,
    );
  }

  // ── 4. 禁用指令与 any ──
  out.push('');
  out.push('── 禁用指令（必须为 0）──');
  if (actual.directives.length === 0) {
    out.push('  ✓ @ts-ignore 0 / @ts-expect-error 0 / eslint-disable 0');
  } else {
    for (const hit of actual.directives) {
      out.push(formatCountRow(hit.file, hit.line, hit.kind, 1, 0, ''));
    }
  }

  out.push('');
  out.push('── any 计数（只降不升）──');
  for (const key of ['asAny', 'typeAny'] as const) {
    const violation = evaluation.metricViolations.find((item) => item.key === key);
    out.push(
      formatCountRow(
        `${SRC_ROOT}/`,
        1,
        METRIC_LABELS[key],
        metrics[key],
        baseline[key],
        violation === undefined ? '' : `  ← 比基线多 ${String(violation.actual - violation.limit)} 处`,
      ),
    );
  }
  const anyTightenings = evaluation.metricTightenings.filter(
    (item) => item.key === 'asAny' || item.key === 'typeAny',
  );
  if (anyTightenings.length > 0) {
    out.push(
      `  ! 基线可收紧：${anyTightenings
        .map((item) => `${METRIC_LABELS[item.key]} ${String(item.from)} → ${String(item.to)}`)
        .join('，')}（确认后运行 --update-baseline）`,
    );
  }
  const anyViolations = evaluation.metricViolations.filter(
    (item) => item.key === 'asAny' || item.key === 'typeAny',
  );
  if (anyViolations.length > 0) {
    out.push('  当前全部出现位置：');
    for (const occurrence of actual.anyOccurrences) {
      out.push(`    ${occurrence.file}:${String(occurrence.line)}  ${occurrence.kind}`);
    }
  }

  const failures =
    evaluation.fileViolations.length + evaluation.metricViolations.length + actual.directives.length;
  out.push('');
  out.push(
    `总计：文件 ${String(actual.files.length)} 个 / ${String(actual.srcLines)} 行；` +
      `文件超限 ${String(evaluation.fileViolations.length)} 个，` +
      `超长函数 ${String(metrics.functionsOver120)} 个（基线 ${String(baseline.functionsOver120)}），` +
      `禁用指令 ${String(actual.directives.length)} 处，` +
      `any ${String(metrics.asAny + metrics.typeAny)} 处` +
      (failures === 0 ? ' → ✓ 通过' : ` → ✗ 失败 ${String(failures)} 项`),
  );

  return out.join('\n');
}

// ────────────────────────────── 入口 ──────────────────────────────

function main(): void {
  const rootDir = REPO_ROOT;
  const actual = analyzeShape(rootDir);
  const update = process.argv.includes('--update-baseline');
  const baseline = readBaseline(rootDir);

  if (update) {
    const result = updateBaseline(rootDir, actual, baseline);
    if (result.status === 'refused') {
      for (const refusal of result.refusals) {
        process.stderr.write(`${refusal}\n`);
      }
      fail('拒绝写入基线：--update-baseline 只能收紧。先把超限文件拆到上限以内，或清理新增的超长函数与禁用指令。');
    }
    if (result.status === 'created') {
      const created = baselineFromActual(actual);
      process.stdout.write(
        `基线文件不存在，已按当前测量创建 ${SHAPE_BASELINE_PATH}：` +
          `超限文件 ${String(Object.keys(created.files).length)} 个，` +
          `超长函数 ${String(created.functionsOver120)} 个，` +
          `src 总行数 ${String(created.srcLines)}，` +
          `as any ${String(created.asAny)} / : any ${String(created.typeAny)}\n`,
      );
      process.exit(0);
    }
    process.stdout.write(
      result.status === 'unchanged'
        ? '基线未变化\n'
        : `基线已收紧：\n${result.changes.map((change) => `  ${change}`).join('\n')}\n`,
    );
    process.exit(0);
  }

  if (baseline === null) {
    fail(
      `缺少 ${SHAPE_BASELINE_PATH}。首次建立基线请运行：pnpm check:shape --update-baseline`,
    );
  }

  const evaluation = compareShape(actual, baseline);
  process.stdout.write(`${formatReport(actual, baseline, evaluation)}\n`);
  const failures =
    evaluation.fileViolations.length + evaluation.metricViolations.length + actual.directives.length;
  process.exit(failures === 0 ? 0 : 1);
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  main();
}
