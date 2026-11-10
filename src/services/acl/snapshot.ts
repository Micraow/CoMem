/**
 * ACL 快照的读取：把「根 → 目标」的目录链从 `.acl.json` 读成 `AclNode[]`。
 *
 * 文件读取只发生在链上，并按目录缓存——`tree` 里 1000 个兄弟节点共享同一条祖先
 * 链（§8.2 的硬伤是「一条候选 open 5 层目录」，不是「读一次链」）。
 */

import type { AclFile, AclFileStore } from '../../adapters/fs/acl-file.js';
import { effectiveAcl } from '../../domain/acl.js';
import type { AclLevel, AclNode } from '../../domain/acl.js';
import type { NodeKind } from '../../domain/node.js';
import type { Uri } from '../../domain/uri.js';
import { collectPrincipals, ownerOf } from './evaluate.js';
import { fromAclFileEntry } from './levels.js';
import type { AclPorts, AclState } from './types.js';

/** 按目录缓存 `.acl.json` 的读取结果；`null` 是「没有文件」，与空条目不同。 */
export type AclFileCache = Map<string, AclFile | null>;

/** 读出目录当前的领域形态（`setAcl` 转换函数的输入）。 */
export async function readState(aclFile: AclFileStore, uri: Uri): Promise<AclState> {
  const file = await aclFile.read(uri);
  return {
    mode: file?.mode ?? 'inherit',
    entries: file?.entries.map(fromAclFileEntry) ?? [],
  };
}

/**
 * 快照读取与级联求值：链 → 每个主体的有效权限集合。
 *
 * 空集不放进 map：「有效权限」表里出现一行空值只会让人以为它是一条授权。
 */
export async function readSnapshot(
  ports: Pick<AclPorts, 'aclFile' | 'nodes'>,
  uri: Uri,
): Promise<{
  readonly mode: AclState['mode'];
  readonly entries: AclState['entries'];
  readonly effective: ReadonlyMap<string, ReadonlySet<AclLevel>>;
}> {
  const { aclFile } = ports;
  const file = await aclFile.read(uri);
  const chain = await readChain(aclFile, uri, 'directory', new Map<string, AclFile | null>());

  const effective = new Map<string, ReadonlySet<AclLevel>>();
  for (const principal of collectPrincipals(chain)) {
    const levels = effectiveAcl(chain, principal);
    if (levels.size > 0) {
      effective.set(principal, levels);
    }
  }

  return {
    mode: file?.mode ?? 'inherit',
    entries: file?.entries.map(fromAclFileEntry) ?? [],
    effective,
  };
}

/** 根 → 目标目录的链。文档节点不把自己算进去（见 `materialize.ts` 的子树重算）。 */
export async function readChain(
  aclFile: AclFileStore,
  uri: Uri,
  kind: NodeKind,
  cache: AclFileCache,
): Promise<readonly AclNode[]> {
  const directories: Uri[] = [];
  let current: Uri | null = kind === 'document' ? uri.parent() : uri;
  while (current !== null) {
    directories.push(current);
    current = current.parent();
  }
  directories.reverse();

  const chain: AclNode[] = [];
  for (const directory of directories) {
    const file = await readAcl(aclFile, directory, cache);
    chain.push({
      uri: directory,
      owner: ownerOf(directory),
      mode: file?.mode ?? 'inherit',
      entries: file?.entries.map(fromAclFileEntry) ?? [],
    });
  }
  return chain;
}

/** 按目录缓存 `.acl.json` 读取；没有文件等价于 `{mode:'inherit', entries:[]}`。 */
async function readAcl(
  aclFile: AclFileStore,
  directory: Uri,
  cache: AclFileCache,
): Promise<AclFile | null> {
  const key = directory.toString();
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  const file = await aclFile.read(directory);
  cache.set(key, file);
  return file;
}
