/**
 * 孤儿检查：`src/services/` 与 `src/adapters/` 里 exported 类的 public 方法、
 * `src/domain/` 里 exported 的函数，必须在 `src/` 的生产链路里至少有一个**值引用**。
 *
 * ## 为什么需要它
 *
 * 类型系统只证明「方法存在」，不证明「有人调用」。一个方法可以同时做到：仓储、
 * HTTP 端点、单测都齐备，而生产链路从不经过它——`MemoryLinkService.addLinks`
 * 就这样让记忆关联表永远是空的（见 BASELINE）。测试直接调它所以绿，文档按它的
 * 存在描述行为，于是「实现了」和「没生效」在外观上没有区别。
 *
 * ## 口径
 *
 * - 目标：`src/services/**`、`src/adapters/**` 里 `export class` 的 public 方法
 *   （`#private`、`private`、`protected` 不算——它们只服务同类内部）；
 *   `src/domain/**` 里 `export function`。
 * - 引用：只算**值位置**的引用。`import type`、类型注解、`typeof X` 不算。
 * - **同类内部调用不算引用**：public 方法只被自己的类调用，说明公开面没有外部
 *   消费方；它是不是生产可达，交给「该不该改成 private」的人判断。
 * - `tests/` 里的引用**单独统计**：只被测试调用 = 孤儿，这是本检查要抓的形态。
 * - 端口实现按接口/基类成员符号计引用：接口那一端有人调用，实现端就算接上了；
 *   接口那一端也没人调用，实现端照样报。
 * - 消费方契约可以是显式 `implements`，也可以是结构类型：仓库不为只有一个实现
 *   的类型建接口（§4.4），`bootstrap/scheduler.ts` 的 `SessionAutoCommitPort`
 *   就是「只声明方法」的接口，由 `SessionService` 结构满足。内联对象类型
 *   （`readonly memory: { prefetch(...) }`）同理。
 *
 * ## 已实现的排除
 *
 * - 只被 `api/`、`bootstrap/`、`commands/`、`ingest/`、`eval/` 调用：有调用方。
 * - 端口实现且接口/基类另一端有调用。
 * - 属性型接口（`*Options` / `*Deps` / 行类型）不当作端口，避免一个 `get(uri)`
 *   把无关类「接上」。
 *
 * ## 抓不到的那一类（残余）
 *
 * 本检查证明的是「有人在代码里提到了这个方法」，不是「这个方法在生产上真的
 * 产生效果」。以下都抓不到：
 *
 * - **字符串派发**：`phase('archive', ...)` 的调用点存在，但 `'archive'` 不是
 *   `ASYNC_PHASES` 里的名字，`comem_hook_async_seconds` 仍然恒为 0。方法名与
 *   字符串常量之间的对应关系不在引用图里。
 * - **调用方在默认关闭的分支里**（配置默认 `false`、引擎不选它）。
 * - **调用方传入让它早退的参数**（空数组、`limit 0`、空字符串）。
 * - **调用方只取返回值不用副作用**，而那个值恒为空（从未接线的增量回填）。
 * - **传递性孤儿**：A 只被孤儿 B 调用，A 看起来有调用方。
 * - **引用不是调用**：`void svc.method`、把它注册进一个从不触发的表。
 *
 * 这些需要行为契约测试或调用图可达性分析，静态引用计数给不出答案。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const TARGET_ROOTS = ['domain', 'services', 'adapters'] as const;
const PRODUCTION_ROOT = 'src';

export type OrphanCategory =
  /** 生产代码里一个值引用都没有（同类内部调用不算）。 */
  | 'no-reference'
  /** 生产代码没有引用，只有 `tests/` 在调。 */
  | 'test-only'
  /** 生产代码只有同类内部调用，外部一个都没有。 */
  | 'internal-only';

