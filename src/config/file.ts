/**
 * 配置文件读取与类型转换（架构文档 §18）。
 *
 * `config.yaml` 与覆盖文件共用这一份实现：YAML 语法错误、顶层不是对象、`${VAR}`
 * 缺失、环境变量无法转换成目标类型，四种错误的判定与字段必须一致，否则同一份内容
 * 放在两个文件里会得到两种行为。
 */

import { existsSync, readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { ComemError } from '../domain/errors.js';
import { isRecord } from '../domain/guards.js';

import type { ConfigRecord, LeafKind } from './merge.js';

export type ConfigFileKind = 'config' | 'override';

function labelOf(kind: ConfigFileKind): string {
  return kind === 'override' ? '覆盖文件' : '配置文件';
}

function envError(envName: string, expected: string, raw: string): ComemError {
  return new ComemError('INVALID_ARGUMENT', `环境变量 ${envName} 不是合法的${expected}：${raw}`, {
    field: envName,
  });
}

export function coerce(raw: string, kind: LeafKind, envName: string): unknown {
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
function interpolateEnv(
  value: unknown,
  env: NodeJS.ProcessEnv,
  kind: ConfigFileKind,
): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `${labelOf(kind)}引用了未设置的环境变量 ${name}。`,
          { field: name },
        );
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, env, kind));
  }
  if (isRecord(value)) {
    const result: ConfigRecord = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = interpolateEnv(child, env, kind);
    }
    return result;
  }
  return value;
}

/**
 * 读一个配置文件。文件不存在返回空对象（两个文件都允许缺省）。
 *
 * 覆盖文件的错误消息必须带自己的路径：只说「配置校验失败」时，用户会去改
 * `config.yaml`，而真正有问题的是覆盖文件。
 */
export function readConfigFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  kind: ConfigFileKind,
): ConfigRecord {
  if (!existsSync(filePath)) {
    return {};
  }
  const content = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = interpolateEnv(parseYaml(content), env, kind);
  } catch (error) {
    if (error instanceof ComemError) {
      throw error;
    }
    throw new ComemError('INVALID_ARGUMENT', `${labelOf(kind)} ${filePath} 不是合法的 YAML。`, {
      path: filePath,
    });
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `${labelOf(kind)} ${filePath} 的顶层必须是对象。`,
      { path: filePath },
    );
  }
  return parsed;
}

export function describeIssue(issue: { readonly code: string }): string {
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

/** 读取 `--name value` 或 `--name=value`；只用于 `--config` 与 `--data-dir`。 */
export function readFlag(argv: readonly string[], name: string): string | undefined {
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
