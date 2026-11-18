/**
 * 文档代码引用检查：`docs/` 里每个 `路径.ts` / `路径.vue` 引用必须指向仓库里存在的
 * 文件，紧邻引用写出的符号名必须在该文件里有声明。
 *
 * ## 查什么
 *
 * 只查 `docs/` 下的 `.md`，引用是反引号里的 `xxx.ts` / `xxx.vue`。
 *
 * 1. 路径：带目录的（`src/services/session/archive.ts`）必须唯一命中一个仓库文件；
 *    只有文件名的（`archive.ts`）至少命中一个文件即可。
 * 2. 符号（可选）：紧邻引用的反引号标识符，例如 `` `src/x.ts` 的 `alpha` `` 或
 *    `` `alpha`（`src/x.ts`） ``，中间只允许空白、括号（含全角）、引号、冒号和一个
 *    「的」。该符号必须出现在解析到的文件的声明里，任意行即可。
 *
 * ## 怎么算失败
 *
 * - `path-missing`：路径没有命中任何文件。
 * - `path-ambiguous`：带目录的路径命中多个文件。
 * - `symbol-missing`：写出的符号在解析到的文件里没有声明；只有文件名的引用命中多个
 *   文件时，任意一个文件里有声明即通过。
 *
 * 没有符号的引用只查路径，算通过。紧邻的标识符是语言词（`true`、`null`、`string`
 * 等）时，视同没有符号。
 *
 * 声明口径：TS 语法树里的函数声明、方法、getter / setter、类、接口、类型别名、
 * `const` / `let` / `var` 标识符绑定、枚举与枚举成员；`.vue` 退回正则。
 * 失败信息里的 `docs/x.md:12` 是文档定位，不是被校验的代码行号。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 文档根：只查 `docs/` 下的 Markdown。 */
const DOCS_ROOT = 'docs';

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

const PATH_PATTERN = /[A-Za-z0-9_./-]+\.(?:ts|vue)/g;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * 反引号里形如标识符、但不是符号名的词。紧邻引用时视同没有符号。
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

export type ReferenceFailure = 'path-missing' | 'path-ambiguous' | 'symbol-missing';

export type ReferenceStatus = 'pass' | 'fail';

export interface ReferenceCheck {
  /** 文档路径，相对仓库根。 */
  readonly doc: string;
  /** 文档里的 1-based 行号，报告定位用。 */
  readonly docLine: number;
  /** 文档里写的路径，可能只是后缀。 */
  readonly sourcePath: string;
  /** 唯一解析到的仓库文件；没有唯一命中时为 `null`。 */
  readonly resolvedPath: string | null;
  /** 紧邻引用的反引号标识符；没有时为 `null`。 */
  readonly claimedSymbol: string | null;
  readonly status: ReferenceStatus;
  readonly failure: ReferenceFailure | null;
  /** 路径命中的全部文件；歧义时列出候选。 */
  readonly candidates: readonly string[];
}

export interface DocSummary {
  readonly doc: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

export interface DocsAnalysis {
  readonly references: readonly ReferenceCheck[];
  readonly perDoc: readonly DocSummary[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

interface InlineCodeSpan {
  readonly text: string;
  /** 反引号内内容的起始位置。 */
  readonly start: number;
  /** 反引号内内容的结束位置（不含）。 */
  readonly end: number;
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

function inlineCodeSpans(line: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
    const opened = match.index ?? 0;
    const text = match[1] ?? '';
    spans.push({ text, start: opened + 1, end: opened + 1 + text.length });
  }
  return spans;
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

function collectTypeScriptDeclarationNames(sourceFile: ts.SourceFile): Set<string> {
  const found = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      found.add(node.name.text);
    } else if (ts.isMethodDeclaration(node)) {
      found.add(memberName(node.name, sourceFile));
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      found.add(memberName(node.name, sourceFile));
    } else if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      found.add(node.name.text);
    } else if (ts.isEnumMember(node)) {
      found.add(memberName(node.name, sourceFile));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      found.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** `.vue` 没有可整文件解析的 TS 模块，按单行正则取声明。 */
function collectVueDeclarationNames(text: string): Set<string> {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    for (const pattern of VUE_DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) {
          found.add(name);
        }
      }
    }
  }
  return found;
}

export function declaredNames(filePath: string, text: string): ReadonlySet<string> {
  if (filePath.endsWith('.vue')) {
    return collectVueDeclarationNames(text);
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  return collectTypeScriptDeclarationNames(sourceFile);
}

/**
 * 取紧邻这条引用的符号名。
 *
 * 引用两侧的包裹反引号先剥掉，再看之后 / 之前的反引号标识符：中间只允许
 * `SYMBOL_SEPARATOR`。之后优先——文档的常见写法是 `` `file.ts` `symbol` ``。
 */
export function claimedSymbolAt(line: string, refStart: number, refEnd: number): string | null {
  let start = refStart;
  let end = refEnd;
  if (line[start - 1] === '`') {
    start -= 1;
  }
  if (line[end] === '`') {
    end += 1;
  }

  const identifiers: { readonly text: string; readonly start: number; readonly end: number }[] = [];
  for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
    const spanStart = match.index ?? 0;
    const text = match[1] ?? '';
    if (IDENTIFIER_PATTERN.test(text.trim())) {
      identifiers.push({ text, start: spanStart, end: spanStart + match[0].length });
    }
  }

  const following = identifiers.find(
    (span) => span.start >= end && SYMBOL_SEPARATOR.test(line.slice(end, span.start)),
  );
  const preceding = identifiers
    .filter((span) => span.end <= start && SYMBOL_SEPARATOR.test(line.slice(span.end, start)))
    .at(-1);
  const adjacent = following ?? preceding;

  if (adjacent === undefined) {
    return null;
  }
  const symbol = adjacent.text.trim();
  return NON_SYMBOL_TOKENS.has(symbol) ? null : symbol;
}

/** 测量一个仓库根（真实仓库或测试 fixture），不打印、不写文件。 */
export function analyzeDocs(rootDir: string): DocsAnalysis {
  const docFiles = collectFiles(join(rootDir, DOCS_ROOT), [DOC_EXTENSION], SKIPPED_DIRECTORIES).sort();
  const codeFiles = collectFiles(rootDir, CODE_EXTENSIONS, SKIPPED_DIRECTORIES).map((file) =>
    toPosix(relative(rootDir, file)),
  );
  const textCache = new Map<string, string>();
  const namesCache = new Map<string, ReadonlySet<string>>();

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
    return codeFiles.filter((file) => file === normalized || file.endsWith(`/${normalized}`));
  };