export interface OrphanRecord {
  /** 稳定标识：方法 `Owner.member`，函数 `文件#名字`。 */
  readonly id: string;
  readonly kind: 'method' | 'function';
  readonly file: string;
  /** 1-based 行号。 */
  readonly line: number;
  readonly category: OrphanCategory;
  readonly productionReferences: number;
  readonly testReferences: number;
  readonly internalReferences: number;
  /** 代理到的端口成员（`Owner.member`），用于人工核对。 */
  readonly portSymbols: readonly string[];
}

export interface TargetRecord extends Omit<OrphanRecord, 'category'> {
  readonly category: OrphanCategory | null;
}

export interface BaselineEntry {
  readonly id: string;
  readonly reason: string;
}

export interface OrphanCheckResult {
  readonly targets: readonly TargetRecord[];
  readonly orphans: readonly OrphanRecord[];
  /** 清单里指向不存在目标的方法（拼写错误或方法已删除）。 */
  readonly unknownBaseline: readonly BaselineEntry[];
  /** 清单里已经不再报的孤儿（被修好或接上了，必须从清单删除）。 */
  readonly staleBaseline: readonly BaselineEntry[];
  /** 不在清单里的新增孤儿。 */
  readonly unexpected: readonly OrphanRecord[];
}

interface RefSite {
  readonly file: ts.SourceFile;
  readonly node: ts.Node;
  readonly production: boolean;
  readonly enclosingClass: ts.ClassDeclaration | undefined;
}

interface TargetInternal {
  readonly id: string;
  readonly kind: 'method' | 'function';
  readonly symbol: ts.Symbol;
  readonly declaration: ts.Node;
  readonly classDeclaration: ts.ClassDeclaration | undefined;
  readonly instanceType: ts.Type | undefined;
  readonly file: ts.SourceFile;
  readonly line: number;
  readonly member: string;
  /** 端口（接口/基类）成员声明；这些声明上的引用同样算到这个方法头上。 */
  readonly portDeclarations: ts.Node[];
  readonly portLabels: string[];
}

/**
 * 遗留债务：当前已经存在的孤儿。
 *
 * 清单**不是**允许新增的名单——新增孤儿一律让命令失败。它的唯一用途是让存量
 * 可见：每条都写清楚判断（该删 / 该接线 / 是端口实现 / 误报），修掉一条就删
 * 一行；留着不删会让检查报「清单过期」。
 *
 * 判断口径见条目文字。**不要为了让检查通过而往这里加行。**
 */
const BASELINE: readonly BaselineEntry[] = [
  {
    id: 'EmbeddingRepository.iterMissingUris',
    reason: '该接线：打开 embedding 后存量不回填，只能手动 reindex。',
  },
];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function locationOf(rootDir: string, node: ts.Node): { file: string; line: number } {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { file: relative(rootDir, sourceFile.fileName), line: line + 1 };
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
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isNonPublicMember(node: ts.ClassElement): boolean {
  if (ts.isConstructorDeclaration(node)) {
    return true;
  }
  if (
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return true;
  }
  // `#name` 是 PrivateIdentifier：它不是公开面的一部分。
  return node.name !== undefined && ts.isPrivateIdentifier(node.name);
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

function enclosingClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
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

interface LoadedProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

/**
 * 仓库根用 tsconfig.json（与 `tsc` 同一份文件集）；测试 fixture 没有 tsconfig
 * 时显式列 `src/**` 与 `tests/**`，选项与仓库保持一致的最小集。
 */
function loadProgram(rootDir: string): LoadedProgram {
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
    return { program, checker: program.getTypeChecker() };
  }

  const rootNames = [
    ...collectSourceFiles(join(rootDir, 'src')),
    ...collectSourceFiles(join(rootDir, 'tests')),
  ];
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
  });
  return { program, checker: program.getTypeChecker() };
}

function isTargetFile(rootDir: string, file: ts.SourceFile): boolean {
  if (file.isDeclarationFile) {
    return false;
  }
  const segments = relative(rootDir, file.fileName).split(sep);
  return (
    segments.length > 2 &&
    segments[0] === PRODUCTION_ROOT &&
    (TARGET_ROOTS as readonly string[]).includes(segments[1] as string)
  );
}

