/**
 * 配置候选的完整校验（架构文档 §18）。
 *
 * 从 `index.ts` 拆出来：加载器已经要处理四层输入，校验规则（含「错误该归到哪个
 * 文件」）是独立的一组判断。覆盖文件的未知键检查也在这里——它和类型错误一样，
 * 必须在启动期失败，否则拼错的键会被 zod 安静地剥掉。
 */

import { z } from 'zod';

import { ComemError } from '../domain/errors.js';
import { isRecord } from '../domain/guards.js';

import { describeIssue } from './file.js';
import { collectLeaves, hasPath, type ConfigRecord } from './merge.js';
import { configSchema, type ComemConfig } from './schema.js';

export interface ValidationContext {
  readonly configPath: string;
  readonly overridePath?: string;
  readonly overrideConfig?: Readonly<ConfigRecord>;
}

/** 只解析 `dataDir` 的窄 schema：阶段一不能因为覆盖文件会修好的交叉校验而失败。 */
const dataDirSchema = z.object({ dataDir: z.string().default('') });

function candidatePath(issue: { readonly path: readonly PropertyKey[] }): string {
  return issue.path.map(String).join('.');
}

/** 这个 issue 的路径是否落在覆盖文件里（含对象整体类型错误的情况）。 */
function issueFromOverride(
  override: Readonly<ConfigRecord>,
  path: readonly PropertyKey[],
): boolean {
  const segments = path.map(String);
  if (segments.length === 0) {
    return true;
  }
  if (hasPath(override, segments)) {
    return true;
  }
  return collectLeaves(override).some((leaf) =>
    segments.every((segment, index) => leaf.path[index] === segment),
  );
}

/** 阶段一：只校验并取出 `dataDir`；其余字段的错误留到覆盖文件合并之后。 */
export function parseDataDir(candidate: ConfigRecord, configPath: string): string {
  const result = dataDirSchema.safeParse(candidate);
  if (result.success) {
    return result.data.dataDir;
  }
  const fields = result.error.issues.map(candidatePath);
  const described = result.error.issues
    .map((issue) => `${candidatePath(issue) || '<root>'} ${describeIssue(issue)}`)
    .join('；');
  throw new ComemError(
    'INVALID_ARGUMENT',
    `配置校验失败：${described}（配置文件 ${configPath}）`,
    { path: configPath, fields },
  );
}

/**
 * 完整校验一份候选配置。
 *
 * 交叉校验（`cross-checks.ts`）抛的是 `ComemError` 而不是 `ZodError`，`safeParse`
 * 会原样抛出——这里只处理 schema issue，交叉校验的错误消息已经带字段，不再包一层。
 */
export function validateConfigCandidate(
  candidate: ConfigRecord,
  context: ValidationContext,
): ComemConfig {
  const result = configSchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues;
  const fields = issues.map(candidatePath);
  const fromOverride =
    context.overridePath !== undefined &&
    context.overrideConfig !== undefined &&
    issues.some((issue) => issueFromOverride(context.overrideConfig as ConfigRecord, issue.path));
  const described = issues
    .map((issue) => {
      const field = candidatePath(issue) || '<root>';
      const where =
        context.overridePath !== undefined &&
        context.overrideConfig !== undefined &&
        issueFromOverride(context.overrideConfig as ConfigRecord, issue.path)
          ? `覆盖文件 ${context.overridePath}`
          : `配置文件 ${context.configPath}`;
      return `${field} ${describeIssue(issue)}（${where}）`;
    })
    .join('；');
  throw new ComemError(
    'INVALID_ARGUMENT',
    `${fromOverride ? '覆盖文件校验失败' : '配置校验失败'}：${described}`,
    {
      path: fromOverride ? (context.overridePath ?? context.configPath) : context.configPath,
      fields,
      ...(context.overridePath === undefined ? {} : { overridePath: context.overridePath }),
    },
  );
}

/** schema 里全部节点（对象 + 叶子）的点分路径，用于覆盖文件的未知键检查。 */
function schemaNodePaths(value: Readonly<ConfigRecord>): Set<string> {
  const paths = new Set<string>();
  const walk = (node: Readonly<ConfigRecord>, prefix: readonly string[]): void => {
    for (const [key, child] of Object.entries(node)) {
      const path = [...prefix, key];
      paths.add(path.join('.'));
      if (isRecord(child)) {
        walk(child, path);
      }
    }
  };
  walk(value, []);
  return paths;
}

/**
 * 覆盖文件的结构约束：不能写 `dataDir`，不能出现 schema 里没有的键。
 *
 * 未知键必须在启动期失败。zod 默认剥掉未知字段，拼错的键会安静地不生效——这正是
 * 「配了但没接线」最难发现的一种。
 */
export function assertOverrideShape(
  override: Readonly<ConfigRecord>,
  overridePath: string,
  defaults: Readonly<ConfigRecord>,
): void {
  if (Object.hasOwn(override, 'dataDir')) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `覆盖文件 ${overridePath} 不允许设置 dataDir：它决定覆盖文件本身的位置，改它等于换库。请改用 --data-dir 或环境变量 COMEM_DATA_DIR。`,
      { path: overridePath, field: 'dataDir' },
    );
  }
  const nodes = schemaNodePaths(defaults);
  const leaves = new Set(collectLeaves(defaults).map((leaf) => leaf.path.join('.')));
  for (const leaf of collectLeaves(override)) {
    const path = leaf.path.join('.');
    if (nodes.has(path)) {
      continue;
    }
    // 值挂在已知叶子的下面（如 `apiKey: {x: 1}`）：这是类型错误，交给 zod 报出
    // 真正的字段名，不要误报成「未知配置项 apiKey.x」。
    let prefix = '';
    if (
      leaf.path.some((segment) => {
        prefix = prefix === '' ? segment : `${prefix}.${segment}`;
        return leaves.has(prefix);
      })
    ) {
      continue;
    }
    throw new ComemError(
      'INVALID_ARGUMENT',
      `覆盖文件 ${overridePath} 里有未知配置项 ${path}（拼写错误？）。`,
      { path: overridePath, field: path },
    );
  }
}
