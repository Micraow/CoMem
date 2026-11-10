/**
 * 配置生效自检：L1（叶子必须有消费方）+ L2（配置派生依赖不许可选）+ L3（example 与 schema 一致）。
 *
 * ## 为什么需要它
 *
 * 配置只有「形状」（zod schema 说有哪些字段、什么类型），没有「消费方」（谁读、
 * 在哪条代码路径上读）。于是「忘了接线」在类型系统里是合法的：删掉
 * 装配面的 `hotnessWeight` / `hotnessHalfLifeHours` 两行，`tsc` 仍然 exit 0，而
 * `telemetry.hotness.*` 静默失效。本脚本把这一类变成可执行的检查。
 *
 * 三层各自回答一个问题：
 *
 * | 层 | 问题 | 能抓 | 抓不到 |
 * |---|---|---|---|
 * | L1 | 这个叶子有人读吗？ | 加了字段没接线 | 接了线但没效果 |
 * | L2 | 配置值是走进「必填」还是「可选」依赖？ | 可选依赖静默漏传 | 必填但服务忽略 |
 * | L3 | `config.example.yaml` 与 schema 一致吗？ | 文档漂移 | 文档写了但不生效 |
 *
 * 第四层（某个引擎 / 生成器分支下有没有人读）需要启动容器，在
 * `tests/integration/config-coverage.test.ts` 里，不在本脚本。
 *
 * ## L1 的口径
 *
 * 叶子 `L` 被覆盖 ⟺ **`L` 自己**被读。**不把「祖先被读」算作覆盖。**
 *
 * 设计分析原本的口径是「`L` 或任一祖先被读即覆盖」，理由是「整段对象被读意味着
 * 子树跨过了边界」。实测这个口径会把整棵子树一次性判成已读：`config.a.b.c` 的内层
 * 前缀 `config.a.b` 本身也是一个 `PropertyAccessExpression`，把它的类型锚到 `a.b`
 * 之后，`a.b` 下的所有叶子都算「被读」。结果是删掉 `a.b` 下的任意一行接线都查不
 * 出来——检查器看起来是绿的，实际只校验了「这一段的某一行还在」。
 *
 * 现在的做法是只处理**最外层**属性访问链（内层前缀由外层链覆盖），每个叶子必须
 * 自己被读到。代价是「把整段配置交给下游按名字取字段」的写法会报未消费方；当前
 * 树里没有这种写法（75/75 覆盖），出现时应该改代码而不是放宽检查。
 *
 * 锚点匹配用「属性名子集」的启发式，不是类型恒等：手写的配置切片
 * （`RetrievalSettings` 之类）与配置树是两份声明，只能靠形状对上。没有加
 * `isTypeAssignableTo` 是因为 `RetrievalSettings.queryFilters` 是
 * `readonly string[]` 而 schema 是 `string[]`，可赋值判定会假失败，把
 * `retrieval.queryFilters` 误报成没有消费方。歧义处会打印出来供人工核对，
 * 改成 `z.infer` 派生类型（M1）之后才能做到零歧义。
 *
 * ## 残余：四层都抓不到的那一类
 *
 * **「重排候选文本恒为空」这一类的「读了但输入恒空」。** 本脚本只能证明「有人读了
 * 这个配置路径」，不能证明「读到的值改变了行为」。`retrieval.rerank.enabled` 曾经
 * 完整接线、`applyRerank` 单测全绿、L1–L4 全绿，而候选文本永远是空字符串，模型
 * 一次都没被调用——整条路径空转。**只有人写的行为契约测试能抓这一类。不要以为
 * `pnpm check:config` 通过就代表配置生效。**
 *
 * 同类的还有：阈值 / 权重配了但公式里乘 0、读到的值被下游 `?? 默认值` 覆盖、
 * 分支条件恒假。这些都是「配置到达了代码」，不是「配置到达了行为」。
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { configSchema } from '../src/config/schema.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const SCHEMA_FILE = join(ROOT, 'src', 'config', 'schema.ts');
/**
 * 装配面：`src/bootstrap/` 下的全部源文件。
 *
 * L2 判的是「配置值进入可选属性」，而装配代码按依赖域拆在这个目录里。把检查绑在
 * 单个文件路径上，拆分一次它就静默失效（`resolvedLegacy` 全表报红或全表空转）。
 */
