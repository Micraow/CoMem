/**
 * 可达性检查：从进程入口算「模块可达 + 导出符号可达 + 成员方法可达」，
 * 找出「写了但没接线」的代码。
 *
 * ## 为什么需要它
 *
 * `check:orphans`（已删除）判的是「这个名字有没有在别处被提到」，所以它抓不到本仓库
 * 最常见的一类缺陷：方法被调用了、也被测试覆盖了，但**调用链本身不在任何真实入口上**。
 * 名字出现过就算「有人用」，整个模块只有测试引用也算「有人用」，于是功能是死的、
 * 门禁是绿的。`MemoryLinkService.addLinks` 就是这么活下来的：表、仓储、服务、
 * HTTP 读端点、12 条测试全都齐全，写侧零调用。
 *
 * 本检查把口径换成**可达性**：入口是根，沿值导入边走得到模块，模块里被跨文件值引用
 * 的导出符号才算接上。测试引用**不算**可达——测试不是进程入口。方法再单独一层：
 * 类可达、方法没人调，同样算没接线。
 *
 * ## 入口怎么定
 *
 * 不维护手写名单，靠语法特征自动识别：`src/` 内出现
 * `import.meta.url === pathToFileURL(...)`（或 `!==`）比较的模块就是进程入口。
 * `tsx src/bootstrap/main.ts`、`tsx src/commands/reindex.ts` 与 `node dist/...` 都走
 * 这条判断，CLI 入口底部的 `if (import.meta.url === ...)` 是同一形态。识别结果打印在
 * 报告里，入口变了报告跟着变，不需要改检查器。
 *
 * `web/` 不作为入口：它是独立构建（`web/tsconfig.json` 继承 `.nuxt/tsconfig.json`，
 * 由 `nuxt` 自己的打包器解析），且不 import `src/`（控制台只走 HTTP）。把它拉进来
 * 既不会让任何 `src/` 符号变可达，又需要一套完全不同的模块解析规则。
 *
 * ## 口径
 *
 * ### 模块级
 *
 * - 边只取**值导入**：`import { x } from`、`import './x.js'`、`export ... from`、
 *   字面量 `import('...')`。
 * - `import type` / `export type` / 全部 specifier 都是 `type` 的导入**不算边**：
 *   在 `verbatimModuleSyntax: true` 下它们被擦除，运行时不会加载那个模块。只被类型
 *   导入的模块会在报告里单独标成「仅类型导入」；只有 `interface` / `type` 的纯类型
 *   模块单独计数，不算「不可达模块」。
 * - 外部包（`fastify`、`node:*`）与 `.d.ts` 不进图。
 *
 * ### 符号级
 *
 * - 目标是 `src/**` 里**导出的值声明**：`export class` / `export function` /
 *   `export const|let|var` / `export enum`。入口模块自身的导出不算目标（它是根，
 *   `runMain` 之类的导出是给测试留的）。
 * - 引用只算**值位置**的标识符。类型注解、`import type`、`typeof X` 记为类型引用，
 *   能让符号进入「仅类型位置引用」而不是「可达」。
 * - 可达 = 该符号在**可达模块**里被**跨文件**值引用一次以上。同文件引用不算可达
 *   （那是「内部函数误导出」），测试引用不算可达。
 *
 * ### 成员方法级
 *
 * - 目标是 `src/**`（入口模块除外）里 `export class` 的 public / protected 方法，以及
 *   `export const x = { m() }` 对象字面量里的方法。`async` 不区分，`constructor`、
 *   `private`、`#name`、getter / setter 不是目标；无实现的方法（`abstract`、重载签名）
 *   跳过，重载实现按一个成员算。
 * - 引用判定只认 AST 上的调用表达式：可达生产模块里的 `.m(`（`svc.m()`、`this.m()`、
 *   接口接收者 `port.m()`、可选链 `?.m()`），以及 `tests/` 里的同形调用（单独计数）。
 *   字符串里出现方法名不算，`void svc.m` 这种只取引用不调用也不算。
 * - **同类内部调用不算外部调用**：调用点的最近外层类就是方法的所属类时（`this.m()`、
 *   类内任意 `obj.m()`、递归）记 internal，不让方法变可达。对象字面量方法同理。
 * - **接口 / 类型契约**：接口与类型字面量里的方法签名 `m(...)` 本身不算引用——只声明
 *   契约不能证明有人调用。只有当该契约方法在可达生产模块里被调用、且所在类的实例可
 *   赋值给接收者类型时，实现方法才算接上（与已删除的 `check:orphans` 端口判定同一
 *   口径）。这样「`greet` 被接口调用」算可达，「`farewell` 只声明没人调」仍然报出来。
 * - `protected` 方法视为可被子类调用：所属类在可达生产模块里有子类时不报，没有子类时
 *   按普通方法判定。
 * - 分类：
 *   - `method-no-caller`：可达生产零调用点（不是同类内部，也不是被调用的契约实现）。
 *     调用点只存在于不可达模块里也归这一类，证据里点明。
 *   - `method-test-only`：只有 `tests/` 调用点。
 *   - `reachable` / `protected-inherited` / `contract`：不报（后两者是公开面或契约面）。
 *
 * ### 分类与门禁
 *
 * | 分类 | 含义 | 是否让命令失败 |
 * |---|---|---|
 * | `unreachable-callers` | 有生产引用，但引用方模块本身不在入口上 | 是 |
 * | `same-file-only` | 只有定义文件自己引用（导出多余） | 是 |
 * | `never-imported`（模块） | 运行时模块没有任何值导入边 | 是 |
 * | `test-only`（符号） | 只有 `tests/` 值引用 | **否**，进基线 ratchet |
 * | `method-no-caller` | 可达生产零调用点 | 是 |
 * | `method-test-only` | 只有 `tests/` 调用点 | **否**，进基线 ratchet |
 * | `type-only` / `no-reference` | 只在类型位置被引用 / 一处引用都没有 | 否，仅提示 / 计数 |
 *
 * `test-only` 与 `method-test-only` 的数量写进 `scripts/reachability-baseline.json`，
 * 语义是**上限 ratchet**：本次比基线多 → 失败并打印当前清单（新增项必须在里面）；比基线
 * 少 → 只提示可收紧到多少，**不写文件**。检查是只读的，跑一次门禁不该弄脏工作区；
 * 收紧要显式跑 `--update-baseline`，它只能在数量下降（或持平）时使用，不能放宽。基线只有
 * 两个数字，不是逐项白名单。
 *
 * 模块级 `type-only`（只被 `import type` 引用）与 `unreachable-importers`（引用方本身
 * 不可达）不直接失败，但在报告里列出；`types-only` 是纯类型模块，没有运行时内容。
 *
 * ## 抓不到的那一类（残余）
 *
 * - **字符串派发**：`phase('archive', ...)` 存在但对不上 `ASYNC_PHASES`。名字与字符串
 *   常量之间的对应关系不在模块/符号图里。
 * - **默认关闭的分支**：`config.retrieval.rerank.enabled` 为 `false` 时调用点还在，
 *   静态可达性证明不了它执行。
 * - **只取返回值不用副作用**：调用存在、返回值恒为空（增量回填那类）。
 * - **同名遮蔽与 `any`**：被 `any` / 断言截断的引用仍会被算作引用；调用点接收者类型
 *   丢失时只能退回结构匹配。
 * - **类型导出的接线**：`interface` / `type` 不产生运行时接线，不在目标集合里。
 * - **方法作为值传递**：`arr.map(svc.m)` / `void svc.m` 不是调用表达式，不算调用点，
 *   这类接线会被误报成 `method-no-caller`。
 * - **零引用的 const / enum**：`export const` / `export enum` 里既没被引用、也不是对象
 *   字面量方法的，只计数不列出——符号级 `no-reference` 不打印。
 *
 * 这些需要行为契约测试或全程序调用图，静态模块图给不出答案。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRODUCTION_ROOT = 'src';
const TEST_ROOT = 'tests';

export type SymbolKind = 'function' | 'class' | 'variable' | 'enum';

export type SymbolCategory =
  /** 只在 tests/ 里被值引用。 */
  | 'test-only'
  /** 只有定义文件自己引用：导出是多余的。 */
  | 'same-file-only'
  /** 有生产引用，但引用方都不在入口可达集合里。 */
  | 'unreachable-callers'
  /** 只在类型位置被引用（跨文件、生产）。 */
  | 'type-only'
  /** 一处引用都没有：只计数，不列清单。 */
  | 'no-reference'
  /** 在可达模块里被跨文件值引用。 */
  | 'reachable';