function isProductionFile(rootDir: string, file: ts.SourceFile): boolean {
  return relative(rootDir, file.fileName).split(sep)[0] === PRODUCTION_ROOT;
}

function isTestFile(rootDir: string, file: ts.SourceFile): boolean {
  return relative(rootDir, file.fileName).split(sep)[0] === 'tests';
}

function collectExplicitPortSymbols(
  checker: ts.TypeChecker,
  classDeclaration: ts.ClassDeclaration,
  memberName: string,
  target: TargetInternal,
): void {
  for (const clause of classDeclaration.heritageClauses ?? []) {
    for (const heritageType of clause.types) {
      const type = checker.getTypeAtLocation(heritageType);
      const property = checker.getPropertyOfType(type, memberName);
      if (property === undefined) {
        continue;
      }
      addPort(target, property, memberName);
    }
  }
}

function addPort(target: TargetInternal, property: ts.Symbol, memberName: string): void {
  const parent = property.declarations?.[0]?.parent;
  const owner =
    parent !== undefined &&
    (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
    parent.name !== undefined
      ? parent.name.text
      : '?';
  for (const declaration of property.declarations ?? []) {
    if (target.portDeclarations.includes(declaration)) {
      continue;
    }
    target.portDeclarations.push(declaration);
    target.portLabels.push(`${owner}.${memberName}`);
  }
}

/**
 * 结构型端口：只声明方法、且类实例可赋值给它的导出的接口。属性型接口
 * （`*Options` / `*Deps` / 行类型）不参与，否则一个 `get(uri)` 就能把无关类
 * 「接上」。
 *
 * 内联对象类型（`readonly memory: { prefetch(...) }`）没有可枚举的声明，在
 * `recordStructural` 里按调用点的接收者类型处理。
 */
function attachStructuralPorts(
  checker: ts.TypeChecker,
  program: ts.Program,
  targets: readonly TargetInternal[],
): void {
  const interfaces: ts.InterfaceDeclaration[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) {
      continue;
    }
    for (const statement of file.statements) {
      if (!ts.isInterfaceDeclaration(statement) || !isExported(statement)) {
        continue;
      }
      if (statement.members.length === 0) {
        continue;
      }
      if (!statement.members.every((member) => ts.isMethodSignature(member))) {
        continue;
      }
      interfaces.push(statement);
    }
  }

  for (const target of targets) {
    if (target.kind !== 'method' || target.instanceType === undefined) {
      continue;
    }
    for (const declaration of interfaces) {
      const interfaceSymbol = checker.getSymbolAtLocation(declaration.name);
      if (interfaceSymbol === undefined) {
        continue;
      }
      const interfaceType = checker.getDeclaredTypeOfSymbol(interfaceSymbol);
      const property = checker.getPropertyOfType(interfaceType, target.member);
      if (property === undefined) {
        continue;
      }
      if (!checker.isTypeAssignableTo(target.instanceType, interfaceType)) {
        continue;
      }
      addPort(target, property, target.member);
    }
  }
}

