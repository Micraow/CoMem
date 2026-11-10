/**
 * 文档行号检查：`路径.ts:行号` 必须仍然指向它所声称的那个符号。
 *
 * ## 为什么需要它
 *
 * `docs/` 用「符号名（`file.ts:行号`）」定位代码。重构把函数搬走以后，行号仍然落在
 * 文件里，只是指向了另一个符号——`permission-repository.ts:133` 从谓词函数变成
 * `replaceSubtree`。这种漂移不报错，只是让照文档读代码的人读错位置，比没有行号更糟。
 *
 * 本脚本把三件事变成门禁：
 *
 * 1. 路径存在：文档里的 `路径.ts` / `路径.vue` 能在仓库里唯一解析到一个文件。
 * 2. 行号在范围内：`1 <= 行号 <= 文件行数`。
 * 3. 符号对得上：目标行 ±2 行内的声明名字里，包含文档同处声称的符号。
 *
 * ## 第 3 条的「声称符号」怎么取
 *
 * 文档里的引用有两种写法：`` `file.ts:12` `symbol` `` 与「`symbol`（`file.ts:12`）」。
 * 声称符号取**紧邻该引用的反引号标识符**：先看引用之后，再看引用之前，中间只允许
 * 空白、括号、冒号和「的」。取不到就跳过第 3 条（这条引用没有声称符号，只做 1、2）。
 *
 * 为什么不是「同一文档行里第一个反引号标识符」：`coverage-map.md` 是六列表格，一行里
 * 同时出现能力名、MCP 工具名、多个实现符号和测试名。按「行内第一个」取，会把别的列
 * 的符号当成这条引用声称的符号——在真实仓库上量到 229 处失败、13 处通过、45 处跳过、
 * 4 处越界，失败里绝大多数是这种串列误报。紧邻关系是文档里唯一稳定表达「这个行号说
 * 的是这个符号」的位置信息，不需要白名单，也不依赖列名。
 *
 * ## 跳过条件（只跳过第 3 条，1、2 照查）
 *
 * - 引用旁边没有反引号标识符：如 `` `tests/x.test.ts:12`「用例名」 `` 的测试证据列。
 * - 紧邻的标识符是 `true` / `null` / `undefined` / `string` 这类语言词，不是符号名。
 *
 * 两者都不是「允许」：规则 1、2 仍然生效，报告里计入「跳过」而不是「通过」。
 *
 * ## 声明名字的口径
 *
 * TS 语法树里取：函数声明、方法、getter / setter、类、接口、类型别名、`const` / `let`
 * / `var` 的标识符绑定、枚举与枚举成员。`.vue` 没有单一模块边界，退回正则
 * `function X` / `const X =` / `defineProps` 等。
 *
 * ## 抓不到的那一类（残余）
 *
 * - **没有声称符号的引用**：只有存在性与范围可查，例如 `permission-repository.ts:133`
 *   所在的行只写了「`node_permission` 过滤（…）」，目标行 ±2 范围内没有
 *   `node_permission` 声明也不代表行号错了。
 * - **符号名同名**：两个声明叫同一个名字时，±2 行内出现任意一个就算通过。
 * - **声明种类不全**：对象字面量的 `foo: () =>`、解构绑定、属性声明不在名字集合里，
 *   文档若只写这些名字会被判失败（目前仓库里没有这种引用）。
 * - **路径按后缀解析**：`container.ts` 只要仓库里只有一个后缀匹配就通过；拆成
 *   `container/index.ts` 后旧路径若仍存在（re-export 壳），规则 1 通过、规则 2 才可能
 *   发现行号越界。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 文档根：只查 `docs/` 下的 Markdown。 */
const DOCS_ROOT = 'docs';
/** 目标行前后各看几行。 */
export const SYMBOL_WINDOW = 2;

const DOC_EXTENSION = '.md';
const CODE_EXTENSIONS = ['.ts', '.vue'] as const;
/** 遍历代码文件时跳过的目录：产物、缓存、第三方依赖。 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'local',
  'dist',
  '.nuxt',
  '.output',
  'coverage',
]);

const REFERENCE_PATTERN = /([A-Za-z0-9_./-]+\.(?:ts|vue)):(\d+)/g;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * 反引号里形如标识符、但不是符号名的词。紧邻引用时跳过第 3 条。
 * 只列语言层面的词：值字面量、关键字、原始类型。
 */
const NON_SYMBOL_TOKENS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'void',
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'never',
  'object',
  'readonly',
  'keyof',
  'typeof',
  'instanceof',
]);
/** 引用与符号之间允许出现的字符：空白、括号、引号、冒号，以及一个「的」。 */
const SYMBOL_SEPARATOR = /^[\s()（）「」『』:：]*(?:的[\s()（）「」『』:：]*)?$/;

