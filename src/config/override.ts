/**
 * 覆盖文件的读取与原子写入（架构文档 §18）。
 *
 * 写路径的顺序是**先校验、后落盘**：候选配置走完整 `safeParse`（含交叉校验），
 * 不合法时一个字节都不写。合法时用「临时文件 + `rename`」落盘，权限 `0600`——
 * 覆盖文件可能含 `apiKey` 明文。
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { ComemError, errorMessage } from '../domain/errors.js';

import { readConfigFile } from './file.js';
import { mergeConfig, nestedFromFlat, type ConfigRecord } from './merge.js';
import type { ConfigSnapshot } from './index.js';
import { assertOverrideShape, validateConfigCandidate } from './validate.js';

/**
 * 读当前磁盘上的覆盖文件并做结构校验。
 *
 * 每次 PATCH 都重读而不是复用启动快照：用户可能在两次保存之间手工改过文件，
 * 用旧值覆盖会把那些改动吞掉。
 */
export function readOverride(snapshot: ConfigSnapshot): ConfigRecord {
  const current = readConfigFile(snapshot.overridePath, snapshot.env, 'override');
  assertOverrideShape(current, snapshot.overridePath, snapshot.defaults);
  return current;
}

/**
 * 合并 PATCH 的扁平值并校验**完整的**候选配置。
 *
 * 返回要写入的覆盖文件内容；校验失败时抛 `INVALID_ARGUMENT`（错误指向覆盖文件与
 * 字段），调用方还没碰到磁盘。
 */
export function nextOverrideFor(
  snapshot: ConfigSnapshot,
  current: ConfigRecord,
  values: Readonly<ConfigRecord>,
): ConfigRecord {
  const next = mergeConfig(current, nestedFromFlat(values));
  const candidate = mergeConfig(
    mergeConfig(mergeConfig(snapshot.defaults, snapshot.fileConfig), next),
    snapshot.envOverrides,
  );
  validateConfigCandidate(candidate, {
    configPath: snapshot.configPath,
    overridePath: snapshot.overridePath,
    overrideConfig: next,
  });
  return next;
}

/**
 * 原子写覆盖文件：同目录临时文件 + `rename`。
 *
 * `rename` 在同一文件系统内是原子的，读方要么看到旧文件、要么看到新文件，不会
 * 读到写了一半的 YAML。失败时清掉临时文件，不留半截产物。
 */
export async function writeOverrideFile(
  overridePath: string,
  value: Readonly<ConfigRecord>,
): Promise<void> {
  const directory = dirname(overridePath);
  const temporary = `${overridePath}.${process.pid.toString(36)}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, stringifyYaml(value), { encoding: 'utf8', mode: 0o600 });
    // `writeFile` 的 mode 会被 umask 削掉位；显式 chmod 保证密钥文件权限就是 0600。
    await chmod(temporary, 0o600);
    await rename(temporary, overridePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // 临时文件可能根本没创建（如父路径不是目录）；清理失败不覆盖原始错误。
    }
    throw new ComemError('INTERNAL', `写入配置覆盖文件失败：${overridePath}`, {
      path: overridePath,
      error: errorMessage(error),
    });
  }
}