function collectTargets(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
): TargetInternal[] {
  const targets: TargetInternal[] = [];
  const seenSymbols = new Set<ts.Symbol>();

  const push = (target: TargetInternal): void => {
    if (seenSymbols.has(target.symbol)) {
      return;
    }
    seenSymbols.add(target.symbol);
    targets.push(target);
  };

  for (const file of program.getSourceFiles()) {
    if (!isTargetFile(rootDir, file)) {
      continue;
    }
    const directory = relative(rootDir, file.fileName).split(sep)[1];

    for (const statement of file.statements) {
      if (directory === 'domain') {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name !== undefined &&
          isExported(statement)
        ) {
          const symbol = checker.getSymbolAtLocation(statement.name);
          if (symbol === undefined) {
            continue;
          }
          const location = locationOf(rootDir, statement);
          push({
            id: `${location.file}#${statement.name.text}`,
            kind: 'function',
            symbol: resolveAlias(checker, symbol),
            declaration: statement,
            classDeclaration: undefined,
            instanceType: undefined,
            file,
            line: location.line,
            member: statement.name.text,
            portDeclarations: [],
            portLabels: [],
          });
        }
        continue;
      }

      if (
        !ts.isClassDeclaration(statement) ||
        statement.name === undefined ||
        !isExported(statement)
      ) {
        continue;
      }
      const className = statement.name.text;
      const classSymbol = checker.getSymbolAtLocation(statement.name);
      const instanceType =
        classSymbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(classSymbol);

      for (const member of statement.members) {
        if (
          !ts.isMethodDeclaration(member) ||
          member.name === undefined ||
          isNonPublicMember(member)
        ) {
          continue;
        }
        if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
          continue;
        }
        const memberName = member.name.text;
        const symbol = checker.getSymbolAtLocation(member.name);
        if (symbol === undefined) {
          continue;
        }
        const location = locationOf(rootDir, member);
        const target: TargetInternal = {
          id: `${className}.${memberName}`,
          kind: 'method',
          symbol: resolveAlias(checker, symbol),
          declaration: member,
          classDeclaration: statement,
          instanceType,
          file,
          line: location.line,
          member: memberName,
          portDeclarations: [],
          portLabels: [],
        };
        collectExplicitPortSymbols(checker, statement, memberName, target);
        push(target);
      }
    }
  }

  attachStructuralPorts(checker, program, targets);
  return targets;
}

function buildReferenceIndex(
  rootDir: string,
  checker: ts.TypeChecker,
  program: ts.Program,
  relevantDeclarations: ReadonlySet<ts.Node>,
  targets: readonly TargetInternal[],
): Map<ts.Node, RefSite[]> {
  const index = new Map<ts.Node, RefSite[]>();
  const seen = new Map<ts.Node, Set<ts.Node>>();

  const targetsByMember = new Map<string, TargetInternal[]>();
  for (const target of targets) {
    if (target.kind !== 'method' || target.instanceType === undefined) {
      continue;
    }
    const list = targetsByMember.get(target.member);
    if (list === undefined) {
      targetsByMember.set(target.member, [target]);
    } else {
      list.push(target);
    }
  }

  const addSite = (declaration: ts.Node, site: RefSite): void => {
    let nodes = seen.get(declaration);
    if (nodes === undefined) {
      nodes = new Set();
      seen.set(declaration, nodes);
    }
    if (nodes.has(site.node)) {
      return;
    }
    nodes.add(site.node);
    const sites = index.get(declaration);
    if (sites === undefined) {
      index.set(declaration, [site]);
    } else {
      sites.push(site);
    }
  };

  /**
   * 按**声明节点**记账，不按 symbol 对象。
   *
   * `checker.getSymbolAtLocation(propertyAccess.name)` 对属性访问可能返回带
   * `Transient` 标志的 symbol 副本：它和声明处的 symbol 不是同一个对象，用
   * `Map<ts.Symbol, ...>` 查不到。声明节点是同一棵 AST 上的同一个对象。
   */
  const recordSymbol = (
    symbol: ts.Symbol | undefined,
    site: Omit<RefSite, 'enclosingClass'>,
  ): void => {
    if (symbol === undefined) {
      return;
    }
    const resolved = resolveAlias(checker, symbol);
    for (const declaration of resolved.declarations ?? []) {
      if (!relevantDeclarations.has(declaration)) {
        continue;
      }
      addSite(declaration, { ...site, enclosingClass: enclosingClass(site.node) });
    }
  };

  /** 调用点的接收者是一个只声明方法的消费方契约时，把这次调用记到类的同名方法上。 */
  const recordStructural = (
    receiverType: ts.Type,
    memberName: string,
    site: Omit<RefSite, 'enclosingClass'>,
  ): void => {
    if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) {
      return;
    }
    if ((receiverType.flags & ts.TypeFlags.Object) === 0) {
      return;
    }
    const properties = checker.getPropertiesOfType(receiverType);
    if (properties.length === 0) {
      return;
    }
    if (!properties.every((property) => (property.flags & ts.SymbolFlags.Method) !== 0)) {
      return;
    }
    for (const target of targetsByMember.get(memberName) ?? []) {
      if (target.instanceType === undefined) {
        continue;
      }
      if (!checker.isTypeAssignableTo(target.instanceType, receiverType)) {
        continue;
      }
      addSite(target.declaration, { ...site, enclosingClass: enclosingClass(site.node) });
    }
  };

  const recordBindingPattern = (
    pattern: ts.ObjectBindingPattern,
    initializer: ts.Expression,
    file: ts.SourceFile,
    production: boolean,
  ): void => {
    const type = checker.getTypeAtLocation(initializer);
    for (const element of pattern.elements) {
      const nameNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) {
        continue;
      }
      // 解构本身就是一次成员访问：`const { read } = storage` 之后即使没有后续
      // 调用，这一行也算「有人用了这个成员」。
      const property = checker.getPropertyOfType(type, nameNode.text);
      recordSymbol(property, { file, node: element, production });
    }
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) {
      continue;
    }
    const production = isProductionFile(rootDir, file);
    if (!production && !isTestFile(rootDir, file)) {
      continue;
    }

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
      // 类型位置不是值引用（import type、typeof、类型注解都在这里被跳过）。
      if (ts.isTypeNode(node)) {
        return;
      }

      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const site = { file, node, production };
        recordSymbol(checker.getSymbolAtLocation(node), site);
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          recordStructural(checker.getTypeAtLocation(parent.expression), node.text, site);
        }
      }

      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
      ) {
        const type = checker.getTypeAtLocation(node.expression);
        const property = checker.getPropertyOfType(type, node.argumentExpression.text);
        recordSymbol(property, { file, node, production });
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined
      ) {
        recordBindingPattern(node.name, node.initializer, file, production);
      }

      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return index;
}