  const namesOf = (relativePath: string): ReadonlySet<string> => {
    const cached = namesCache.get(relativePath);
    if (cached !== undefined) {
      return cached;
    }
    const names = declaredNames(relativePath, readText(relativePath));
    namesCache.set(relativePath, names);
    return names;
  };

  const references: ReferenceCheck[] = [];
  for (const docFile of docFiles) {
    const doc = toPosix(relative(rootDir, docFile));
    const lines = readText(doc).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const span of inlineCodeSpans(line)) {
        for (const match of span.text.matchAll(PATH_PATTERN)) {
          const sourcePath = match[0];
          const start = span.start + (match.index ?? 0);
          const end = start + sourcePath.length;
          const normalized = sourcePath.replace(/^\.\//, '');
          const hasDirectory = normalized.includes('/');
          const candidates = resolvePath(sourcePath);
          const claimedSymbol = claimedSymbolAt(line, start, end);

          let failure: ReferenceFailure | null = null;
          if (candidates.length === 0) {
            failure = 'path-missing';
          } else if (hasDirectory && candidates.length > 1) {
            failure = 'path-ambiguous';
          } else if (
            claimedSymbol !== null &&
            !candidates.some((candidate) => namesOf(candidate).has(claimedSymbol))
          ) {
            failure = 'symbol-missing';
          }

          references.push({
            doc,
            docLine: index + 1,
            sourcePath,
            resolvedPath: candidates.length === 1 ? (candidates[0] ?? null) : null,
            claimedSymbol,
            status: failure === null ? 'pass' : 'fail',
            failure,
            candidates,
          });
        }
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
    };
  });

  return {
    references,
    perDoc,
    total: references.length,
    passed: references.filter((reference) => reference.status === 'pass').length,
    failed: references.filter((reference) => reference.status === 'fail').length,
  };
}

function describeFailure(reference: ReferenceCheck): string {
  switch (reference.failure) {
    case 'path-missing':
      return `${reference.sourcePath}  路径不存在`;
    case 'path-ambiguous':
      return `${reference.sourcePath}  路径不唯一：${reference.candidates.join(' / ')}`;
    case 'symbol-missing': {
      const claimed = reference.claimedSymbol ?? '?';
      const targets =
        reference.candidates.length > 1
          ? `候选文件（${reference.candidates.join(' / ')}）`
          : reference.sourcePath;
      return `${reference.sourcePath}  声称 ${claimed}，${targets} 里没有声明`;
    }
    case null:
      return reference.sourcePath;
  }
}

export function formatReport(analysis: DocsAnalysis): string {
  const out: string[] = [];
  out.push(
    `文档引用检查：${DOCS_ROOT}/ 下 ${String(analysis.perDoc.length)} 个文档，` +
      `${String(analysis.total)} 处代码引用（\`路径.ts\` / \`路径.vue\`）`,
  );
  out.push(
    '口径：带目录的路径必须唯一命中一个文件；只有文件名的至少命中一个；' +
      '紧邻引用的反引号标识符必须出现在该文件的声明里。',
  );

  for (const summary of analysis.perDoc) {
    if (summary.failed === 0) {
      continue;
    }
    out.push('');
    out.push(
      `── ${summary.doc}（${String(summary.total)} 处：通过 ${String(summary.passed)} / ` +
        `失败 ${String(summary.failed)}）──`,
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
      `失败 ${String(analysis.failed)}` +
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