const ASSEMBLY_DIR = join(ROOT, 'src', 'bootstrap');
const EXAMPLE_FILE = join(ROOT, 'config.example.yaml');

/**
 * 遗留债务：已经存在的「配置值进入可选属性」。
 *
 * 这份清单**不是**「允许新增」的名单——新增项一律报错。它存在的唯一理由是：
 * 设计分析预计 S1 之后 L2 零输出，**实测是 17 处**（设计分析里的 L2 伪代码用
 * `checker.getTypeAtLocation(call.arguments[0])` 取对象字面量的类型，而字面量类型
 * 的属性永远不带 `Optional`，所以那次「预计」是个恒为空的检查）。全部改成必填
 * 会牵动 10 个接口与 62 处构造点，其中 `src/ingest/**`、`src/eval/**` 属于别的
 * wave，超出本 wave 的文件所有权。
 *
 * 规则：**只允许缩小。** 修掉一处就删掉对应行；留着不删会让 L2 报「清单过期」。
 * 新增配置派生依赖必须写成必填属性——那才是本 wave 要的回归门禁。
 */
const LEGACY_OPTIONAL_CONFIG_DEPS: ReadonlySet<string> = new Set([
  'SqliteFtsIndexOptions.candidateMultiplier',
  'LlmServiceOptions.pricing',
  'LlmServiceOptions.model',
  'AiSdkProviderOptions.pricing',
  'AiSdkEmbeddingProviderOptions.maxBatchSize',
  'AiSdkEmbeddingProviderOptions.timeoutSeconds',
  'AclServiceOptions.groupDefaultLevel',
  'TaskServiceOptions.leaseSeconds',
  'TaskServiceOptions.maxAttempts',
  'SearchServiceDeps.engine',
  'MemoryServicePorts.reviewRequired',
  'ConsolidationServiceDeps.maxIterations',
  'CommitRunnerOptions.concurrency',
  'ObservabilityServiceDeps.hookOverheadEnabled',
  'ObservabilityServiceDeps.includeAccountLabel',
  'ObservabilityServiceDeps.requestLogPolicy',
]);

interface ConfigNode {
  readonly path: readonly string[];
  readonly type: ts.Type;
  readonly propertyNames: ReadonlySet<string>;
}

interface OptionalDependency {
  /** 目标接口名，如 `SearchServiceDeps` */
  readonly owner: string;
  readonly property: string;
  /** 传进去的配置表达式，如 `config.telemetry.hotness.weight` */
  readonly expression: string;
  readonly location: string;
}

interface AmbiguousAnchor {
  readonly expression: string;
  readonly chosen: string;
  readonly candidates: readonly string[];
}

const ambiguities: AmbiguousAnchor[] = [];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function locationOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return `${relative(ROOT, sourceFile.fileName)}:${String(line + 1)}`;
}

function propertyNameOf(node: ts.PropertyName | ts.PrivateIdentifier): string | null {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPrivateIdentifier(node)) {
    // `this.#config` 的 `#config` 是 PrivateIdentifier：`text` 是 undefined，
    // 只有 `escapedText` 有值（含 `#`）。
    return node.escapedText.toString();
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function accessName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return propertyNameOf(node.name);
  }
  const argument = node.argumentExpression;
  // `paths['claude-code']` 是 ElementAccessExpression。TS 5.x 把 `.argument`
  // 改成了 deprecated 的 getter（读出来是 undefined），必须用 `argumentExpression`。
  if (argument === undefined) {
    return null;
  }
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return null;
}

function rootNameOf(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this';
  }
  return null;
}

interface Chain {
  readonly names: readonly string[];
  readonly expressions: readonly ts.Expression[];
}

/**
 * 把 `config.a.b` 展开成
 * `names = ['config', 'a', 'b']`、`expressions = [config, config.a, config.a.b]`。
 *
 * 计算属性（`config.arr[i]`）无法静态求名，整条链跳过；它内部的属性访问会由
 * 遍历单独处理。
 */