function withinDefinition(node: ts.Node, declaration: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === declaration) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function classify(
  rootDir: string,
  target: TargetInternal,
  referenceIndex: Map<ts.Node, RefSite[]>,
): TargetRecord {
  const seenNodes = new Set<ts.Node>();
  let productionReferences = 0;
  let testReferences = 0;
  let internalReferences = 0;

  for (const declaration of [target.declaration, ...target.portDeclarations]) {
    for (const site of referenceIndex.get(declaration) ?? []) {
      if (seenNodes.has(site.node)) {
        continue;
      }
      seenNodes.add(site.node);
      // 定义处（含函数/方法自己的递归调用）不算。
      if (withinDefinition(site.node, target.declaration)) {
        continue;
      }
      if (!site.production) {
        testReferences += 1;
        continue;
      }
      if (
        target.classDeclaration !== undefined &&
        site.enclosingClass === target.classDeclaration
      ) {
        internalReferences += 1;
        continue;
      }
      productionReferences += 1;
    }
  }

  const category: OrphanCategory | null =
    productionReferences > 0
      ? null
      : testReferences > 0
        ? 'test-only'
        : internalReferences > 0
          ? 'internal-only'
          : 'no-reference';

  return {
    id: target.id,
    kind: target.kind,
    file: relative(rootDir, target.file.fileName),
    line: target.line,
    productionReferences,
    testReferences,
    internalReferences,
    portSymbols: target.portLabels,
    category,
  };
}

/**
 * 分析一个项目根（仓库根，或测试 fixture 根），返回全部目标与孤儿。
 * 不读清单——清单比对在 `runCheck` 里，测试只关心分类结果。
 */