export type ModuleUnreachableReason =
  /** 没有任何值导入边指向它。 */
  | 'never-imported'
  /** 只有 import type / export type 指向它。 */
  | 'type-only'
  /** 有值导入边，但导入方本身不可达。 */
  | 'unreachable-importers'
  /** 纯类型模块（只有 interface / type / 类型导入），没有运行时内容。 */
  | 'types-only';

interface ReferenceCounts {
  readonly reachable: number;
  readonly unreachable: number;
  readonly sameFile: number;
  readonly test: number;
}

export interface SymbolRecord {
  /** 稳定标识：`相对路径#名字`。 */
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  /** 相对仓库根的路径，如 `src/services/memory-link.ts`。 */
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly category: SymbolCategory;
  /** 值位置的引用计数。 */
  readonly valueRefs: ReferenceCounts;
  /** 类型位置的引用计数。 */
  readonly typeRefs: ReferenceCounts;
  /** 一行证据：第一次引用的位置与说明。 */
  readonly evidence: string;
}

export interface ReachabilityEntry {
  readonly file: string;
  readonly line: number;
  /** 入口判断附近的代码（压成一行）。 */
  readonly evidence: string;
}

export interface ModuleRecord {
  readonly file: string;
  readonly reachable: boolean;
  readonly reason: ModuleUnreachableReason | null;
  /** 该文件里作为目标的导出值符号个数。 */
  readonly exportedSymbols: number;
}

export type MethodCategory =
  /** 可达生产里有调用点（直接调用或经由被调用的契约）。 */
  | 'reachable'
  /** 只有 tests/ 调用点。 */
  | 'method-test-only'
  /** 可达生产零调用点：真死代码。 */
  | 'method-no-caller'
  /** 被调用的契约实现（接口 / 类型字面量的方法在可达生产里有人调）。 */
  | 'contract'
  /** protected 方法，所属类在可达生产里有子类。 */
  | 'protected-inherited';

export interface MethodRecord {
  /** 稳定标识：`相对路径#类名.方法名`。 */
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  /** 相对仓库根的路径。 */
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly category: MethodCategory;
  /** 可达生产里的外部调用点数。 */
  readonly reachableCalls: number;
  /** 只在不可达生产模块里出现的调用点数。 */
  readonly unreachableCalls: number;
  /** tests/ 里的调用点数。 */
  readonly testCalls: number;
  /** 同类 / 同一对象内部的调用点数（不让方法变可达）。 */
  readonly internalCalls: number;
  /** 一行证据：第一次调用点的位置与说明。 */
  readonly evidence: string;
}

/** 可提交的基线：两个上限，不是逐项名单。 */
export interface BaselineCounts {
  /** 只被 tests/ 引用的导出符号数上限。 */
  readonly testOnly: number;
  /** 只被 tests/ 调用的成员方法数上限。 */
  readonly methodTestOnly: number;
}

export interface BaselineEvaluation {
  /** 超出上限的类别（本次 > 基线）。 */
  readonly exceeded: readonly {
    readonly key: keyof BaselineCounts;
    readonly actual: number;
    readonly limit: number;
  }[];
  /** 低于上限的类别（本次 < 基线）：基线应自动收紧。 */
  readonly tightened: readonly {
    readonly key: keyof BaselineCounts;
    readonly from: number;
    readonly to: number;
  }[];
  /** 收紧后的基线；`exceeded` 非空时保持原值。 */
  readonly next: BaselineCounts;
}

export interface ReachabilityResult {
  readonly entries: readonly ReachabilityEntry[];
  readonly modules: readonly ModuleRecord[];
  readonly symbols: readonly SymbolRecord[];
  /** 需要行动的分类：unreachable-callers / same-file-only。 */
  readonly issues: readonly SymbolRecord[];
  /** 成员方法级结果：全部目标，按文件 / 行排序。 */
  readonly methods: readonly MethodRecord[];
  /** 需要行动的成员方法：method-no-caller。 */
  readonly methodIssues: readonly MethodRecord[];
  /** 失败口径下的模块：运行时模块且没有任何值导入边。 */
  readonly moduleIssues: readonly ModuleRecord[];
  /** 值导入边与仅类型导入边的条数，用于报告口径。 */
  readonly edgeCounts: { readonly value: number; readonly typeOnly: number };
}

interface ProgramBundle {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly options: ts.CompilerOptions;
}

interface TargetInternal {
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly symbol: ts.Symbol;
  readonly declaration: ts.Node;
  readonly file: ts.SourceFile;
  readonly line: number;
}

interface ReferenceSite {
  readonly file: ts.SourceFile;
  readonly line: number;
  readonly node: ts.Node;
  readonly production: boolean;
  readonly inType: boolean;
  readonly moduleReachable: boolean;
}

interface MethodTargetInternal {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly symbol: ts.Symbol | undefined;
  readonly declaration: ts.MethodDeclaration;
  /** 类声明或对象字面量；内部调用的判定基准。 */
  readonly ownerDeclaration: ts.ClassDeclaration | ts.ObjectLiteralExpression;
  /** 导出类的实例类型；对象字面量用自身的类型。契约判定用。 */
  readonly instanceType: ts.Type | undefined;
  /** 类的 symbol，用于找子类；对象字面量为 undefined。 */
  readonly ownerSymbol: ts.Symbol | undefined;
  readonly protectedMember: boolean;
  readonly file: ts.SourceFile;
  readonly line: number;
  readonly moduleReachable: boolean;
}

interface MethodCallCounts {
  reachable: number;
  unreachable: number;
  test: number;
  internal: number;
}

interface MethodCallSite {
  readonly node: ts.Node;
  readonly file: ts.SourceFile;
  readonly production: boolean;
  readonly moduleReachable: boolean;
  readonly internal: boolean;
  /**
   * `contract`：经由接口 / 类型字面量接收者；`structural`：接收者 symbol 缺失后退回
   * 结构匹配；`override`：来自基类方法里的多态调用。
   */
  readonly via: 'direct' | 'contract' | 'structural' | 'override';
}

const BASELINE_PATH = 'scripts/reachability-baseline.json';

const FAILING_CATEGORIES: ReadonlySet<SymbolCategory> = new Set([
  'unreachable-callers',
  'same-file-only',
]);

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
  return files;
}

/**
 * 仓库根用 `tsconfig.json`（与 `tsc` 同一份文件集）；测试 fixture 没有 tsconfig 时
 * 显式列 `src/**` 与 `tests/**`，选项与仓库保持一致的最小集。
 *
 * 只做语法级 + 符号表：不调用 `getSemanticDiagnostics`，不展开泛型，几秒内跑完。
 */
