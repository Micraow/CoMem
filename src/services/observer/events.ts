/**
 * 节点删除与移动后的派生数据重建（§7、§10.6）。
 *
 * 两个入口都返回「需要标脏的父目录」：摘要失效要由 `observer.ts` 记进 `#pending`
 * （`drain()` 的汇合点），所以排期动作留在持有队列的类里，这里只做派生存储本身。
 *
 * 每个派生存储各一步 try/catch：默认配置（`providers.embedding.type ===
 * 'disabled'`，`node_embedding` 表不存在）下向量清理必然抛错，一个 try 包住全部
 * 会把物化权限与摘要失效一起跳过（`local/notes/refactor-plan.md` 的 P1-1）。
 */

import type { EmbeddingRow } from '../../adapters/sqlite/embedding-repository.js';
import type { IndexRecord } from '../../domain/retrieval.js';
import { Uri } from '../../domain/uri.js';

import { materializeAncestors, materializePermission } from './permissions.js';
import { errorMessage } from '../../domain/errors.js';

import type { IndexObserverDeps } from './ports.js';
import { subtreeRecords } from './record.js';
import { writeMovedRecords } from './write.js';

export type EventPorts = Pick<
  IndexObserverDeps,
  'store' | 'index' | 'acl' | 'nodes' | 'permissions' | 'embeddings' | 'logger' | 'reconcile'
>;

/**
 * 派生数据的一步维护：失败只记这一步的日志，不跳过后续步骤。
 *
 * 一个 `try` 包住「索引 → 权限 → 向量 → 父摘要」时，任何一步抛错都会让后面的
 * 步骤全部跳过，而日志里只有一行泛化消息。默认配置正好会踩中：删除节点时向量清理
 * 抛 `no such table`，父目录的物化权限与摘要失效静默丢失。
 */
async function isolate(
  ports: EventPorts,
  message: string,
  details: Readonly<Record<string, string>>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    ports.logger.error(message, { ...details, error: errorMessage(error) });
    return false;
  }
}

/**
 * 删除节点后的派生数据清理；返回需要重算摘要的父目录（根节点返回空数组）。
 *
 * 索引、物化权限与向量都没有指向 `node` 的外键级联，三张表要分别删。父目录的物化行
 * 要重算：删掉子项之后，它自己的有效权限可能变了。失败要留 `op: 'permission'`
 * 记录——被删节点自己记了也会被重放器按「目标已不存在」移出，能修的只有父目录。
 */
export async function removeNodeDerived(
  ports: EventPorts,
  uri: Uri,
): Promise<readonly Uri[]> {
  const key = uri.toString();
  const details = { uri: key };

  await isolate(ports, '节点删除后清理索引失败，已忽略。', details, () =>
    ports.index.deleteByUri(key, { recursive: true }),
  );
  // 物化权限没有外键级联（见 `IndexObserverDeps.permissions`），子树的行要显式删。
  await isolate(ports, '节点删除后清理物化权限失败，已忽略。', details, () => {
    ports.permissions.deleteSubtree(key);
  });
  // 向量同理：`node_embedding` 也没有外键，删节点不清理会留下指向不存在
  // 文件的向量行——`find` 会命中一条打不开的记录。
  await isolate(ports, '节点删除后清理向量失败，已忽略。', details, () => {
    ports.embeddings?.deleteByUri(key, { recursive: true });
  });

  const parent = uri.parent();
  if (parent === null) {
    return [];
  }
  await materializePermission(ports, parent);
  return [parent];
}

/**
 * 移动 / 改名后的派生数据重建；返回源与目标父目录（去重后各一次）。
 *
 * `FileSystemService.move` 只调一个通知。分两次通知（删除 `from` + 写入 `to`）时，
 * 子项一条都不会重建：删除把整棵子树的 `node` / `node_permission` /
 * `node_embedding` 删掉，写入只写回目标节点自己。移动一个非空目录之后，子文件在
 * 磁盘上还在，但 `tree` 只剩一个空目录、`find` 搜不到、`list` 因为缺
 * `node_permission` 行返回空——而且不报错。
 *
 * **一次遍历**：目标子树只从磁盘走一遍，索引用**一次** `upsert` 写完
 * （`node` 与 `node_fts` 在同一个事务里）。逐节点写会产生 N 次索引事务与 N 次摘要
 * 失效。
 *
 * **摘要失效只投给源与目标的父目录**（去重后各一次）：子项的正文没有变，把它们
 * 的祖先链全部标脏只会让整条链白算一遍。
 *
 * **移动会丢掉 L1 行**：按磁盘重建，磁盘上没有「概览已进索引」这件事。丢的是派生
 * 数据：目标目录的 L0 行同样在这一步被写成空摘要，两条都在下一次摘要重算时恢复。
 * 索引是派生数据（§7），不在移动路径上读摘要文件，是为了让一次移动不变成 N 次摘要
 * 在锁内重新落盘。
 */