export function analyzeOrphans(rootDir: string): {
  targets: TargetRecord[];
  orphans: OrphanRecord[];
} {
  const { program, checker } = loadProgram(rootDir);
  const targets = collectTargets(rootDir, checker, program);

  const relevantDeclarations = new Set<ts.Node>();
  for (const target of targets) {
    relevantDeclarations.add(target.declaration);
    for (const declaration of target.portDeclarations) {
      relevantDeclarations.add(declaration);
    }
  }

  const referenceIndex = buildReferenceIndex(
    rootDir,
    checker,
    program,
    relevantDeclarations,
    targets,
  );
  const records = targets.map((target) => classify(rootDir, target, referenceIndex));
  const orphans = records.filter(
    (record): record is TargetRecord & { category: OrphanCategory } => record.category !== null,
  );
  return {
    targets: records,
    orphans: orphans.map((record) => ({ ...record, category: record.category })),
  };
}

export function runCheck(rootDir: string, baseline: readonly BaselineEntry[]): OrphanCheckResult {
  const { targets, orphans } = analyzeOrphans(rootDir);
  const baselineIds = new Set(baseline.map((entry) => entry.id));
  const orphanIds = new Set(orphans.map((orphan) => orphan.id));
  const targetIds = new Set(targets.map((target) => target.id));
  return {
    targets,
    orphans,
    unexpected: orphans.filter((orphan) => !baselineIds.has(orphan.id)),
    unknownBaseline: baseline.filter((entry) => !targetIds.has(entry.id)),
    staleBaseline: baseline.filter(
      (entry) => targetIds.has(entry.id) && !orphanIds.has(entry.id),
    ),
  };
}

function categoryLabel(category: OrphanCategory): string {
  switch (category) {
    case 'test-only':
      return '只被测试引用';
    case 'internal-only':
      return '只有同类内部引用';
    case 'no-reference':
      return '零引用';
  }
}

function main(): void {
  const { targets, orphans, unexpected, staleBaseline, unknownBaseline } = runCheck(
    REPO_ROOT,
    BASELINE,
  );
  const out: string[] = [];
  const methodCount = targets.filter((target) => target.kind === 'method').length;

  out.push(
    `目标 ${String(targets.length)} 个（services/adapters 的 public 方法 ${String(methodCount)} 个，domain 函数 ${String(targets.length - methodCount)} 个）`,
  );
  out.push(`孤儿 ${String(orphans.length)} 个，清单 ${String(BASELINE.length)} 条`);

  if (orphans.length > 0) {
    out.push('');
    out.push('── 当前孤儿（按文件）──');
    const sorted = [...orphans].sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    );
    for (const orphan of sorted) {
      out.push(
        `  ! ${orphan.id}  ${orphan.file}:${String(orphan.line)}  [${categoryLabel(orphan.category)}]`,
      );
      out.push(
        `      生产 ${String(orphan.productionReferences)} / 测试 ${String(orphan.testReferences)} / 同类 ${String(orphan.internalReferences)}`,
      );
      const entry = BASELINE.find((candidate) => candidate.id === orphan.id);
      if (entry !== undefined) {
        out.push(`      ${entry.reason}`);
      }
      if (orphan.portSymbols.length > 0) {
        out.push(`      端口：${orphan.portSymbols.join(', ')}`);
      }
    }
  }

  out.push('');
  out.push(`新增孤儿 ${String(unexpected.length)} 个`);
  for (const orphan of unexpected) {
    out.push(
      `  ✗ ${orphan.id}  ${orphan.file}:${String(orphan.line)}  [${categoryLabel(orphan.category)}]`,
    );
  }

  out.push('');
  out.push(`清单过期 ${String(staleBaseline.length)} 个（已不再报孤儿，请删掉对应行）`);
  for (const entry of staleBaseline) {
    out.push(`  ✗ ${entry.id}`);
  }

  out.push('');
  out.push(`清单指向不存在的目标 ${String(unknownBaseline.length)} 个（拼写错误或方法已删除）`);
  for (const entry of unknownBaseline) {
    out.push(`  ✗ ${entry.id}`);
  }

  const issueCount = unexpected.length + staleBaseline.length + unknownBaseline.length;
  out.push('');
  out.push(issueCount === 0 ? '✓ 没有清单外的孤儿' : `✗ ${String(issueCount)} 个问题`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(issueCount === 0 ? 0 : 1);
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  main();
}
