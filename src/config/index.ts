/**
 * 配置加载与校验（架构文档 §18、§6.5）。
 *
 * 优先级：CLI 参数 > 环境变量 `COMEM_<SECTION>_<KEY>` > 覆盖文件 > 配置文件 > 内置默认值。
 * YAML 里的 `${VAR}` 会在加载时展开成环境变量值，缺失即报错——静默保留字面量会
 * 让错误推迟到第一次调用模型时才出现。
 *
 * ## 覆盖文件是两阶段加载
 *
 * `dataDir` 本身在配置里，覆盖文件的位置又由它决定，所以不能一次读完：
 *
 * 1. 先合并 `config.yaml` + 环境变量 + 默认值，只解析出 `dataDir`；
 * 2. 读 `{dataDir}/_meta/config.override.yaml`（不存在 = 空对象），合并进**文件层**
 *    （在环境变量之下），再完整 `safeParse` 一次。
 *
 * 覆盖文件不允许写 `dataDir`：它决定文件自己在哪里，改它等于换库。覆盖文件里的
 * 未知键（拼写错误）与类型错误都在启动期失败，错误消息带覆盖文件路径与字段。
 * 校验实现见 `validate.ts`。
 */

import { join } from 'node:path';

import { resolveDataDir } from './data-dir.js';
import { coerce, readConfigFile, readFlag } from './file.js';
import {
  collectLeaves,
  envNameFor,
  getPath,
  hasPath,
  mergeConfig,
  setPath,
  type ConfigRecord,
} from './merge.js';
import { configSchema, type ComemConfig } from './schema.js';
import { assertOverrideShape, parseDataDir, validateConfigCandidate } from './validate.js';

export interface LoadConfigOptions {
  /** 配置文件路径。默认 `config.yaml`（相对当前工作目录），可用 `--config` 覆盖 */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** 进程参数，只识别 `--config` 与 `--data-dir` */
  argv?: string[];
  /** 覆盖容器判定。默认按 `/.dockerenv` 或 pid 1（§6.5）；测试固定它 */
  container?: boolean;
  /** 覆盖 root 判定。默认 `process.getuid?.() === 0`（§6.5）；测试固定它 */
  isRoot?: boolean;
}

/** 每个叶子实际生效的来源。 */
export type ConfigSource = 'default' | 'file' | 'override' | 'env';

/** 一次加载的完整快照：生效值 + 四层输入（配置端点只读消费）。 */
export interface ConfigSnapshot {
  readonly config: ComemConfig;
  readonly configPath: string;
  readonly overridePath: string;
  /** 点分路径 → 来源。 */
  readonly sources: ReadonlyMap<string, ConfigSource>;
  readonly defaults: ConfigRecord;
  readonly fileConfig: ConfigRecord;
  readonly overrideConfig: ConfigRecord;
  readonly envOverrides: ConfigRecord;
  /** 启动时的环境变量快照：PATCH 重读覆盖文件时仍按同一份 `${VAR}` 展开。 */
  readonly env: NodeJS.ProcessEnv;
}

export interface ConfigPaths {
  readonly configPath: string;
  readonly dataDir: string;
  readonly overridePath: string;
}

const DEFAULT_CONFIG_FILE = 'config.yaml';

/** 覆盖文件固定的文件名；目录由 `dataDir` 决定（架构文档 §6.5 的 `_meta/`）。 */
const OVERRIDE_CONFIG_FILE = 'config.override.yaml';

/** `{dataDir}/_meta/config.override.yaml`。 */
function overridePathFor(dataDir: string): string {
  return join(dataDir, '_meta', OVERRIDE_CONFIG_FILE);
}

interface ConfigLayers {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath: string;
  readonly defaults: ConfigRecord;
  readonly fileConfig: ConfigRecord;
  readonly envOverrides: ConfigRecord;
  readonly dataDir: string;
}

/**
 * 阶段一：合并配置文件与环境变量，只解析 `dataDir`。
 *
 * 完整校验留到覆盖文件合并之后——否则「config.yaml 里配了 disabled、覆盖文件里
 * 改成可用模型」会被阶段一的交叉校验提前拒绝。
 */