function loadProgram(rootDir: string): ProgramBundle {
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const configFile = ts.readConfigFile(tsconfigPath, (path) => readFileSync(path, 'utf8'));
    if (configFile.error !== undefined) {
      fail(
        `读取 ${tsconfigPath} 失败：${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    return { program, checker: program.getTypeChecker(), options: parsed.options };
  }

  const rootNames = [
    ...collectSourceFiles(join(rootDir, PRODUCTION_ROOT)),
    ...collectSourceFiles(join(rootDir, TEST_ROOT)),
  ];
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram({ rootNames, options });
  return { program, checker: program.getTypeChecker(), options };
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function isExported(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

/** 声明名不是引用；`obj.foo` 的 `foo` 与 shorthand `{ foo }` 会走到引用分支。 */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!('name' in parent) || parent.name !== node) {
    return false;
  }
  return (
    ts.isFunctionDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isBindingElement(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  );
}

function scopeOf(rootDir: string, file: ts.SourceFile): string {
  return relative(rootDir, file.fileName).split(sep)[0] ?? '';
}

function locationOf(rootDir: string, node: ts.Node): { file: string; line: number } {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { file: relative(rootDir, sourceFile.fileName), line: line + 1 };
}

/** 值位置判定：任一祖先节点是 TypeNode 时，这个标识符出现在类型位置。 */
function inTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function withinDeclaration(node: ts.Node, declaration: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === declaration) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// ────────────────────────────── 入口识别 ──────────────────────────────

function isImportMetaUrl(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'url') {
    return false;
  }
  const target = node.expression;
  return (
    ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function mentionsPathToFileUrl(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(child) && child.text === 'pathToFileURL') {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * 入口判据：`import.meta.url` 与含 `pathToFileURL` 的表达式做 `===` / `!==` 比较。
 *
 * 只认这一种形态。`new URL('../../prompts/', import.meta.url)` 取自本模块路径，不是
 * 「作为入口执行」的判断；把它算成入口会让 `prompt-defaults.ts` 之类的库模块变成根。
 */
function entryGuardOf(file: ts.SourceFile): { line: number; text: string } | null {
  let result: { line: number; text: string } | null = null;
  const visit = (node: ts.Node): void => {
    if (result !== null) {
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const compared = isImportMetaUrl(node.left)
          ? node.right
          : isImportMetaUrl(node.right)
            ? node.left
            : undefined;
        if (compared !== undefined && mentionsPathToFileUrl(compared)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          result = { line: line + 1, text: node.getText(file).replace(/\s+/g, ' ') };
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

// ────────────────────────────── 模块图 ──────────────────────────────

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  // `import Foo, { type Bar }` 的默认导入是值。
  if (clause.name !== undefined) {
    return false;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) {
    return false;
  }
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    return (
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly)
    );
  }
  return false;
}

/**
 * 模块有没有运行时内容。
 *
 * 只有 `interface` / `type` / 类型导入 / 空语句的文件在编译后没有可执行代码，把它们
 * 报成「不可达模块」是噪音——类型导入本来就不产生运行时边。
 */
function hasRuntimeCode(file: ts.SourceFile): boolean {
  return file.statements.some((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      return false;
    }
    if (ts.isImportDeclaration(statement)) {
      return false;
    }
    if (ts.isExportDeclaration(statement)) {
      return !exportIsTypeOnly(statement);
    }
    if (ts.isEmptyStatement(statement)) {
      return false;
    }
    return true;
  });
}

function resolveModuleFile(
  bundle: ProgramBundle,
  fromFile: ts.SourceFile,
  specifier: ts.StringLiteralLike,
): ts.SourceFile | undefined {
  const symbol = bundle.checker.getSymbolAtLocation(specifier);
  const declaration = symbol?.declarations?.[0];
  if (declaration !== undefined) {
    const source = ts.isSourceFile(declaration)
      ? declaration
      : declaration.getSourceFile();
    if (source !== undefined) {
      return source;
    }
  }
  const resolved = ts.resolveModuleName(
    specifier.text,
    fromFile.fileName,
    bundle.options,
    ts.sys,
  ).resolvedModule;
  if (resolved === undefined) {
    return undefined;
  }
  return bundle.program.getSourceFile(resolved.resolvedFileName);
}

interface ModuleEdge {
  readonly target: ts.SourceFile;
  readonly typeOnly: boolean;
}

function collectModuleEdges(
  bundle: ProgramBundle,
  rootDir: string,
  file: ts.SourceFile,
): ModuleEdge[] {
  const edges: ModuleEdge[] = [];

  const add = (specifier: ts.StringLiteralLike, typeOnly: boolean): void => {
    const target = resolveModuleFile(bundle, file, specifier);
    if (target === undefined || target === file || target.isDeclarationFile) {
      return;
    }
    // 只保留生产目录与测试目录：外部包的类型声明不进图。
    const scope = scopeOf(rootDir, target);
    if (scope !== PRODUCTION_ROOT && scope !== TEST_ROOT) {
      return;
    }
    edges.push({ target, typeOnly });
  };

  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      add(statement.moduleSpecifier, importIsTypeOnly(statement));
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      add(statement.moduleSpecifier, exportIsTypeOnly(statement));
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      add(statement.moduleReference.expression, false);
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        add(argument, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return edges;
}

// ────────────────────────────── 目标与引用 ──────────────────────────────

function collectTargets(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
): TargetInternal[] {
  const targets: TargetInternal[] = [];
  const seenSymbols = new Set<ts.Symbol>();

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || scopeOf(rootDir, file) !== PRODUCTION_ROOT) {
      continue;
    }
    const relativeFile = relative(rootDir, file.fileName);
    // 入口模块自身的导出是根，不是待检查的目标。
    if (entryGuardOf(file) !== null) {
      continue;
    }

    const push = (
      nameNode: ts.Node,
      kind: SymbolKind,
      name: string,
      declaration: ts.Node,
    ): void => {
      const found = checker.getSymbolAtLocation(nameNode);
      if (found === undefined) {
        return;
      }
      const symbol = resolveAlias(checker, found);
      if (seenSymbols.has(symbol)) {
        return;
      }
      seenSymbols.add(symbol);
      const { line } = file.getLineAndCharacterOfPosition(declaration.getStart());
      targets.push({
        id: `${relativeFile}#${name}`,
        name,
        kind,
        symbol,
        declaration,
        file,
        line: line + 1,
      });
    };

    for (const statement of file.statements) {
      if (!isExported(statement)) {
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        push(statement.name, 'function', statement.name.text, statement);
        continue;
      }
      if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        push(statement.name, 'class', statement.name.text, statement);
        continue;
      }
      if (ts.isEnumDeclaration(statement)) {
        push(statement.name, 'enum', statement.name.text, statement);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue;
          }
          push(declaration.name, 'variable', declaration.name.text, declaration);
        }
      }
    }
  }

  return targets;
}

/**
 * 引用索引按**声明节点**记账，不按 symbol 对象。
 *
 * `checker.getSymbolAtLocation(propertyAccess.name)` 对属性访问可能返回带 `Transient`
 * 标志的 symbol 副本，它和声明处的 symbol 不是同一个对象。声明节点是同一棵 AST 上的
 * 同一个对象；再补一层 `targetBySymbol` 覆盖直接导入的常见路径。
 */
