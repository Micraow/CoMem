/**
 * 装配阶段 5：记忆与提交流水线的前半段（记忆服务 → 合并 → 资源 → 对账 → 技能）。
 *
 * ## 记忆文件的端口语义是「原样文档」（含 frontmatter）
 *
 * 不能接 `FileSystemService`：它的 `read` 去掉 frontmatter、`write` 会用自己的
 * 序列化器重新拼一段，记忆字段会被吃掉或写出两段。用 `ContentStore` 的字节读写，
 * 写后手动通知观察者（字节路径绕过了 `FileSystemService`）。
 *
 * 记忆合并（§11.8）排在 `MemoryService` 与 `SearchService` 之后：清单来自检索索引，
 * 写回走 `MemoryService`。检索端口用**请求身份**而不是服务图身份（见
 * `ConsolidateOptions.subject`）——合并是写操作，`restricted` 切断的节点不能因为
 * 「scope 根是调用方」就被读出来。
 */

import { ConsolidationService } from '../../services/consolidation.js';
import { MemoryService } from '../../services/memory.js';
import type { MemoryServicePorts } from '../../services/memory.js';
import { ReconcileService } from '../../services/reconcile.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  ResourceService,
} from '../../services/resource.js';
import { SkillService } from '../../services/skill.js';
import { USER_WILDCARD } from '../../domain/acl.js';
import { Uri } from '../../domain/uri.js';
import type { Access } from './access.js';
import type { Foundation } from './foundation.js';
import type { Models } from './models.js';
import { FileResourceStorage } from './ports.js';
import type { Retrieval } from './retrieval.js';
import { readLimitOption, readScopesOption } from './support.js';

/** 记忆栈产物。`principals` 是调度器求权用的主体集合，与 API 请求同源。 */
export interface MemoryStack {
  readonly memory: MemoryService;
  readonly consolidation: ConsolidationService;
  readonly resource: ResourceService;
  readonly reconcile: ReconcileService;
  readonly skill: SkillService;
  readonly principals: readonly string[];
}

export function createMemory(
  core: Foundation,
  models: Models,
  access: Access,
  retrieval: Retrieval,
): MemoryStack {
  const { config, logger, store, locks, index, nodes, permissions, dataDir } = core;
  const { llm } = models;
  const { acl, subject, groups, boundPrincipal } = access;
  const { summary, search, reconcileLog, authorizer, indexObserver } = retrieval;

  /**
   * 记忆文件的端口语义是「原样文档」（含 frontmatter）。
   *
   * 不能接 `FileSystemService`：它的 `read` 去掉 frontmatter、`write` 会用自己的
   * 序列化器重新拼一段，记忆字段会被吃掉或写出两段。用 `ContentStore` 的字节读写，
   * 写后手动通知观察者（字节路径绕过了 `FileSystemService`）。
   */
  const rawFilesystem: MemoryServicePorts['filesystem'] = {
    read: async (uri) => ({
      text: Buffer.from(await store.readBytes(uri)).toString('utf8'),
    }),
    write: async (uri, text) => {
      const stat = await store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8')));
      await indexObserver.onNodeWritten(uri, 'file');
      return stat;
    },
    stat: (uri) => store.stat(uri),
    remove: async (uri) => {
      const removed = await store.remove(uri, { recursive: true });
      await indexObserver.onNodeRemoved(uri);
      return removed;
    },
    list: (uri) => store.list(uri),
  };

  const subjectScope = Uri.parse(`comem://user/${boundPrincipal.id}`);
  const principals = [subject, ...groups, USER_WILDCARD];

  const memory = new MemoryService({
    // 配置项必须真的生效：写死的复核列表让 `memory.reviewRequired` 变成假配置。
    reviewRequired: config.memory.reviewRequired,
    // 记忆文件的「读 → 序列化 → 写」由 `MemoryService` 自己持 `exact` 锁：
    // `rawFilesystem` 直接写字节，绕过了 `FileSystemService.write` 的锁。
    locks,
    filesystem: rawFilesystem,
    search: {
      find: async (query, findOptions) => {
        const hits = await search.find(query, {
          scopes: readScopesOption(findOptions, [subjectScope.toString()]),
          subject,
          principals,
          ...(readLimitOption(findOptions) === undefined
            ? {}
            : { limit: readLimitOption(findOptions) }),
        });
        return hits.map((hit) => ({
          uri: hit.uri,
          abstract: hit.abstract,
          score: hit.score,
        }));
      },
    },
    logger,
  });

  const consolidation = new ConsolidationService({
    memory,
    stat: store,
    search,
    llm,
    logger,
    maxIterations: config.memory.consolidation.maxIterations,
  });

  const resource = new ResourceService({
    store,
    locks,
    index,
    summary,
    storage: new FileResourceStorage(dataDir, reconcileLog),
    logger,
    // 写后物化权限：资源与技能服务直接写 `ContentStore`，观察者收不到通知（§12.4）。
    authorizer,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
  });

  // 重放器与写路径共用同一个 `ReconcileLog` 实例：追加与重写因此走同一条队列。
  const reconcile = new ReconcileService({
    store,
    index,
    acl,
    nodes,
    log: reconcileLog,
    logger,
  });

  // 技能与资源共用同一个 `ReconcileLog`：索引失败的对账记录由同一个重放器消费。
  const skill = new SkillService({
    store,
    locks,
    index,
    summary,
    reconcile: reconcileLog,
    permissions,
    logger,
    authorizer,
  });

  return { memory, consolidation, resource, reconcile, skill, principals };
}