function resolveLayers(options: LoadConfigOptions): ConfigLayers {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const argv = options.argv ?? [];
  const configPath = options.path ?? readFlag(argv, 'config') ?? DEFAULT_CONFIG_FILE;

  const defaults = configSchema.parse({}) as ConfigRecord;
  const fileConfig = readConfigFile(configPath, env, 'config');

  let envOverrides: ConfigRecord = {};
  for (const leaf of collectLeaves(defaults)) {
    const envName = envNameFor(leaf.path);
    const raw = env[envName];
    if (raw === undefined) {
      continue;
    }
    envOverrides = setPath(envOverrides, leaf.path, coerce(raw, leaf.kind, envName));
  }

  const dataDirFromArgv = readFlag(argv, 'data-dir');
  if (dataDirFromArgv !== undefined && dataDirFromArgv !== '') {
    envOverrides = setPath(envOverrides, ['dataDir'], dataDirFromArgv);
  }

  const preliminary = parseDataDir(
    mergeConfig(mergeConfig(defaults, fileConfig), envOverrides),
    configPath,
  );
  const dataDir =
    preliminary === ''
      ? resolveDataDir({ env, container: options.container, isRoot: options.isRoot })
      : preliminary;
  return { env, configPath, defaults, fileConfig, envOverrides, dataDir };
}

/** 只回答「两个配置文件在哪、数据根在哪」（`check-config.ts` 用它找覆盖文件）。 */
export function resolveConfigPaths(options: LoadConfigOptions = {}): ConfigPaths {
  const layers = resolveLayers(options);
  return {
    configPath: layers.configPath,
    dataDir: layers.dataDir,
    overridePath: overridePathFor(layers.dataDir),
  };
}

function sourceOf(
  path: readonly string[],
  layers: Readonly<{
    env: Readonly<ConfigRecord>;
    override: Readonly<ConfigRecord>;
    file: Readonly<ConfigRecord>;
  }>,
): ConfigSource {
  // `COMEM_DATA_DIR=` 是「没提供」：`resolveDataDir` 也按空串处理，来源不应标成 env。
  const dataDirFromEnvIsEmpty =
    path.length === 1 && path[0] === 'dataDir' && getPath(layers.env, path) === '';
  if (!dataDirFromEnvIsEmpty && hasPath(layers.env, path)) {
    return 'env';
  }
  if (hasPath(layers.override, path)) {
    return 'override';
  }
  if (hasPath(layers.file, path)) {
    return 'file';
  }
  return 'default';
}

/**
 * 加载配置并保留来源信息。`loadConfig` 只取 `.config`；配置端点要回答「这个值从
 * 哪一层来」，所以必须在这里留下四层输入，而不是在请求时重读磁盘。
 */
export function loadConfigSnapshot(options: LoadConfigOptions = {}): ConfigSnapshot {
  const { env, configPath, defaults, fileConfig, envOverrides, dataDir } =
    resolveLayers(options);

  // 阶段二：覆盖文件合并进文件层（环境变量仍在它上面），再完整校验一次。
  const overridePath = overridePathFor(dataDir);
  const overrideConfig = readConfigFile(overridePath, env, 'override');
  assertOverrideShape(overrideConfig, overridePath, defaults);

  const parsed = validateConfigCandidate(
    mergeConfig(mergeConfig(mergeConfig(defaults, fileConfig), overrideConfig), envOverrides),
    { configPath, overridePath, overrideConfig },
  );
  const config: ComemConfig = {
    ...parsed,
    dataDir: parsed.dataDir === '' ? dataDir : parsed.dataDir,
  };

  const sources = new Map<string, ConfigSource>();
  for (const leaf of collectLeaves(defaults)) {
    sources.set(
      leaf.path.join('.'),
      sourceOf(leaf.path, { env: envOverrides, override: overrideConfig, file: fileConfig }),
    );
  }

  return {
    config,
    configPath,
    overridePath,
    sources,
    defaults,
    fileConfig,
    overrideConfig,
    envOverrides,
    env,
  };
}

/**
 * 加载配置。文件不存在时使用内置默认值（不报错）。
 * 返回的 `dataDir` 一定非空：为空时按 §6.5 推导。
 */
export function loadConfig(options: LoadConfigOptions = {}): ComemConfig {
  return loadConfigSnapshot(options).config;
}

export type { ComemConfig };
export { configSchema, resolveDataDir };