function buildReferenceIndex(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
  targets: readonly TargetInternal[],
  moduleReachable: ReadonlySet<ts.SourceFile>,
): Map<ts.Node, ReferenceSite[]> {
  const index = new Map<ts.Node, ReferenceSite[]>();
  const targetBySymbol = new Map<ts.Symbol, TargetInternal>();
  const declarationToTarget = new Map<ts.Node, TargetInternal>();

  const register = (target: TargetInternal, declaration: ts.Node): void => {
    if (!declarationToTarget.has(declaration)) {
      declarationToTarget.set(declaration, target);
    }
  };

  for (const target of targets) {
    targetBySymbol.set(target.symbol, target);
    for (const declaration of target.symbol.declarations ?? []) {
      register(target, declaration);
    }
  }

  // 重导出 / 桶文件的 specifier 也可能成为引用符号的声明节点。
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isExportSpecifier(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportClause(node)
      ) {
        const nameNode = node.name;
        if (nameNode !== undefined) {
          const found = checker.getSymbolAtLocation(nameNode);
          if (found !== undefined) {
            const resolved = resolveAlias(checker, found);
            const target = targetBySymbol.get(resolved);
            if (target !== undefined) {
              register(target, node);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const seenSites = new Map<ts.Node, Set<ts.Node>>();

  const record = (target: TargetInternal, site: ReferenceSite): void => {
    let nodes = seenSites.get(target.declaration);
    if (nodes === undefined) {
      nodes = new Set();
      seenSites.set(target.declaration, nodes);
    }
    if (nodes.has(site.node)) {
      return;
    }
    nodes.add(site.node);
    const sites = index.get(target.declaration);
    if (sites === undefined) {
      index.set(target.declaration, [site]);
    } else {
      sites.push(site);
    }
  };

  const recordSymbol = (symbol: ts.Symbol | undefined, site: ReferenceSite): void => {
    if (symbol === undefined) {
      return;
    }
    const resolved = resolveAlias(checker, symbol);
    const direct = targetBySymbol.get(resolved);
    if (direct !== undefined) {
      record(direct, site);
    }
    for (const declaration of resolved.declarations ?? []) {
      const target = declarationToTarget.get(declaration);
      if (target !== undefined) {
        record(target, site);
      }
    }
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) {
      continue;
    }
    const scope = scopeOf(rootDir, file);
    if (scope !== PRODUCTION_ROOT && scope !== TEST_ROOT) {
      continue;
    }
    const production = scope === PRODUCTION_ROOT;
    const reachable = moduleReachable.has(file);

    const visit = (node: ts.Node): void => {
      // import / export 声明是别名，不是使用；真正的使用由别名解析后的引用记账。
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node) ||
        ts.isImportEqualsDeclaration(node)
      ) {
        return;
      }
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        recordSymbol(checker.getSymbolAtLocation(node), {
          file,
          line: line + 1,
          node,
          production,
          inType: inTypePosition(node),
          moduleReachable: reachable,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return index;
}

// ────────────────────────────── 成员方法级 ──────────────────────────────

function isPrivateMethod(member: ts.MethodDeclaration): boolean {
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) {
    return true;
  }
  return hasModifier(member, ts.SyntaxKind.PrivateKeyword);
}


/**
 * 收集成员方法目标。
 *
 * 目标文件覆盖全部 `src/**`（入口模块除外），不要求所属模块可达：模块不可达时
 * 方法本来就没有可达调用点，把它报成 `method-no-caller` 与「整条链没接上」是同一个
 * 事实；模块级清单负责给出根因。
 */
function collectMethodTargets(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
  entryFiles: ReadonlySet<ts.SourceFile>,
  moduleReachable: ReadonlySet<ts.SourceFile>,
): MethodTargetInternal[] {
  const targets: MethodTargetInternal[] = [];
  const seenSymbols = new Set<ts.Symbol>();
  const seenDeclarations = new Set<ts.Node>();

  const push = (
    member: ts.MethodDeclaration,
    owner: string,
    nameNode: ts.Identifier | ts.StringLiteral,
    ownerDeclaration: ts.ClassDeclaration | ts.ObjectLiteralExpression,
    instanceType: ts.Type | undefined,
    ownerSymbol: ts.Symbol | undefined,
    protectedMember: boolean,
    file: ts.SourceFile,
  ): void => {
    const name = nameNode.text;
    const symbol = checker.getSymbolAtLocation(nameNode);
    if (symbol !== undefined) {
      if (seenSymbols.has(symbol)) {
        return;
      }
      seenSymbols.add(symbol);
    } else {
      if (seenDeclarations.has(member)) {
        return;
      }
      seenDeclarations.add(member);
    }
    const { line } = file.getLineAndCharacterOfPosition(member.getStart());
    targets.push({
      id: `${relative(rootDir, file.fileName)}#${owner}.${name}`,
      owner,
      name,
      symbol,
      declaration: member,
      ownerDeclaration,
      instanceType,
      ownerSymbol,
      protectedMember,
      file,
      line: line + 1,
      moduleReachable: moduleReachable.has(file),
    });
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || scopeOf(rootDir, file) !== PRODUCTION_ROOT) {
      continue;
    }
    if (entryFiles.has(file)) {
      continue;
    }

    for (const statement of file.statements) {
      if (!isExported(statement)) {
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        const classSymbol = checker.getSymbolAtLocation(statement.name);
        const instanceType =
          classSymbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(classSymbol);
        for (const member of statement.members) {
          // 无实现的方法（abstract / 重载签名）不是运行时目标：抽象声明是契约面，
          // 具体实现单独收集；重载由带实现的那一条承担。
          if (!ts.isMethodDeclaration(member) || member.body === undefined) {
            continue;
          }
          if (isPrivateMethod(member)) {
            continue;
          }
          const nameNode = member.name;
          if (nameNode === undefined) {
            continue;
          }
          if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) {
            continue;
          }
          push(
            member,
            statement.name.text,
            nameNode,
            statement,
            instanceType,
            classSymbol,
            hasModifier(member, ts.SyntaxKind.ProtectedKeyword),
            file,
          );
        }
        continue;
      }

      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.initializer === undefined ||
          !ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          continue;
        }
        const ownerName = declaration.name.text;
        const objectType = checker.getTypeAtLocation(declaration.initializer);
        for (const member of declaration.initializer.properties) {
          if (!ts.isMethodDeclaration(member) || member.body === undefined) {
            continue;
          }
          const nameNode = member.name;
          if (nameNode === undefined) {
            continue;
          }
          if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) {
            continue;
          }
          push(
            member,
            ownerName,
            nameNode,
            declaration.initializer,
            objectType,
            undefined,
            false,
            file,
          );
        }
      }
    }
  }

  return targets;
}

function nearestClassDeclaration(node: ts.Node): ts.ClassDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function nearestObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isObjectLiteralExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** protected 方法所属类在可达生产里的子类。`extends` 的表达式解析到基类符号。 */
function collectReachableSubclassSymbols(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
  moduleReachable: ReadonlySet<ts.SourceFile>,
): Set<ts.Symbol> {
  const subclasses = new Set<ts.Symbol>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || scopeOf(rootDir, file) !== PRODUCTION_ROOT) {
      continue;
    }
    if (!moduleReachable.has(file)) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.heritageClauses !== undefined) {
        for (const clause of node.heritageClauses) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
            continue;
          }
          for (const heritageType of clause.types) {
            const found = checker.getSymbolAtLocation(heritageType.expression);
            if (found !== undefined) {
              subclasses.add(resolveAlias(checker, found));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return subclasses;
}

/** 类 symbol → 直接基类 symbol。用于把基类里的多态调用记到子类覆写上。 */
function collectBaseClassSymbols(
  checker: ts.TypeChecker,
  program: ts.Program,
  rootDir: string,
): Map<ts.Symbol, ts.Symbol> {
  const bases = new Map<ts.Symbol, ts.Symbol>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || scopeOf(rootDir, file) !== PRODUCTION_ROOT) {
      continue;
    }
    for (const statement of file.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined) {
        continue;
      }
      const classSymbol = checker.getSymbolAtLocation(statement.name);
      if (classSymbol === undefined) {
        continue;
      }
      for (const clause of statement.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
          continue;
        }
        const heritageType = clause.types[0];
        if (heritageType === undefined) {
          continue;
        }
        const baseSymbol = checker.getSymbolAtLocation(heritageType.expression);
        if (baseSymbol !== undefined) {
          bases.set(resolveAlias(checker, classSymbol), resolveAlias(checker, baseSymbol));
        }
      }
    }
  }
  return bases;
}