function chainOf(expression: ts.Expression): Chain | null {
  const accesses: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = [];
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    accesses.unshift(current);
    current = current.expression;
  }
  const rootName = rootNameOf(current);
  if (rootName === null) {
    return null;
  }
  const names: string[] = [rootName];
  for (const access of accesses) {
    const name = accessName(access);
    if (name === null) {
      return null;
    }
    names.push(name);
  }
  return { names, expressions: [current, ...accesses] };
}

function isObjectType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return false;
  }
  // 数组 / 元组是叶子（`queryFilters: string[]`），不是配置树的分支。
  return !checker.isArrayType(type) && !checker.isTupleType(type);
}

function propertyTypeOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) {
    return undefined;
  }
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function buildConfigTree(
  checker: ts.TypeChecker,
  rootType: ts.Type,
): { nodes: ConfigNode[]; paths: Set<string>; symbols: Map<string, ts.Symbol> } {
  const nodes: ConfigNode[] = [];
  const paths = new Set<string>();
  const symbols = new Map<string, ts.Symbol>();

  const walk = (type: ts.Type, path: readonly string[]): void => {
    const properties = checker.getPropertiesOfType(type);
    if (properties.length === 0) {
      return;
    }
    nodes.push({ path, type, propertyNames: new Set(properties.map((property) => property.name)) });
    for (const property of properties) {
      const propertyPath = [...path, property.name];
      const route = propertyPath.join('.');
      paths.add(route);
      symbols.set(route, property);
      const propertyType = propertyTypeOf(checker, property);
      if (propertyType !== undefined && isObjectType(checker, propertyType)) {
        walk(propertyType, propertyPath);
      }
    }
  };

  walk(rootType, []);
  return { nodes, paths, symbols };
}

/** 从 `configSchema.parse({})` 的运行时值取叶子集合（与 `loadConfig` 同一份真相）。 */
function collectLeaves(value: unknown, prefix: readonly string[] = []): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [prefix.join('.')];
  }
  const leaves: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    leaves.push(...collectLeaves(child, [...prefix, key]));
  }
  return leaves;
}

