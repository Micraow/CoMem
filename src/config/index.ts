/**
 * 配置加载与校验（架构文档 §18、§6.5）。
 *
 * 优先级：CLI 参数 > 环境变量 `COMEM_<SECTION>_<KEY>` > 配置文件 > 内置默认值。
 * YAML 里的 `${VAR}` 会在加载时展开成环境变量值，缺失即报错——静默保留字面量会
 * 让错误推迟到第一次调用模型时才出现。
 */

import { existsSync, readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { ComemError } from '../domain/errors.js';

import { resolveDataDir } from './data-dir.js';
import { configSchema, type ComemConfig } from './schema.js';

export interface LoadConfigOptions {
  /** 配置文件路径。默认 `config.yaml`（相对当前工作目录），可用 `--config` 覆盖 */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** 进程参数，只识别 `--config` 与 `--data-dir` */
  argv?: string[];
}

const DEFAULT_CONFIG_FILE = 'config.yaml';

type ConfigRecord = Record<string, unknown>;

type LeafKind = 'string' | 'number' | 'boolean' | 'array';

interface LeafPath {
  readonly path: readonly string[];
  readonly kind: LeafKind;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafKindOf(value: unknown): LeafKind {
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

function collectLeaves(value: ConfigRecord, prefix: readonly string[] = []): LeafPath[] {
  const leaves: LeafPath[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isRecord(child)) {
      leaves.push(...collectLeaves(child, path));
    } else {
      leaves.push({ path, kind: leafKindOf(child) });
    }
  }
  return leaves;
}

/** `retrieval.assembly.maxTokens` → `COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS` */
function envNameFor(path: readonly string[]): string {
  const joined = path.map((segment) => segment.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
  return `COMEM_${joined.join('_')}`;
}

function mergeConfig(base: ConfigRecord, override: ConfigRecord): ConfigRecord {
  const result: ConfigRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value;
  }
  return result;
}

function setPath(target: ConfigRecord, path: readonly string[], value: unknown): ConfigRecord {
  const [head, ...rest] = path;
  if (head === undefined) {
    return target;
  }
  if (rest.length === 0) {
    return { ...target, [head]: value };
  }
  const current = target[head];
  return { ...target, [head]: setPath(isRecord(current) ? current : {}, rest, value) };
}

function envError(envName: string, expected: string, raw: string): ComemError {
  return new ComemError('INVALID_ARGUMENT', `环境变量 ${envName} 不是合法的${expected}：${raw}`, {
    field: envName,
  });
}

function coerce(raw: string, kind: LeafKind, envName: string): unknown {
  switch (kind) {
    case 'number': {
      const parsed = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(parsed)) {
        throw envError(envName, '数字', raw);
      }
      return parsed;
    }
    case 'boolean': {
      const lowered = raw.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') {
        return true;
      }
      if (lowered === 'false' || lowered === '0') {
        return false;
      }
      throw envError(envName, '布尔值（true / false / 1 / 0）', raw);
    }
    case 'array': {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // 落到下面统一报错
      }
      throw envError(envName, 'JSON 数组', raw);
    }
    default:
      return raw;
  }
}

/** 展开字符串里的 `${VAR}`。缺失的变量直接报错，不留下字面量。 */
function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        throw new ComemError('INVALID_ARGUMENT', `配置文件引用了未设置的环境变量 ${name}。`, {
          field: name,
        });
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, env));
  }
  if (isRecord(value)) {
    const result: ConfigRecord = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = interpolateEnv(child, env);
    }
    return result;
  }
  return value;
}

function readConfigFile(filePath: string, env: NodeJS.ProcessEnv): ConfigRecord {
  if (!existsSync(filePath)) {
    return {};
  }
  const content = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = interpolateEnv(parseYaml(content), env);
  } catch (error) {
    if (error instanceof ComemError) {
      throw error;
    }
    throw new ComemError('INVALID_ARGUMENT', `配置文件 ${filePath} 不是合法的 YAML。`, {
      path: filePath,
    });
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new ComemError('INVALID_ARGUMENT', `配置文件 ${filePath} 的顶层必须是对象。`, {
      path: filePath,
    });
  }
  return parsed;
}

function describeIssue(issue: { readonly code: string }): string {
  switch (issue.code) {
    case 'invalid_type':
      return '类型不符合要求';
    case 'too_small':
      return '取值过小';
    case 'too_big':
      return '取值过大';
    case 'invalid_value':
    case 'invalid_union':
      return '取值不在允许范围内';
    default:
      return '取值不合法';
  }
}

function validate(candidate: ConfigRecord, filePath: string): ComemConfig {
  const result = configSchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  const fields = result.error.issues.map((issue) => issue.path.join('.'));
  const described = result.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'} ${describeIssue(issue)}`)
    .join('；');
  throw new ComemError('INVALID_ARGUMENT', `配置校验失败：${described}`, {
    path: filePath,
    fields,
  });
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === prefixed) {
      return argv[index + 1];
    }
    if (arg !== undefined && arg.startsWith(`${prefixed}=`)) {
      return arg.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

/**
 * 加载配置。文件不存在时使用内置默认值（不报错）。
 * 返回的 `dataDir` 一定非空：为空时按 §6.5 推导。
 */
export function loadConfig(options: LoadConfigOptions = {}): ComemConfig {
  const env = options.env ?? process.env;
  const argv = options.argv ?? [];
  const filePath = options.path ?? readFlag(argv, 'config') ?? DEFAULT_CONFIG_FILE;

  const defaults: ConfigRecord = configSchema.parse({});
  const fileConfig = readConfigFile(filePath, env);

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

  const parsed = validate(mergeConfig(mergeConfig(defaults, fileConfig), envOverrides), filePath);
  return {
    ...parsed,
    dataDir: parsed.dataDir === '' ? resolveDataDir({ env }) : parsed.dataDir,
  };
}

export type { ComemConfig };
export { configSchema, resolveDataDir };