function isSubclassOf(
  symbol: ts.Symbol,
  base: ts.Symbol,
  bases: ReadonlyMap<ts.Symbol, ts.Symbol>,
): boolean {
  const seen = new Set<ts.Symbol>();
  let current = bases.get(symbol);
  while (current !== undefined && !seen.has(current)) {
    if (current === base) {
      return true;
    }
    seen.add(current);
    current = bases.get(current);
  }
  return false;
}

/**
 * 调用点索引。
 *
 * 直接调用按 symbol 解析到目标声明；解析不到目标时，只有接收者是接口 / 类型字面量
 * （symbol 声明是 `MethodSignature`）或完全无 symbol 的情况下，才按「同名 + 实例类型
 * 可赋值给接收者类型」把调用记账到实现类。这样 `port.greet()` 能接上
 * `GreetingPortImpl.greet`，而 `other.save()` 不会被结构类型误算成另一个类的 `save`。
 */
function buildMethodCallIndex(
  checker: ts.TypeChecker,
  program: ts.Program,
  rootDir: string,
  targets: readonly MethodTargetInternal[],
  moduleReachable: ReadonlySet<ts.SourceFile>,
  baseClassBySymbol: ReadonlyMap<ts.Symbol, ts.Symbol>,
): Map<ts.Node, MethodCallSite[]> {
  const index = new Map<ts.Node, MethodCallSite[]>();
  const seenSites = new Map<ts.Node, Set<ts.Node>>();
  const byDeclaration = new Map<ts.Node, MethodTargetInternal>();
  const bySymbol = new Map<ts.Symbol, MethodTargetInternal[]>();
  const byName = new Map<string, MethodTargetInternal[]>();

  for (const target of targets) {
    byDeclaration.set(target.declaration, target);
    if (target.symbol !== undefined) {
      const list = bySymbol.get(target.symbol);
      if (list === undefined) {
        bySymbol.set(target.symbol, [target]);
      } else {
        list.push(target);
      }
    }
    const named = byName.get(target.name);
    if (named === undefined) {
      byName.set(target.name, [target]);
    } else {
      named.push(target);
    }
  }

  const record = (target: MethodTargetInternal, site: MethodCallSite): void => {
    let nodes = seenSites.get(target.declaration);
    if (nodes === undefined) {
      nodes = new Set();
      seenSites.set(target.declaration, nodes);
    }
    if (nodes.has(site.node)) {
      return;
    }
    nodes.add(site.node);
    const sites = index.get(target.declaration);
    if (sites === undefined) {
      index.set(target.declaration, [site]);
    } else {
      sites.push(site);
    }
  };

  const isInternal = (target: MethodTargetInternal, node: ts.Node): boolean => {
    if (ts.isClassDeclaration(target.ownerDeclaration)) {
      return nearestClassDeclaration(node) === target.ownerDeclaration;
    }
    return nearestObjectLiteral(node) === target.ownerDeclaration;
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) {
      continue;
    }
    const scope = scopeOf(rootDir, file);
    if (scope !== PRODUCTION_ROOT && scope !== TEST_ROOT) {
      continue;
    }
    const production = scope === PRODUCTION_ROOT;
    const reachable = production && moduleReachable.has(file);

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node) ||
        ts.isImportEqualsDeclaration(node)
      ) {
        return;
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
          const memberName = callee.name.text;
          const found = checker.getSymbolAtLocation(callee.name);
          const resolved = found === undefined ? undefined : resolveAlias(checker, found);

          const direct = new Set<MethodTargetInternal>();
          const overridden = new Set<MethodTargetInternal>();
          if (resolved !== undefined) {
            for (const candidate of bySymbol.get(resolved) ?? []) {
              direct.add(candidate);
            }
            for (const declaration of resolved.declarations ?? []) {
              const candidate = byDeclaration.get(declaration);
              if (candidate !== undefined) {
                direct.add(candidate);
                continue;
              }
              // 基类里的多态调用（`this.parseLine()`）：把调用记到子类覆写上。
              if (!ts.isMethodDeclaration(declaration)) {
                continue;
              }
              const classDeclaration = declaration.parent;
              if (
                !ts.isClassDeclaration(classDeclaration) ||
                classDeclaration.name === undefined
              ) {
                continue;
              }
              const ownerSymbol = checker.getSymbolAtLocation(classDeclaration.name);
              if (ownerSymbol === undefined) {
                continue;
              }
              const base = resolveAlias(checker, ownerSymbol);
              for (const target of byName.get(memberName) ?? []) {
                if (
                  target.ownerSymbol === undefined ||
                  target.ownerSymbol === base ||
                  !isSubclassOf(target.ownerSymbol, base, baseClassBySymbol)
                ) {
                  continue;
                }
                overridden.add(target);
              }
            }
          }

          const siteFor = (
            target: MethodTargetInternal,
            via: 'direct' | 'contract' | 'structural' | 'override',
          ): MethodCallSite => ({
            node,
            file,
            production,
            moduleReachable: reachable,
            internal: isInternal(target, node),
            via,
          });

          for (const target of direct) {
            record(target, siteFor(target, 'direct'));
          }
          for (const target of overridden) {
            record(target, siteFor(target, 'override'));
          }

          const resolvedIsContract =
            resolved === undefined ||
            (resolved.declarations ?? []).some((declaration) => ts.isMethodSignature(declaration));
          if (direct.size === 0 && resolvedIsContract) {
            const receiverType = checker.getTypeAtLocation(callee.expression);
            const flags = receiverType.flags;
            if (
              (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) === 0 &&
              (flags & ts.TypeFlags.Object) !== 0
            ) {
              const properties = checker.getPropertiesOfType(receiverType);
              const structural =
                resolved === undefined
                  ? properties.length > 0 &&
                    properties.every(
                      (property) => (property.flags & ts.SymbolFlags.Method) !== 0,
                    )
                  : true;
              if (structural) {
                for (const target of byName.get(memberName) ?? []) {
                  if (target.instanceType === undefined) {
                    continue;
                  }
                  if (!checker.isTypeAssignableTo(target.instanceType, receiverType)) {
                    continue;
                  }
                  record(
                    target,
                    siteFor(target, resolved === undefined ? 'structural' : 'contract'),
                  );
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return index;
}

function emptyMethodCounts(): MethodCallCounts {
  return { reachable: 0, unreachable: 0, test: 0, internal: 0 };
}

function classifyMethods(
  rootDir: string,
  targets: readonly MethodTargetInternal[],
  callIndex: Map<ts.Node, MethodCallSite[]>,
  subclasses: ReadonlySet<ts.Symbol>,
): MethodRecord[] {
  return targets
    .map((target): MethodRecord => {
      const counts = emptyMethodCounts();
      const firstSite = new Map<string, string>();
      let contractCall = false;

      for (const site of callIndex.get(target.declaration) ?? []) {
        const bucket = !site.production
          ? 'test'
          : !site.moduleReachable
            ? 'unreachable'
            : site.internal
              ? 'internal'
              : 'reachable';
        counts[bucket] += 1;
        if (bucket === 'reachable' && (site.via === 'contract' || site.via === 'structural')) {
          contractCall = true;
        }
        if (!firstSite.has(bucket)) {
          const { file, line } = locationOf(rootDir, site.node);
          const viaLabel =
            site.via === 'contract'
              ? '（契约调用）'
              : site.via === 'structural'
                ? '（结构匹配）'
                : site.via === 'override'
                  ? '（基类调用）'
                  : '';
          firstSite.set(bucket, `${file}:${String(line)}${viaLabel}`);
        }
      }

      let category: MethodCategory;
      if (counts.reachable > 0) {
        category = contractCall ? 'contract' : 'reachable';
      } else if (
        target.protectedMember &&
        target.ownerSymbol !== undefined &&
        subclasses.has(target.ownerSymbol)
      ) {
        category = 'protected-inherited';
      } else if (counts.test > 0) {
        category = 'method-test-only';
      } else {
        category = 'method-no-caller';
      }

      return {
        id: target.id,
        owner: target.owner,
        name: target.name,
        file: relative(rootDir, target.file.fileName),
        line: target.line,
        category,
        reachableCalls: counts.reachable,
        unreachableCalls: counts.unreachable,
        testCalls: counts.test,
        internalCalls: counts.internal,
        evidence: describeMethodEvidence(category, counts, firstSite),
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function describeMethodEvidence(
  category: MethodCategory,
  counts: MethodCallCounts,
  firstSite: ReadonlyMap<string, string>,
): string {
  const site = (bucket: string): string => firstSite.get(bucket) ?? '—';
  switch (category) {
    case 'reachable':
      return `生产调用 ${String(counts.reachable)} 处（首处 ${site('reachable')}）`;
    case 'contract':
      return `契约调用 ${String(counts.reachable)} 处（首处 ${site('reachable')}）`;
    case 'protected-inherited':
      return 'protected，所属类在可达生产里有子类';
    case 'method-test-only':
      return `仅 tests/ 调用 ${String(counts.test)} 处（首处 ${site('test')}）`;
    case 'method-no-caller':
      if (counts.unreachable > 0) {
        return `调用点 ${String(counts.unreachable)} 处，但所在模块不可达（首处 ${site('unreachable')}）`;
      }
      if (counts.internal > 0) {
        return `只有同类内部调用 ${String(counts.internal)} 处（首处 ${site('internal')}）`;
      }
      return '生产零调用点';
  }
}

// ────────────────────────────── 分类与报告 ──────────────────────────────

interface MutableCounts {
  reachable: number;
  unreachable: number;
  sameFile: number;
  test: number;
}

function emptyCounts(): MutableCounts {
  return { reachable: 0, unreachable: 0, sameFile: 0, test: 0 };
}

function classify(
  rootDir: string,
  target: TargetInternal,
  referenceIndex: Map<ts.Node, ReferenceSite[]>,
): SymbolRecord {
  const valueRefs = emptyCounts();
  const typeRefs = emptyCounts();
  const firstSite = new Map<string, string>();

  const remember = (
    kind: 'value' | 'type',
    bucket: string,
    site: ReferenceSite,
  ): void => {
    const key = `${kind}:${bucket}`;
    if (firstSite.has(key)) {
      return;
    }
    const { file, line } = locationOf(rootDir, site.node);
    firstSite.set(key, `${file}:${String(line)}`);
  };

  for (const site of referenceIndex.get(target.declaration) ?? []) {
    // 定义处（含函数/方法自己的递归调用）不算引用。
    if (withinDeclaration(site.node, target.declaration)) {
      continue;
    }
    const kind = site.inType ? 'type' : 'value';
    const counters = site.inType ? typeRefs : valueRefs;
    if (!site.production) {
      counters.test += 1;
      remember(kind, 'test', site);
      continue;
    }
    if (site.file === target.file) {
      counters.sameFile += 1;
      remember(kind, 'sameFile', site);
      continue;
    }
    if (site.moduleReachable) {
      counters.reachable += 1;
      remember(kind, 'reachable', site);
      continue;
    }
    counters.unreachable += 1;
    remember(kind, 'unreachable', site);
  }

  const category: SymbolCategory =
    valueRefs.reachable > 0
      ? 'reachable'
      : valueRefs.unreachable > 0
        ? 'unreachable-callers'
        : valueRefs.test > 0
          ? 'test-only'
          : typeRefs.reachable > 0 || typeRefs.unreachable > 0
            ? 'type-only'
            : valueRefs.sameFile > 0
              ? 'same-file-only'
              : typeRefs.sameFile > 0 || typeRefs.test > 0
                ? 'type-only'
                : 'no-reference';

  const evidence = describeEvidence(category, valueRefs, typeRefs, firstSite);

  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    file: relative(rootDir, target.file.fileName),
    line: target.line,
    category,
    valueRefs,
    typeRefs,
    evidence,
  };
}

function describeEvidence(
  category: SymbolCategory,
  valueRefs: ReferenceCounts,
  typeRefs: ReferenceCounts,
  firstSite: ReadonlyMap<string, string>,
): string {
  const site = (kind: 'value' | 'type', bucket: string): string =>
    firstSite.get(`${kind}:${bucket}`) ?? '—';
  switch (category) {
    case 'reachable':
      return `${site('value', 'reachable')}（跨文件值引用 ${String(valueRefs.reachable)} 处）`;
    case 'unreachable-callers':
      return `${site('value', 'unreachable')} 引用，但该模块不在任何入口上（值引用 ${String(
        valueRefs.unreachable,
      )} 处）`;
    case 'test-only':
      if (valueRefs.sameFile > 0) {
        return `生产只有同文件引用 ${String(valueRefs.sameFile)} 处；另被 tests/ 引用 ${String(
          valueRefs.test,
        )} 处（首处 ${site('value', 'test')}）`;
      }
      return `仅 tests/ 引用：${site('value', 'test')}（值引用 ${String(
        valueRefs.test,
      )} 处）`;
    case 'same-file-only':
      return `仅同文件引用 ${String(valueRefs.sameFile)} 处（首处 ${site(
        'value',
        'sameFile',
      )}），无跨文件值引用`;
    case 'type-only': {
      const where =
        firstSite.get('type:reachable') ??
        firstSite.get('type:unreachable') ??
        firstSite.get('type:sameFile') ??
        firstSite.get('type:test') ??
        '—';
      return `仅类型位置引用（可达 ${String(typeRefs.reachable)} / 不可达 ${String(
        typeRefs.unreachable,
      )} / 同文件 ${String(typeRefs.sameFile)} / 测试 ${String(typeRefs.test)} 处，首处 ${where}）`;
    }
    case 'no-reference':
      return '没有任何引用';
  }
}

/**
 * 分析一个项目根（仓库根，或测试 fixture 根），不算清单、不打印。
 *
 * 返回值里的 `issues` 只包含需要行动的三类；`type-only` 与 `no-reference` 在
 * `symbols` 里可查，但不进 `issues`。
 */
export function analyzeReachability(rootDir: string): ReachabilityResult {
  const bundle = loadProgram(rootDir);
  const { program, checker } = bundle;

  const productionFiles: ts.SourceFile[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || scopeOf(rootDir, file) !== PRODUCTION_ROOT) {
      continue;
    }
    productionFiles.push(file);
  }

  const entries: ReachabilityEntry[] = [];
  const entryFiles = new Set<ts.SourceFile>();
  for (const file of productionFiles) {
    const guard = entryGuardOf(file);
    if (guard === null) {
      continue;
    }
    entryFiles.add(file);
    entries.push({
      file: relative(rootDir, file.fileName),
      line: guard.line,
      evidence: guard.text,
    });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));

  // ── 模块图：值边与仅类型边分开记 ──
  const valueEdges = new Map<ts.SourceFile, ts.SourceFile[]>();
  const valueImporters = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  const typeOnlyImporters = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  let valueEdgeCount = 0;
  let typeOnlyEdgeCount = 0;

  const addImporter = (
    map: Map<ts.SourceFile, Set<ts.SourceFile>>,
    target: ts.SourceFile,
    importer: ts.SourceFile,
  ): void => {
    let set = map.get(target);
    if (set === undefined) {
      set = new Set();
      map.set(target, set);
    }
    set.add(importer);
  };

  for (const file of productionFiles) {
    const edges = collectModuleEdges(bundle, rootDir, file);
    const values: ts.SourceFile[] = [];
    for (const edge of edges) {
      if (edge.typeOnly) {
        addImporter(typeOnlyImporters, edge.target, file);
        typeOnlyEdgeCount += 1;
      } else {
        values.push(edge.target);
        addImporter(valueImporters, edge.target, file);
        valueEdgeCount += 1;
      }
    }
    valueEdges.set(file, values);
  }

  const reachableModules = new Set<ts.SourceFile>();
  const queue = [...entryFiles];
  for (const entry of queue) {
    reachableModules.add(entry);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const target of valueEdges.get(current) ?? []) {
      if (reachableModules.has(target)) {
        continue;
      }
      reachableModules.add(target);
      queue.push(target);
    }
  }

  // ── 目标与引用 ──
  const targets = collectTargets(rootDir, checker, program);
  const referenceIndex = buildReferenceIndex(
    rootDir,
    checker,
    program,
    targets,
    reachableModules,
  );
  const symbols = targets
    .map((target) => classify(rootDir, target, referenceIndex))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  // ── 模块记录 ──
  const exportedPerFile = new Map<string, number>();
  for (const symbol of symbols) {
    exportedPerFile.set(symbol.file, (exportedPerFile.get(symbol.file) ?? 0) + 1);
  }

  const modules: ModuleRecord[] = productionFiles
    .map((file): ModuleRecord => {
      const relativeFile = relative(rootDir, file.fileName);
      if (reachableModules.has(file)) {
        return {
          file: relativeFile,
          reachable: true,
          reason: null,
          exportedSymbols: exportedPerFile.get(relativeFile) ?? 0,
        };
      }
      const value = valueImporters.get(file);
      const typeOnly = typeOnlyImporters.get(file);
      let reason: ModuleUnreachableReason;
      if (!hasRuntimeCode(file)) {
        reason = 'types-only';
      } else if (value !== undefined && value.size > 0) {
        reason = 'unreachable-importers';
      } else if (typeOnly !== undefined && typeOnly.size > 0) {
        reason = 'type-only';
      } else {
        reason = 'never-imported';
      }
      return {
        file: relativeFile,
        reachable: false,
        reason,
        exportedSymbols: exportedPerFile.get(relativeFile) ?? 0,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));

  // ── 成员方法 ──
  const methodTargets = collectMethodTargets(
    rootDir,
    checker,
    program,
    entryFiles,
    reachableModules,
  );
  const baseClassBySymbol = collectBaseClassSymbols(checker, program, rootDir);
  const methodCallIndex = buildMethodCallIndex(
    checker,
    program,
    rootDir,
    methodTargets,
    reachableModules,
    baseClassBySymbol,
  );
  const subclasses = collectReachableSubclassSymbols(rootDir, checker, program, reachableModules);
  const methods = classifyMethods(rootDir, methodTargets, methodCallIndex, subclasses);

  const issues = symbols.filter((symbol) => FAILING_CATEGORIES.has(symbol.category));
  const methodIssues = methods.filter((method) => method.category === 'method-no-caller');
  const moduleIssues = modules.filter(
    (module) => !module.reachable && module.reason === 'never-imported',
  );

  return {
    entries,
    modules,
    symbols,
    issues,
    methods,
    methodIssues,
    moduleIssues,
    edgeCounts: { value: valueEdgeCount, typeOnly: typeOnlyEdgeCount },
  };
}

// ────────────────────────────── 基线 ratchet ──────────────────────────────

export function compareBaseline(
  actual: BaselineCounts,
  baseline: BaselineCounts,
): BaselineEvaluation {
  const exceeded: {
    key: keyof BaselineCounts;
    actual: number;
    limit: number;
  }[] = [];
  const tightened: {
    key: keyof BaselineCounts;
    from: number;
    to: number;
  }[] = [];
  const next: { testOnly: number; methodTestOnly: number } = {
    testOnly: baseline.testOnly,
    methodTestOnly: baseline.methodTestOnly,
  };

  const keys: readonly (keyof BaselineCounts)[] = ['testOnly', 'methodTestOnly'];
  for (const key of keys) {
    const current = actual[key];
    const limit = baseline[key];
    if (current > limit) {
      exceeded.push({ key, actual: current, limit });
      continue;
    }
    if (current < limit) {
      tightened.push({ key, from: limit, to: current });
      next[key] = current;
    }
  }

  return { exceeded, tightened, next };
}

function readBaseline(rootDir: string): BaselineCounts | null {
  const path = join(rootDir, BASELINE_PATH);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    fail(`${path} 必须是 JSON 对象，形如 {"testOnly": 42, "methodTestOnly": 12}`);
  }
  const record = parsed as Record<string, unknown>;
  const readCount = (key: keyof BaselineCounts): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail(`${path} 的 ${key} 必须是非负整数（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  };
  return { testOnly: readCount('testOnly'), methodTestOnly: readCount('methodTestOnly') };
}

function writeBaseline(rootDir: string, counts: BaselineCounts): void {
  const path = join(rootDir, BASELINE_PATH);
  const body = {
    testOnly: counts.testOnly,
    methodTestOnly: counts.methodTestOnly,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function baselineKeysLabel(key: keyof BaselineCounts): string {
  return key === 'testOnly' ? 'test-only' : 'method-test-only';
}

// ────────────────────────────── 输出 ──────────────────────────────

function categoryLabel(category: SymbolCategory): string {
  switch (category) {
    case 'unreachable-callers':
      return '调用链不在入口上';
    case 'test-only':
      return '只被测试引用';
    case 'same-file-only':
      return '只被同文件引用';
    case 'type-only':
      return '仅类型位置引用';
    case 'no-reference':
      return '零引用';
    case 'reachable':
      return '可达';
  }
}

function methodCategoryLabel(category: MethodCategory): string {
  switch (category) {
    case 'reachable':
      return '可达';
    case 'contract':
      return '契约调用';
    case 'protected-inherited':
      return 'protected / 有子类';
    case 'method-test-only':
      return '只被测试调用';
    case 'method-no-caller':
      return '生产零调用';
  }
}

function moduleReasonLabel(reason: ModuleUnreachableReason): string {
  switch (reason) {
    case 'never-imported':
      return '没有任何模块引用';
    case 'type-only':
      return '只被 import type 引用';
    case 'unreachable-importers':
      return '引用方本身不可达';
    case 'types-only':
      return '纯类型模块，无运行时代码';
  }
}

function actualBaselineCounts(result: ReachabilityResult): BaselineCounts {
  return {
    testOnly: result.symbols.filter((symbol) => symbol.category === 'test-only').length,
    methodTestOnly: result.methods.filter((method) => method.category === 'method-test-only')
      .length,
  };
}

/** 基线超出时打印当前这一类清单：新增项一定在里面。 */
function baselineNames(result: ReachabilityResult, key: keyof BaselineCounts): string[] {
  if (key === 'testOnly') {
    return result.symbols
      .filter((symbol) => symbol.category === 'test-only')
      .map((symbol) => `${symbol.file}:${String(symbol.line)}  ${symbol.name}`);
  }
  return result.methods
    .filter((method) => method.category === 'method-test-only')
    .map(
      (method) =>
        `${method.file}:${String(method.line)}  ${method.owner}.${method.name}  ${method.evidence}`,
    );
}

function main(): void {
  const rootDir = REPO_ROOT;
  const result = analyzeReachability(rootDir);

  if (result.entries.length === 0) {
    fail(
      '没有识别到入口：src/ 内找不到 `import.meta.url === pathToFileURL(...)` 形态的判断。\n' +
        '如果入口形态变了（例如改成 `process.argv[1].endsWith(...)`），先更新 check-reachability 的入口判据。',
    );
  }

  const actual = actualBaselineCounts(result);
  const updateBaseline = process.argv.includes('--update-baseline');

  if (updateBaseline) {
    const baseline = readBaseline(rootDir);
    if (baseline === null) {
      writeBaseline(rootDir, actual);
      process.stdout.write(
        `基线文件不存在，已按当前数量创建：test-only ${String(actual.testOnly)}，` +
          `method-test-only ${String(actual.methodTestOnly)}\n`,
      );
      process.exit(0);
    }
    const evaluation = compareBaseline(actual, baseline);
    if (evaluation.exceeded.length > 0) {
      for (const item of evaluation.exceeded) {
        process.stderr.write(
          `${baselineKeysLabel(item.key)} ${String(item.actual)} > 基线 ${String(item.limit)}：` +
            '--update-baseline 只能收紧，不能放宽。\n',
        );
      }
      fail('拒绝写入基线：本次数量高于现有上限。先把新增项解释清楚或清理掉。');
    }
    writeBaseline(rootDir, evaluation.next);
    const change = evaluation.tightened
      .map(
        (item) =>
          `${baselineKeysLabel(item.key)} ${String(item.from)} → ${String(item.to)}`,
      )
      .join('，');
    process.stdout.write(
      change.length > 0 ? `基线已收紧：${change}\n` : '基线未变化\n',
    );
    process.exit(0);
  }

  const baseline = readBaseline(rootDir);
  if (baseline === null) {
    fail(
      `缺少 ${BASELINE_PATH}。首次建立基线请运行：pnpm check:reachability --update-baseline`,
    );
  }
  const evaluation = compareBaseline(actual, baseline);

  const out: string[] = [];
  const unreachableModules = result.modules.filter((module) => !module.reachable);
  const typesOnlyModules = unreachableModules.filter((module) => module.reason === 'types-only');
  const runtimeUnreachable = unreachableModules.filter((module) => module.reason !== 'types-only');

  out.push(
    `入口 ${String(result.entries.length)} 个（判据：src/ 内 \`import.meta.url === pathToFileURL(...)\` 比较）`,
  );
  for (const entry of result.entries) {
    out.push(`  ${entry.file}:${String(entry.line)}  ${entry.evidence}`);
  }
  out.push('  web/ 不作为入口：独立构建、独立 tsconfig，不 import src/（控制台只走 HTTP）。');

  out.push('');
  out.push(
    `模块 ${String(result.modules.length)} 个（src/），入口可达 ${String(
      result.modules.length - unreachableModules.length,
    )} 个，运行时不可达 ${String(runtimeUnreachable.length)} 个` +
      `（另有纯类型模块 ${String(typesOnlyModules.length)} 个，没有运行时代码）`,
  );
  out.push(
    `导入边：值 ${String(result.edgeCounts.value)} 条，仅类型 ${String(
      result.edgeCounts.typeOnly,
    )} 条（仅类型边在 verbatimModuleSyntax 下被擦除，不算可达）`,
  );

  if (runtimeUnreachable.length > 0) {
    out.push('');
    out.push('── 不可达模块（这些文件里的导出符号全部无法从入口到达）──');
    for (const module of runtimeUnreachable) {
      const reason = module.reason === null ? '不可达' : moduleReasonLabel(module.reason);
      const failing = module.reason === 'never-imported';
      out.push(
        `  ${module.file}  [${reason}]  导出值符号 ${String(module.exportedSymbols)} 个` +
          (failing ? '  ← 失败' : ''),
      );
    }
  }

  const groups = new Map<string, SymbolRecord[]>();
  for (const issue of result.issues) {
    const list = groups.get(issue.file);
    if (list === undefined) {
      groups.set(issue.file, [issue]);
    } else {
      list.push(issue);
    }
  }

  const countBy = (category: SymbolCategory): number =>
    result.symbols.filter((symbol) => symbol.category === category).length;

  out.push('');
  out.push(
    `导出值符号 ${String(result.symbols.length)} 个（不含入口模块自身导出）：可达 ${String(
      countBy('reachable'),
    )} 个，失败 ${String(result.issues.length)} 个` +
      `（调用链不在入口上 ${String(countBy('unreachable-callers'))}，` +
      `只被同文件引用 ${String(countBy('same-file-only'))}），` +
      `只被测试引用 ${String(countBy('test-only'))} 个（基线 ratchet）`,
  );

  if (groups.size > 0) {
    out.push('');
    out.push('── 失败的导出值符号（按文件分组）──');
    for (const [file, list] of groups) {
      out.push(`${file}（${String(list.length)} 个）`);
      for (const symbol of list) {
        out.push(
          `  ${symbol.file}:${String(symbol.line)}  ${symbol.name}  [${categoryLabel(
            symbol.category,
          )}]  ${symbol.evidence}`,
        );
      }
    }
  }

  const methodCountBy = (category: MethodCategory): number =>
    result.methods.filter((method) => method.category === category).length;

  out.push('');
  out.push(
    `成员方法 ${String(result.methods.length)} 个：可达 ${String(
      methodCountBy('reachable') + methodCountBy('contract'),
    )} 个（其中契约调用 ${String(methodCountBy('contract'))}），` +
      `protected 有子类 ${String(methodCountBy('protected-inherited'))} 个，` +
      `只被测试调用 ${String(methodCountBy('method-test-only'))} 个（基线 ratchet），` +
      `生产零调用 ${String(result.methodIssues.length)} 个（失败）`,
  );

  if (result.methodIssues.length > 0) {
    out.push('');
    out.push('── method-no-caller（按文件）──');
    for (const method of result.methodIssues) {
      out.push(
        `  ${method.file}:${String(method.line)}  ${method.owner}.${method.name}  ` +
          `[${methodCategoryLabel(method.category)}]  ${method.evidence}`,
      );
    }
  }

  out.push('');
  out.push(
    `基线 ${BASELINE_PATH}：test-only ${String(actual.testOnly)} / 上限 ${String(
      baseline.testOnly,
    )}，method-test-only ${String(actual.methodTestOnly)} / 上限 ${String(
      baseline.methodTestOnly,
    )}`,
  );

  if (evaluation.tightened.length > 0) {
    const change = evaluation.tightened
      .map(
        (item) => `${baselineKeysLabel(item.key)} ${String(item.from)} → ${String(item.to)}`,
      )
      .join('，');
    out.push(
      `提示：基线可收紧（${change}），检查只读、不写文件；` +
        '确认后运行 `pnpm check:reachability --update-baseline` 写入。',
    );
  }

  for (const item of evaluation.exceeded) {
    out.push('');
    out.push(
      `✗ 基线超出：${baselineKeysLabel(item.key)} ${String(item.actual)} > 上限 ${String(
        item.limit,
      )}（多 ${String(item.actual - item.limit)} 个）`,
    );
    out.push('  当前这一类清单（新增项必须在里面，解释或清理后删掉）：');
    for (const name of baselineNames(result, item.key)) {
      out.push(`    ${name}`);
    }
  }

  const failures =
    result.moduleIssues.length +
    result.issues.length +
    result.methodIssues.length +
    evaluation.exceeded.length;

  out.push('');
  out.push(
    failures === 0
      ? '✓ 模块、导出符号、成员方法三级都没有无歧义的死代码，基线未超出'
      : `✗ 失败 ${String(failures)} 项：模块 never-imported ${String(
          result.moduleIssues.length,
        )}，导出符号 ${String(result.issues.length)}，method-no-caller ${String(
          result.methodIssues.length,
        )}，基线超出 ${String(evaluation.exceeded.length)}`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  main();
}