function main(): void {
  const configFile = ts.readConfigFile(join(ROOT, 'tsconfig.json'), (path) =>
    readFileSync(path, 'utf8'),
  );
  if (configFile.error !== undefined) {
    fail(`读取 tsconfig.json 失败：${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();

  const schemaSource = program.getSourceFile(SCHEMA_FILE);
  if (schemaSource === undefined) {
    fail(`找不到 ${relative(ROOT, SCHEMA_FILE)}，无法读取 ComemConfig 类型。`);
  }
  const typeAlias = schemaSource.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ComemConfig',
  );
  if (typeAlias === undefined) {
    fail('src/config/schema.ts 里没有 `ComemConfig` 类型别名。');
  }

  const configType = checker.getTypeAtLocation(typeAlias.type);
  if (!isObjectType(checker, configType)) {
    fail('`ComemConfig` 不是对象类型。');
  }
  const { nodes, paths: configPaths, symbols: configSymbols } = buildConfigTree(checker, configType);
  const leaves = collectLeaves(configSchema.parse({}));

  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && file.fileName.startsWith(`${SRC_DIR}${sep}`));

  const reads = new Set<string>();

  const matchingNodes = (type: ts.Type): ConfigNode[] => {
    if (!isObjectType(checker, type)) {
      // 原始类型不能当锚点：`dataDir: string` 会匹配任何字符串表达式。
      return [];
    }
    const propertyNames = checker.getPropertiesOfType(type).map((property) => property.name);
    if (propertyNames.length === 0) {
      return [];
    }
    return nodes.filter((node) => propertyNames.every((name) => node.propertyNames.has(name)));
  };

  const bySpecificity = (left: ConfigNode, right: ConfigNode): number =>
    checker.getPropertiesOfType(left.type).length -
      checker.getPropertiesOfType(right.type).length || right.path.length - left.path.length;

  const resolveFrom = (anchor: ConfigNode, names: readonly string[]): string | null => {
    let current: readonly string[] = anchor.path;
    for (const name of names) {
      const next = [...current, name];
      if (!configPaths.has(next.join('.'))) {
        return null;
      }
      current = next;
    }
    return current.join('.');
  };

  /** 沿链找最具体的配置节点锚点，返回从锚点往下走到的路径。 */
  const pathOfChain = (chain: Chain, recordAmbiguity: boolean): string | null => {
    for (let index = 0; index < chain.expressions.length; index += 1) {
      const candidates = matchingNodes(
        checker.getTypeAtLocation(chain.expressions[index] as ts.Expression),
      );
      if (candidates.length === 0) {
        continue;
      }
      candidates.sort(bySpecificity);
      const chosen = candidates[0] as ConfigNode;
      if (recordAmbiguity && candidates.length > 1) {
        const expression = chain.names.join('.');
        if (!ambiguities.some((entry) => entry.expression === expression)) {
          ambiguities.push({
            expression,
            chosen: chosen.path.join('.'),
            candidates: candidates.map((candidate) => candidate.path.join('.')),
          });
        }
      }
      return resolveFrom(chosen, chain.names.slice(index + 1));
    }
    return null;
  };

  /**
   * 解构（`const { rrfK } = config.retrieval.hybrid`）。
   *
   * 解构的右侧本身是一条配置链（会被当作「整段对象被读」记下来），左侧的每个
   * 属性名是**直接**读到的叶子——两件事都要记，否则 `const { weight } = ...;
   * ...weight` 会被判成没消费方。
   */
  const recordDestructuring = (pattern: ts.ObjectBindingPattern, initializer: ts.Expression | undefined): void => {
    if (initializer === undefined) {
      return;
    }
    const chain = chainOf(initializer);
    if (chain === null) {
      return;
    }
    const base = pathOfChain(chain, false);
    if (base === null) {
      return;
    }
    reads.add(base);
    for (const element of pattern.elements) {
      const name = element.propertyName ?? element.name;
      const property = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : null;
      if (property === null) {
        continue;
      }
      const path = `${base}.${property}`;
      if (configPaths.has(path)) {
        reads.add(path);
      }
    }
  };

  /** 内层访问已经由外层链覆盖，重复处理只会让歧义计数虚高。 */
  const isInnerAccess = (node: ts.Node): boolean => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    );
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        !isInnerAccess(node)
      ) {
        const chain = chainOf(node);
        if (chain !== null) {
          const path = pathOfChain(chain, true);
          if (path !== null) {
            reads.add(path);
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        recordDestructuring(node.name, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const covered = (leaf: string): boolean => reads.has(leaf);

  const unconsumed = leaves.filter((leaf) => !covered(leaf));

  // ── L2：配置派生依赖不许可选 ──
  const optionalDependencies: OptionalDependency[] = [];
  const assemblySources = program
    .getSourceFiles()
    .filter(
      (file) => !file.isDeclarationFile && file.fileName.startsWith(`${ASSEMBLY_DIR}${sep}`),
    );
  if (assemblySources.length > 0) {
    const readsConfig = (node: ts.Node): boolean => {
      let found = false;
      const inner = (child: ts.Node): void => {
        if (found) {
          return;
        }
        if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) {
          const chain = chainOf(child);
          if (chain !== null && scanChainHasConfigAnchor(chain)) {
            found = true;
            return;
          }
        }
        ts.forEachChild(child, inner);
      };
      inner(node);
      return found;
    };

    const scanChainHasConfigAnchor = (chain: Chain): boolean => {
      for (let index = 0; index < chain.expressions.length; index += 1) {
        const type = checker.getTypeAtLocation(chain.expressions[index] as ts.Expression);
        const propertyNames = checker.getPropertiesOfType(type).map((property) => property.name);
        if (propertyNames.length === 0 || !isObjectType(checker, type)) {
          continue;
        }
        for (const node of nodes) {
          if (propertyNames.every((name) => node.propertyNames.has(name))) {
            return true;
          }
        }
      }
      return false;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.arguments?.length === 1) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          const constructorType = checker.getTypeAtLocation(node.expression);
          const signature = checker.getSignaturesOfType(constructorType, ts.SignatureKind.Construct)[0];
          const parameter = signature?.getParameters()[0];
          const parameterType =
            parameter === undefined || signature === undefined
              ? undefined
              : checker.getTypeOfSymbolAtLocation(parameter, signature.declaration ?? node);
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property)) {
              continue;
            }
            const name = propertyNameOf(property.name);
            if (name === null || parameterType === undefined) {
              continue;
            }
            if (!readsConfig(property.initializer)) {
              continue;
            }
            const symbol = checker.getPropertyOfType(parameterType, name);
            if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Optional) === 0) {
              continue;
            }
            const owner = symbol.declarations?.[0]?.parent;
            optionalDependencies.push({
              owner: owner !== undefined && ts.isInterfaceDeclaration(owner) ? owner.name.text : '<unknown>',
              property: name,
              expression: property.initializer.getText(),
              location: locationOf(property),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of assemblySources) {
      visit(sourceFile);
    }
  }

  // ── L3：example 与 schema 双向一致 ──
  const exampleContent = readFileSync(EXAMPLE_FILE, 'utf8');
  const exampleValue: unknown = parseYaml(exampleContent);
  const exampleLeaves = new Set(collectLeaves(exampleValue));
  const schemaLeaves = new Set(leaves);
  const missingInExample = leaves.filter((leaf) => !exampleLeaves.has(leaf));
  const staleInExample = [...exampleLeaves].filter((leaf) => !schemaLeaves.has(leaf)).sort();

  // ── 输出 ──
  const out: string[] = [];
  out.push(`配置叶子 ${String(leaves.length)} 个`);
  out.push(`  ✓ ${String(leaves.length - unconsumed.length)} 个有消费方`);
  for (const leaf of unconsumed) {
    const symbol = configSymbols.get(leaf);
    const declaration = symbol?.declarations?.[0];
    out.push(
      `  ✗ ${leaf} 没有任何消费方${declaration === undefined ? '' : `（${locationOf(declaration)}）`}`,
    );
  }

  const optionalKeys = new Set(
    optionalDependencies.map((dependency) => `${dependency.owner}.${dependency.property}`),
  );
  const newOptionalDependencies = optionalDependencies.filter(
    (dependency) => !LEGACY_OPTIONAL_CONFIG_DEPS.has(`${dependency.owner}.${dependency.property}`),
  );
  const resolvedLegacy = [...LEGACY_OPTIONAL_CONFIG_DEPS].filter((key) => !optionalKeys.has(key));

  out.push('');
  out.push(
    `可选依赖 ${String(optionalDependencies.length)} 处（配置值进入可选属性，漏传不会报错）`,
  );
  for (const key of resolvedLegacy) {
    out.push(`  ✗ ${key} 已不是可选依赖，请从 LEGACY_OPTIONAL_CONFIG_DEPS 删除这一行`);
  }
  for (const dependency of newOptionalDependencies) {
    out.push(
      `  ✗ ${dependency.owner}.${dependency.property}  ${dependency.location}  ← ${dependency.expression}`,
    );
  }
  for (const dependency of optionalDependencies) {
    if (newOptionalDependencies.includes(dependency)) {
      continue;
    }
    out.push(
      `  ! ${dependency.owner}.${dependency.property}  ${dependency.location}  ← ${dependency.expression}`,
    );
  }

  out.push('');
  out.push(
    `config.example.yaml 漂移 ${String(missingInExample.length + staleInExample.length)} 处`,
  );
  for (const leaf of missingInExample) {
    out.push(`  ✗ example 缺少 ${leaf}`);
  }
  for (const leaf of staleInExample) {
    out.push(`  ✗ example 多出 ${leaf}（schema 里没有）`);
  }

  const issueCount =
    unconsumed.length +
    newOptionalDependencies.length +
    resolvedLegacy.length +
    missingInExample.length +
    staleInExample.length;
  out.push('');
  out.push(`歧义匹配 ${String(ambiguities.length)} 处（启发式结果，需人工核对）`);
  for (const ambiguity of ambiguities) {
    out.push(
      `  ? ${ambiguity.expression} → ${ambiguity.chosen}（候选：${ambiguity.candidates.join(' | ')}）`,
    );
  }

  out.push('');
  out.push(issueCount === 0 ? '✓ 没有发现问题' : `✗ ${String(issueCount)} 个问题`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(issueCount === 0 ? 0 : 1);
}

main();