const VUE_DECLARATION_PATTERNS: readonly RegExp[] = [
  /(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
  /(defineProps|defineEmits|defineExpose|defineModel)\s*(?:<[^>]*>)?\s*\(/g,
];

export interface Declaration {
  readonly name: string;
  /** 1-based，声明名字所在行。 */
  readonly line: number;
}

export type ReferenceFailure =
  | 'path-missing'
  | 'path-ambiguous'
  | 'line-out-of-range'
  | 'symbol-mismatch';

export type SkipReason = 'no-adjacent-symbol' | 'non-symbol-token';

export type ReferenceStatus = 'pass' | 'fail' | 'skip';

export interface ReferenceCheck {
  /** 文档路径，相对仓库根。 */
  readonly doc: string;
  /** 文档里的 1-based 行号。 */
  readonly docLine: number;
  /** 文档里写的路径，可能只是后缀。 */
  readonly sourcePath: string;
  /** 文档里写的 1-based 行号。 */
  readonly line: number;
  /** 唯一解析到的仓库文件；解析失败为 `null`。 */
  readonly resolvedPath: string | null;
  /** 解析到的文件行数；解析失败为 `null`。 */
  readonly fileLines: number | null;
  /** 紧邻引用的反引号标识符；没有时为 `null`。 */
  readonly claimedSymbol: string | null;
  readonly status: ReferenceStatus;
  readonly failure: ReferenceFailure | null;
  readonly skipReason: SkipReason | null;
  /** 目标行 ±2 行内距离最近的声明；没有声明为 `null`。 */
  readonly actual: Declaration | null;
  /** 路径歧义时列出全部候选。 */
  readonly candidates: readonly string[];
}

export interface DocSummary {
  readonly doc: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface DocsAnalysis {
  readonly references: readonly ReferenceCheck[];
  readonly perDoc: readonly DocSummary[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly skipsByReason: Readonly<Record<SkipReason, number>>;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function collectFiles(dir: string, extensions: readonly string[], skipDirectories: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipDirectories.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path, extensions, skipDirectories));
      continue;
    }
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

/** 文件行数：`split('\n')` 后去掉结尾换行产生的那一个空元素。 */
export function countLines(text: string): number {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

function memberName(name: ts.PropertyName | ts.PrivateIdentifier, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function collectTypeScriptDeclarations(sourceFile: ts.SourceFile): Declaration[] {
  const found: Declaration[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      found.push({ name: node.name.text, line: lineOf(node.name) });
    } else if (ts.isMethodDeclaration(node)) {
      found.push({ name: memberName(node.name, sourceFile), line: lineOf(node.name) });
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      found.push({ name: memberName(node.name, sourceFile), line: lineOf(node.name) });
    } else if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      found.push({ name: node.name.text, line: lineOf(node.name) });
    } else if (ts.isEnumMember(node)) {
      found.push({ name: memberName(node.name, sourceFile), line: lineOf(node) });
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        found.push({ name: node.name.text, line: lineOf(node.name) });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** `.vue` 没有可整文件解析的 TS 模块，按单行正则取声明。 */
function collectVueDeclarations(text: string): Declaration[] {
  const found: Declaration[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of VUE_DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) {
          found.push({ name, line: index + 1 });
        }
      }
    }
  }
  return found;
}

export function collectDeclarations(filePath: string, text: string): Declaration[] {
  if (filePath.endsWith('.vue')) {
    return collectVueDeclarations(text);
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  return collectTypeScriptDeclarations(sourceFile);
}

interface SymbolClaim {
  readonly symbol: string | null;
  readonly skipReason: SkipReason | null;
}

/**
 * 取紧邻这条引用的声称符号。
 *
 * 引用两侧的包裹反引号先剥掉，再看之后 / 之前的反引号标识符：中间只允许
 * `SYMBOL_SEPARATOR`。之后优先——文档的常见写法是 `` `file.ts:12` `symbol` ``。
 */
export function claimedSymbolAt(line: string, refStart: number, refEnd: number): SymbolClaim {
  const spans: { readonly text: string; readonly start: number; readonly end: number }[] = [];
  for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
    const start = match.index ?? 0;
    const text = match[1] ?? '';
    spans.push({ text: text.trim(), start, end: start + match[0].length });
  }

  let start = refStart;
  let end = refEnd;
  if (line[start - 1] === '`') {
    start -= 1;
  }
  if (line[end] === '`') {
    end += 1;
  }

  const identifiers = spans.filter((span) => IDENTIFIER_PATTERN.test(span.text));
  const following = identifiers.find(
    (span) => span.start >= end && SYMBOL_SEPARATOR.test(line.slice(end, span.start)),
  );
  const preceding = identifiers
    .filter((span) => span.end <= start && SYMBOL_SEPARATOR.test(line.slice(span.end, start)))
    .at(-1);
  const adjacent = following ?? preceding;

  if (adjacent === undefined) {
    return { symbol: null, skipReason: 'no-adjacent-symbol' };
  }
  if (NON_SYMBOL_TOKENS.has(adjacent.text)) {
    return { symbol: null, skipReason: 'non-symbol-token' };
  }
  return { symbol: adjacent.text, skipReason: null };
}

function nearestDeclaration(declarations: readonly Declaration[], line: number): Declaration | null {
  let nearest: Declaration | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const declaration of declarations) {
    const distance = Math.abs(declaration.line - line);
    if (distance > SYMBOL_WINDOW) {
      continue;
    }
    if (
      distance < nearestDistance ||
      (distance === nearestDistance && nearest !== null && declaration.line < nearest.line)
    ) {
      nearest = declaration;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function declarationsInWindow(declarations: readonly Declaration[], line: number): Declaration[] {
  return declarations.filter((declaration) => Math.abs(declaration.line - line) <= SYMBOL_WINDOW);
}

/** 测量一个仓库根（真实仓库或测试 fixture），不打印、不写文件。 */
export function analyzeDocs(rootDir: string): DocsAnalysis {
  const docFiles = collectFiles(join(rootDir, DOCS_ROOT), [DOC_EXTENSION], SKIPPED_DIRECTORIES).sort();
  const codeFiles = collectFiles(rootDir, CODE_EXTENSIONS, SKIPPED_DIRECTORIES).map((file) =>
    toPosix(relative(rootDir, file)),
  );
  const textCache = new Map<string, string>();
  const declarationCache = new Map<string, Declaration[]>();

  const readText = (relativePath: string): string => {
    const cached = textCache.get(relativePath);
    if (cached !== undefined) {
      return cached;
    }
    const text = readFileSync(join(rootDir, relativePath), 'utf8');
    textCache.set(relativePath, text);
    return text;
  };

  const resolvePath = (sourcePath: string): string[] => {
    const normalized = sourcePath.replace(/^\.\//, '');
    return codeFiles.filter(
      (file) => file === normalized || file.endsWith(`/${normalized}`),
    );
  };

  const declarationsOf = (relativePath: string): Declaration[] => {
    const cached = declarationCache.get(relativePath);
    if (cached !== undefined) {
      return cached;
    }
    const declarations = collectDeclarations(relativePath, readText(relativePath));
    declarationCache.set(relativePath, declarations);
    return declarations;
  };

  const references: ReferenceCheck[] = [];
  for (const docFile of docFiles) {
    const doc = toPosix(relative(rootDir, docFile));
    const lines = readText(doc).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const match of line.matchAll(REFERENCE_PATTERN)) {
        const sourcePath = match[1] ?? '';
        const lineNumber = Number(match[2]);
        const refStart = match.index ?? 0;
        const refEnd = refStart + match[0].length;
        const claim = claimedSymbolAt(line, refStart, refEnd);

        const candidates = resolvePath(sourcePath);
        if (candidates.length !== 1) {
          references.push({
            doc,
            docLine: index + 1,
            sourcePath,
            line: lineNumber,
            resolvedPath: null,
            fileLines: null,
            claimedSymbol: claim.symbol,
            status: 'fail',
            failure: candidates.length === 0 ? 'path-missing' : 'path-ambiguous',
            skipReason: null,
            actual: null,
            candidates,
          });
          continue;
        }

        const resolvedPath = candidates[0] ?? '';
        const totalLines = countLines(readText(resolvedPath));
        if (lineNumber < 1 || lineNumber > totalLines) {
          references.push({
            doc,
            docLine: index + 1,
            sourcePath,
            line: lineNumber,
            resolvedPath,
            fileLines: totalLines,
            claimedSymbol: claim.symbol,
            status: 'fail',
            failure: 'line-out-of-range',
            skipReason: null,
            actual: nearestDeclaration(declarationsOf(resolvedPath), lineNumber),
            candidates,
          });
          continue;
        }

        if (claim.symbol === null) {
          references.push({
            doc,
            docLine: index + 1,
            sourcePath,
            line: lineNumber,
            resolvedPath,
            fileLines: totalLines,
            claimedSymbol: null,
            status: 'skip',
            failure: null,
            skipReason: claim.skipReason,
            actual: nearestDeclaration(declarationsOf(resolvedPath), lineNumber),
            candidates,
          });
          continue;
        }

        const declarations = declarationsOf(resolvedPath);
        const names = new Set(declarationsInWindow(declarations, lineNumber).map((item) => item.name));
        const matched = names.has(claim.symbol);
        references.push({
          doc,
          docLine: index + 1,
          sourcePath,
          line: lineNumber,
          resolvedPath,
          fileLines: totalLines,
          claimedSymbol: claim.symbol,
          status: matched ? 'pass' : 'fail',
          failure: matched ? null : 'symbol-mismatch',
          skipReason: null,
          actual: nearestDeclaration(declarations, lineNumber),
          candidates,
        });
      }
    }
  }

  references.sort(
    (left, right) =>
      left.doc.localeCompare(right.doc) ||
      left.docLine - right.docLine ||
      left.sourcePath.localeCompare(right.sourcePath),
  );

  const docOrder = docFiles.map((file) => toPosix(relative(rootDir, file)));
  const perDoc: DocSummary[] = docOrder.map((doc) => {
    const own = references.filter((reference) => reference.doc === doc);
    return {
      doc,
      total: own.length,
      passed: own.filter((reference) => reference.status === 'pass').length,
      failed: own.filter((reference) => reference.status === 'fail').length,
      skipped: own.filter((reference) => reference.status === 'skip').length,
    };
  });

  const skipsByReason: Record<SkipReason, number> = {
    'no-adjacent-symbol': 0,
    'non-symbol-token': 0,
  };
  for (const reference of references) {
    if (reference.status === 'skip' && reference.skipReason !== null) {
      skipsByReason[reference.skipReason] += 1;
    }
  }

  return {
    references,
    perDoc,
    total: references.length,
    passed: references.filter((reference) => reference.status === 'pass').length,
    failed: references.filter((reference) => reference.status === 'fail').length,
    skipped: references.filter((reference) => reference.status === 'skip').length,
    skipsByReason,
  };
}

function describeFailure(reference: ReferenceCheck): string {
  const target = `${reference.sourcePath}:${String(reference.line)}`;
  switch (reference.failure) {
    case 'path-missing':
      return `${target}  路径不存在`;
    case 'path-ambiguous':
      return `${target}  路径不唯一：${reference.candidates.join(' / ')}`;
    case 'line-out-of-range':
      return `${target}  行号越界（文件 ${String(reference.fileLines ?? 0)} 行）`;
    case 'symbol-mismatch': {
      const claimed = reference.claimedSymbol ?? '?';
      const actual =
        reference.actual === null
          ? '±2 行内无声明'
          : `${reference.actual.name}（:${String(reference.actual.line)}）`;
      return `${target}  声称 ${claimed} → 实际 ${actual}`;
    }
    case null:
      return target;
  }
}

export function formatReport(analysis: DocsAnalysis): string {
  const out: string[] = [];
  out.push(
    `文档行号检查：${DOCS_ROOT}/ 下 ${String(analysis.perDoc.length)} 个文档，` +
      `${String(analysis.total)} 处引用（\`路径.ts:行号\`）`,
  );
  out.push(
    `口径：路径必须唯一解析；行号在 1..文件行数；紧邻引用的反引号标识符必须出现在` +
      `目标行 ±${String(SYMBOL_WINDOW)} 行的声明里，取不到则跳过第 3 条。`,
  );

  for (const summary of analysis.perDoc) {
    if (summary.failed === 0) {
      continue;
    }
    out.push('');
    out.push(
      `── ${summary.doc}（${String(summary.total)} 处：通过 ${String(summary.passed)} / ` +
        `失败 ${String(summary.failed)} / 跳过 ${String(summary.skipped)}）──`,
    );
    for (const reference of analysis.references) {
      if (reference.doc !== summary.doc || reference.status !== 'fail') {
        continue;
      }
      out.push(`  ${reference.doc}:${String(reference.docLine)}  ${describeFailure(reference)}`);
    }
  }

  out.push('');
  out.push(
    `统计：检查 ${String(analysis.total)} 处，通过 ${String(analysis.passed)}，` +
      `失败 ${String(analysis.failed)}，跳过 ${String(analysis.skipped)}` +
      `（无紧邻反引号标识符 ${String(analysis.skipsByReason['no-adjacent-symbol'])} / ` +
      `非符号词 ${String(analysis.skipsByReason['non-symbol-token'])}）` +
      (analysis.failed === 0 ? ' → ✓ 通过' : ` → ✗ 失败 ${String(analysis.failed)} 项`),
  );

  return out.join('\n');
}

// ────────────────────────────── 入口 ──────────────────────────────

function main(): void {
  const analysis = analyzeDocs(REPO_ROOT);
  process.stdout.write(`${formatReport(analysis)}\n`);
  process.exit(analysis.failed === 0 ? 0 : 1);
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  main();
}
