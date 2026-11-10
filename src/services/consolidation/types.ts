/**
 * 记忆合并的跨文件类型：依赖、选项、结果、端口与写盘计划（架构文档 §11.8）。
 *
 * 类型集中在这里，是为了让 `inventory.ts` / `plan.ts` / `apply.ts` 的签名直接写出
 * 「用到哪些能力、产出什么形状」。轮次状态（已读正文、trace、轮次计数）不在这里：
 * 它跨轮存活，跟着 `service.ts` 的类实例走。
 */

import type { ZodType } from 'zod';

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { ConsolidationOperation } from '../../domain/consolidation.js';
import type { LlmPrompt } from '../../domain/llm.js';
import type { Logger } from '../../domain/log.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';
import type { Uri } from '../../domain/uri.js';

import type { MemoryService } from '../memory.js';
import type { SearchService } from '../search.js';

export interface ConsolidationServiceDeps {
  readonly memory: Pick<MemoryService, 'read' | 'upsertMemory' | 'remove'>;
  /**
   * 文件系统层面的存在性判断（`ContentStore.stat` 的 `Pick`）：按**路径**看磁盘上
   * 有没有东西、是文件还是目录，不解析 frontmatter，也不求权。
   *
   * 为什么不是 `FileSystemService.stat`：它的签名要 `principals`，且先 `assert` 再
   * 看磁盘；物化权限行只对真实存在的节点生成，所以对**不存在的路径**它会抛
   * `PERMISSION_DENIED`。拿它判断「路径空着」就必须吞掉一个真实的权限错误，而
   * 「权限被拒」与「不存在」是两种不同的结论。`MemoryService` 的文件系统端口
   * （`MemoryServicePorts['filesystem'].stat`，装配见 container 的 `rawFilesystem`）
   * 用的就是同一个方法，这里收窄到只取 `stat`。
   */
  readonly stat: Pick<ContentStore, 'stat'>;
  /**
   * 枚举 scope 下记忆文件的检索端口。
   *
   * `FindOptions` 要调用方身份（`subject` / `principals`），而服务本身拿不到请求
   * 上下文——身份走 `consolidate` 的选项（见那里的说明）。
   */
  readonly search: Pick<SearchService, 'glob'>;
  /**
   * 模型调用。
   *
   * 端口是 `services/llm.ts` 的 `generateJson` 形状，不是 `domain/llm.ts` 的
   * `LlmProvider`：重试、截断判定与用量统计都在 `LlmService` 里（§11.4），直接
   * 用 provider 会把这三件事悄悄丢掉。
   */
  readonly llm: {
    generateJson<T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T>;
  };
  readonly logger: Logger;
  /** 最大轮次。默认 10，来源见 `DEFAULT_MAX_ITERATIONS`。 */
  readonly maxIterations?: number;
}

export interface ConsolidateOptions {
  /**
   * 只返回 `adds` / `updates` / `deletes`，不写任何东西。
   *
   * **默认 `true`**：合并会 `delete`，不传就等于预览。要真的写必须显式传
   * `false`（§11.8、HTTP 端点的同一条默认值）。
   */
  readonly dryRun?: boolean;
  /** 调用方身份（`user:alice` / `group:eng`），进检索日志与审计。 */
  readonly subject: string;
  /**
   * 调用方已展开的主体集合（含 `user:*` 与全部组，§12.4）。
   *
   * 清单与正文的权限过滤用它，不用 scope 根主体：两者只在「scope 根就是调用方」
   * 时相同，而 `restricted` 节点的存在让它们可能不同。
   */
  readonly principals: readonly string[];
}

/** 每一轮的模型输出摘要，用于排查「为什么它做了这个决定」。 */
export interface ConsolidationTraceEntry {
  readonly iteration: number;
  readonly action: 'read' | 'finish';
  /** 这一轮请求读取的 URI；`finish` 轮为空。 */
  readonly readUris: readonly string[];
  /** 这一轮的意图：读了什么，或产出了哪些操作（含每条操作的理由）。 */
  readonly summary: string;
}

export interface ConsolidationResult {
  readonly adds: readonly string[];
  readonly updates: readonly string[];
  readonly deletes: readonly string[];
  /** 每一轮的模型输出摘要，用于排查「为什么它做了这个决定」 */
  readonly trace: readonly ConsolidationTraceEntry[];
}

/** 跨文件函数用的依赖子集：显式传端口，不读类实例。 */
export interface ConsolidationPorts {
  readonly memory: ConsolidationServiceDeps['memory'];
  readonly stat: ConsolidationServiceDeps['stat'];
  readonly search: ConsolidationServiceDeps['search'];
  readonly logger: ConsolidationServiceDeps['logger'];
}

/**
 * scope 下的记忆清单。
 *
 * `candidates` 进 prompt（**不带正文**，正文要模型显式 `read`）；`uris` 是 scope 下
 * **active** 记忆文件的 URI，用作 `validateOperations` 的 `existing`。`glob` 是
 * 检索面（§8.4），只返回 `status = 'active'` 的节点（§11.7），所以 `pending` /
 * `archived` 的记忆不在 `uris` 里——它们由 `plan.ts` 在写盘前按路径复查（见那里的
 * 注释），不能靠清单兜住。
 */
export interface ScopeInventory {
  readonly candidates: readonly InventoryEntry[];
  readonly uris: ReadonlySet<string>;
}

/** 清单里的一条记忆。**不带正文**：正文要模型显式 `read`。 */
export interface InventoryEntry {
  readonly uri: string;
  readonly memoryType: string;
  readonly summary: string;
  readonly updatedAt: string;
}

export interface ConsolidationPromptInput {
  readonly scope: string;
  readonly inventory: readonly InventoryEntry[];
  readonly reads: ReadonlyMap<string, string>;
  readonly iteration: number;
  readonly maxIterations: number;
}

/**
 * 一条写盘计划。
 *
 * `delete` 没有 `schema` / `values`：它只需要 URI。`schema === null` 是这个联合的
 * 判别标签，`plan.ts` 与 `apply.ts` 都按它分叉。
 */
export interface DeletePlan {
  readonly operation: ConsolidationOperation;
  readonly uri: Uri;
  readonly schema: null;
  readonly values: null;
}

export interface UpsertPlan {
  readonly operation: ConsolidationOperation;
  readonly uri: Uri;
  readonly schema: MemoryTypeSchema;
  /** `upsertMemory` 的入参（identity + content）；路径由 `renderMemoryUri` 重渲染。 */
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * 本批**被删除**的记忆的归档来源，写回时并进这条保留者的 `sources`（W97）。
   *
   * 模型的操作里没有「哪条被并进了哪条」的映射：`update`/`add` 给正文，`delete`
   * 只给理由。所以只能按「本批删除的全部来源」并进本批写出的每一条——被删记忆的
   * 正文确实参与了这批收敛，丢掉来源等于把「这条记忆综合了哪几次归档」永久抹掉。
   * 代价是同一批里如果有两组互不相关的合并，两组都会带上对方的来源；模型输出里
   * 没有可用的分组信号，宁可多记也不丢（`sources` 只是溯源，不参与检索与权限）。
   *
   * 值是 `plan.ts` 里已经过 `Uri.tryParse` 的对象：写盘阶段直接传给 `provenance`，
   * 不再解析第二遍（同一个值解析两次，就是两处校验将来会分叉的地方）。
   */
  readonly sources: readonly Uri[];
}

export type WritePlan = DeletePlan | UpsertPlan;