export async function moveNodeDerived(
  ports: EventPorts,
  from: Uri,
  to: Uri,
): Promise<readonly Uri[]> {
  const details = { from: from.toString(), to: to.toString() };

  const records = await subtreeRecords(ports, to, details);
  if (records === null) {
    return [];
  }

  // 索引：删掉源前缀的整棵子树，再一次性写回目标前缀的整棵子树。**两步分开**，
  // 因为它们的重放语义不同：写失败可以对账（目标文件在磁盘上，重放器能重建），
  // 删失败没有可表达的操作（重放器只会补齐存在的节点，不会删掉一条过期行）。
  const sourceCleared = await isolate(
    ports,
    '节点移动后删除源子树索引失败，已忽略。',
    details,
    () => ports.index.deleteByUri(details.from, { recursive: true }),
  );
  if (sourceCleared) {
    await writeMovedRecords(ports, records, details);
  }

  // 物化权限：源前缀的行没有外键级联，要显式删；目标前缀逐节点物化。
  await isolate(ports, '节点移动后清理源路径的物化权限失败，已忽略。', details, () => {
    ports.permissions.deleteSubtree(details.from);
  });
  // `ContentStore.move` 会 `mkdir -p` 出目标路径的祖先，它们同样没有行。
  await materializeAncestors(ports, to);
  for (const record of records) {
    const uri = Uri.parse(record.uri);
    await materializePermission(ports, uri);
    // 反查表也要按新 URI 重建：`deleteSubtree(from)` 把源子树的 `acl_entry` 删了，
    // 而 `materializeNode` 只写 `node_permission`。少了这一步，删账号时
    // `purgePrincipal` 找不到那个目录，文件里的授权撤不掉，同 ID 重建就继承旧权限。
    //
    // 只处理目录：文件没有自己的 `.acl.json`（§6.7），读它只会多一次必然的
    // ENOENT。目标侧没有文件的节点由 `syncEntriesFromFile` 直接跳过——按文件
    // 为准，没有文件就没有直接授权。
    if (record.kind === 'directory') {
      await isolate(
        ports,
        '节点移动后重建授权反查失败，已忽略。',
        { uri: record.uri },
        async () => {
          await ports.acl.syncEntriesFromFile(uri);
        },
      );
    }
  }

  // 向量：移动不改正文，旧向量按新 URI 重新挂上，不重新调模型。
  await isolate(ports, '节点移动后重挂向量失败，已忽略。', details, () => {
    rekeyEmbeddings(ports, details.from, details.to, records);
  });

  const parents = new Map<string, Uri>();
  for (const parent of [from.parent(), to.parent()]) {
    if (parent !== null) {
      parents.set(parent.toString(), parent);
    }
  }
  return [...parents.values()];
}

/**
 * 把源前缀的向量行按目标前缀重新挂上。
 *
 * 移动不改变正文，向量不需要重算（重算要调模型，而且换不出不同的结果）。`vec0`
 * 不支持 UPSERT（见 `EmbeddingRepository.upsert`），所以是「读旧行 → 删旧前缀 →
 * 插新行」，旧 URI 由新 URI 按前缀替换推出来。
 */
function rekeyEmbeddings(
  ports: EventPorts,
  from: string,
  to: string,
  records: readonly IndexRecord[],
): void {
  const embeddings = ports.embeddings;
  if (embeddings === undefined) {
    return;
  }
  const oldUris = records.map((record) => `${from}${record.uri.slice(to.length)}`);
  const byOldUri = new Map(embeddings.getMany(oldUris).map((row) => [row.uri, row]));

  const rekeyed: EmbeddingRow[] = [];
  for (const [index, record] of records.entries()) {
    const row = byOldUri.get(oldUris[index] ?? '');
    if (row !== undefined) {
      rekeyed.push({ ...row, uri: record.uri });
    }
  }

  embeddings.deleteByUri(from, { recursive: true });
  embeddings.upsert(rekeyed);
}
