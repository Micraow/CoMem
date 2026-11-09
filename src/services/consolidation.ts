/**
 * 记忆合并（架构文档 §11.8）。
 *
 * ## 为什么是 agentic 循环
 *
 * 合并要判断「两条记忆里是不是有一条已经被取代」。这个判断需要**读正文**：
 * 摘要只说明「这条讲什么」，说明不了「这条与那条哪条仍然有效」。相似度阈值在这里
 * 没有用——两条互相矛盾的约定同样相似，按阈值合并只会得到「都留下」或「不分青红
 * 地删一条」。
 *
 * 所以决策交给模型，但模型不是一次输出：它先看清单、再按需读正文、最后给操作。
 * 这是一次**有界**的探索。
 *
 * ## 为什么用多轮 `completeJson` 而不是 function calling
 *
 * `LlmProvider` 只有 `complete` / `completeJson`（§4.4），没有 tool calling。
 * 每一轮的输出是一个 JSON 对象：`{"action": "read", "uris": [...]}` 表示「再给我
 * 这些文件的正文」，`{"action": "finish", "operations": [...]}` 表示结束。这等价于
 * 两个工具（`read` / `finish`），且不需要供应商支持函数调用。
 *
 * ## 轮次上限
 *
 * 默认 10 轮（`DEFAULT_MAX_ITERATIONS`，来源见常量注释）。到上限还没 `finish` 就
 * 抛 `RESOURCE_EXHAUSTED`，**不做部分应用**：一个只合并了一半的记忆库比没合并更难
 * 解释。
 *
 * ## 破坏性与隔离
 *
 * `delete` 是删除操作，所以：
 *
 * - 调用方必须先确认（HTTP 端点的 `dryRun` 默认 `true`，见路由）；
 * - 只允许操作显式给出的 scope 下的记忆——**不展开组**：`comem://group/eng/` 的
 *   记忆不会因为调用者有 `group:eng` 就被合并。合并是写操作，scope 必须显式指定
 *   （`validateOperations` 的 `allowedScopes` 保证）；
 * - 清单与正文的读取用**调用方自己的 principals**（`consolidate` 的 `subject` /
 *   `principals`）：用 scope 根主体的身份去读会把 `restricted` 切断的节点也读出来，
 *   然后删掉一条调用方本来无权看到的记忆。
 *
 * ## 回滚语义
 *
 * `MemoryService` 没有事务（它是「一个文件一条记忆」），`filesystem` 端口也拿不回
 * 逐字节的前像（`created_at`、`status` 都会在重写时被重新计算）。所以这里**不做
 * 假回滚**：写盘前的全部校验（URI 合法、类型可还原、identity 与路径一致、
 * `addOnly` 类型不能 update、被删记录的 `sources` 全是合法 URI、写回字段的类型与
 * identity 齐备）都在任何写入之前完成，把「中途失败」压到只剩 I/O 与加锁失败；
 * 真的中途失败时，错误 `details` 里带上已经应用过的 `adds` / `updates` /
 * `deletes`，由运维按这份清单收尾。
 *
 * 其中字段类型与 identity 的校验和 `upsertMemory` 锁内那份是**同一实现**
 * （`domain/memory-type.ts`）：锁内那次不能省，它挡的是「计划与写入之间文件被别的
 * 写者改过」；这里这次挡的是「删除已应用、写回才失败」。解析结果也一样——被删
 * 记录的 `sources` 在这里解析成 `Uri`，写盘阶段直接用，不解析第二遍。
 *
 * ## 并发
 *
 * 锁在 `MemoryService` 里，一条记忆一把 `exact` 锁（§18「并发控制」）。这里**不再
 * 自己持锁**：`PathLockManager` 不可重入，外层再拿一把同 URI 的锁会等自己，5 秒后
 * 抛 `CONFLICT`；而外层的锁本来也盖不住读——`#plan` 的正文读取发生在它之前。
 *
 * 代价是「锁拿不到时整批不应用」不再成立：中途 `CONFLICT` 时前面几条已经写盘。
 * 这与其它写盘失败同一条出口——错误 `details` 里带上已应用的清单，由运维收尾。
 *
 * 写盘按 URI 升序**执行**（不是为了加锁）：`adds` / `updates` / `deletes` 的
 * 顺序因此是确定的，报告与日志可以直接比对。
 */

import { z } from 'zod';
import type { ZodType } from 'zod';

import type { ContentStore } from '../adapters/fs/content-store.js';
import {
  resolveMemoryTarget,
  validateOperations,
  type ConsolidationOperation,
} from '../domain/consolidation.js';
import { ComemError } from '../domain/errors.js';
import type { LlmPrompt } from '../domain/llm.js';
import type { Logger } from '../domain/log.js';
import {
  assertFieldTypes,
  assertMemoryIdentity,
  identityFields,
  type MemoryTypeSchema,
} from '../domain/memory-type.js';
import { Uri } from '../domain/uri.js';

import { appendSources, renderMemoryUri, type MemoryRecord, type MemoryService } from './memory.js';
import type { SearchService } from './search.js';

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

/**
 * 最大轮次。
 *
 * **10 是设计约定的上界，不是实测值**：每轮至少一次完整模型调用，10 轮已经足够
 * 读完一个 scope 的主要记忆；再往上只会让一次合并烧掉几十次调用，而收敛通常发生在
 * 前几轮。到第 10 轮还没 `finish` 说明模型在无目的探索，继续给它轮次只会更贵。
 *
 * 可以通过 `memory.consolidation.maxIterations` 覆盖。
 */
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * 清单最多枚举多少条记忆。
 *
 * **200 是经验值，来源是 prompt 预算**：一条清单约 100 字符（URI + 类型 + 200 字符
 * 摘要），200 条约 20k 字符 ≈ 5k token；加上 10 轮读到的正文仍在常见 32k 上下文内。
 * 更多记忆应该先按目录拆 scope，而不是把清单撑到模型看不完。
 */
const INVENTORY_LIMIT = 200;

/**
 * 清单里每条记忆的摘要长度（字符）。
 *
 * **200 是经验值**：够区分「code-style」与「license-review」这类同目录记忆
 * （约 50 token），又不至于让清单本身吃掉正文预算。
 */
const SUMMARY_CHARS = 200;

/** scope 下放记忆的目录（§6.5）。 */
const MEMORIES_DIRECTORY = 'memories';

/**
 * 版本快照所在的隐藏目录（`memories/{type}/.history/`，W98）。
 *
 * 与 `MemoryService` 的 `HISTORY_DIRECTORY` 是同一个目录名，但**不复用它**：那个
 * 常量是记忆服务的内部实现（写入方的约定），导出来会把「合并服务不许把版本当记忆」
 * 这条判断绑到写入方的私有结构上。名字在这里各写一份，漂移时的表现是清单里又出现
 * 版本文件（本文件的测试会红），不是静默地删掉一份版本。
 */
const HISTORY_DIRECTORY = '.history';

/** 记忆文件的扩展名。与 `MemoryService` 写入的形状一致。 */
const GLOB_PATTERN = '**/*.md';

const CONTENT_FIELD = 'content';

/**
 * 模型每一轮的输出。
 *
 * `content` 用 `nullish` 而不是 `nullable`：`delete` 忘记写 `content: null` 是最
 * 常见的形状错误，为它让整轮解析失败、再重试一次毫无收益——归一化成 `null` 之后
 * `validateOperations` 会给出「content 不能为空」这种能定位的消息。
 */
const consolidationOutputSchema = z.object({
  action: z.enum(['read', 'finish']),
  uris: z.array(z.string()).optional(),
  operations: z
    .array(
      z.object({
        kind: z.enum(['add', 'update', 'delete']),
        uri: z.string(),
        content: z.string().nullish(),
        reason: z.string(),
      }),
    )
    .optional(),
});

type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;

/**
 * scope 下的记忆清单。
 *
 * `candidates` 进 prompt（**不带正文**，正文要模型显式 `read`）；`uris` 是 scope 下
 * **active** 记忆文件的 URI，用作 `validateOperations` 的 `existing`。`glob` 是
 * 检索面（§8.4），只返回 `status = 'active'` 的节点（§11.7），所以 `pending` /
 * `archived` 的记忆不在 `uris` 里——它们由 `#plan` 在写盘前按路径复查（见那里的
 * 注释），不能靠清单兜住。
 */
interface ScopeInventory {
  readonly candidates: readonly InventoryEntry[];
  readonly uris: ReadonlySet<string>;
}

/** 清单里的一条记忆。**不带正文**：正文要模型显式 `read`。 */
interface InventoryEntry {
  readonly uri: string;
  readonly memoryType: string;
  readonly summary: string;
  readonly updatedAt: string;
}

interface ConsolidationPromptInput {
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
 * 判别标签，`#plan` 与写盘循环都按它分叉。
 */
interface DeletePlan {
  readonly operation: ConsolidationOperation;
  readonly uri: Uri;
  readonly schema: null;
  readonly values: null;
}

interface UpsertPlan {
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
   * 值是 `#plan` 里已经过 `Uri.tryParse` 的对象：写盘阶段直接传给 `provenance`，
   * 不再解析第二遍（同一个值解析两次，就是两处校验将来会分叉的地方）。
   */
  readonly sources: readonly Uri[];
}

type WritePlan = DeletePlan | UpsertPlan;

/** 把记忆正文压成一行摘要；空正文（`add` 之外理论上都有）给空串。 */
function summarize(record: MemoryRecord): string {
  const content = record.fields[CONTENT_FIELD];
  const text = typeof content === 'string' ? content.replace(/\s+/gu, ' ').trim() : '';
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}…`;
}

function renderEntry(entry: InventoryEntry): string {
  return [
    `- ${entry.uri}`,
    `  类型：${entry.memoryType}，更新于 ${entry.updatedAt}`,
    `  摘要：${entry.summary}`,
  ].join('\n');
}

function buildUserContent(input: ConsolidationPromptInput): string {
  const reads =
    input.reads.size === 0
      ? '（还没有读过正文。）'
      : [...input.reads].map(([uri, content]) => `### ${uri}\n${content}`).join('\n\n');

  return [
    '## scope',
    input.scope,
    `## 记忆清单（${input.inventory.length} 条）`,
    input.inventory.length === 0
      ? '（这个 scope 下没有生效中的记忆。）'
      : input.inventory.map(renderEntry).join('\n'),
    '## 已读正文',
    reads,
    '## 轮次',
    `第 ${input.iteration}/${input.maxIterations} 轮，已经读过 ${input.reads.size} 条记忆的正文。`,
    '## 任务',
    '按上面的格式输出 JSON。',
  ].join('\n\n');
}

function buildSystemPrompt(input: ConsolidationPromptInput): string {
  return [
    '你是 CoMem 的记忆合并器。一个 scope 下的记忆会越积越多：其中一些是重复的，一些已经被后来的结论取代。',
    '你的任务是把它们收敛成一份没有重复、没有相互矛盾的记忆库。',
    '',
    '## 你拿到的',
    '- 「记忆清单」：这个 scope 下**全部**生效中记忆的 URI、类型、摘要与更新时间。清单之外的路径不存在。',
    '- 「已读正文」：你在之前轮次请求读取过的记忆全文。',
    '',
    '## 你可以产出的操作',
    '- `add`：新增一条记忆。`uri` 是建议路径，必须落在清单里某个记忆类型的目录下，且不能与已有记忆重名。',
    '- `update`：用完整正文替换一条已有记忆。`content` 是操作后的全文。',
    '- `delete`：删除一条已有记忆。`content` 必须是 null。',
    '',
    '## 每轮只输出一个 JSON 对象',
    '- 想先读正文：`{"action": "read", "uris": ["comem://..."]}`',
    '- 想结束：`{"action": "finish", "operations": [{"kind": "update", "uri": "comem://...", "content": "...", "reason": "..."}]}`',
    '',
    '## 规则',
    '- 每条操作必须有 `reason`，说明为什么合并、为什么删除。没有理由的删除不可接受。',
    '- 判断依据是语义：两条记忆讲同一件事，或者一条已经被另一条取代。字面相似度不是依据。',
    '- 不确定时先 `read` 正文，不要凭摘要猜。',
    '- 没有需要改的，输出 `{"action": "finish", "operations": []}`。',
    `- 最多 ${input.maxIterations} 轮。第 ${input.maxIterations} 轮必须结束，否则整次合并失败。`,
  ].join('\n');
}

function buildConsolidationPrompt(input: ConsolidationPromptInput): LlmPrompt {
  return {
    system: buildSystemPrompt(input),
    messages: [{ role: 'user', content: buildUserContent(input) }],
  };
}

/** `operations` 缺省时是空列表（模型认为不需要改）。 */
function normalizeOperations(output: ConsolidationOutput): readonly ConsolidationOperation[] {
  return (output.operations ?? []).map((operation) => ({
    kind: operation.kind,
    uri: operation.uri,
    content: operation.content ?? null,
    reason: operation.reason,
  }));
}

/** 一轮 `finish` 的意图摘要：计数 + 每条操作的理由。 */
function describeOperations(operations: readonly ConsolidationOperation[]): string {
  if (operations.length === 0) {
    return '没有需要改的操作。';
  }

  const counts = new Map<ConsolidationOperation['kind'], number>();
  for (const operation of operations) {
    counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
  }
  const summary = (['add', 'update', 'delete'] as const)
    .map((kind) => `${kind} ${counts.get(kind) ?? 0} 条`)
    .join('、');
  const reasons = operations
    .map((operation) => `${operation.kind} ${operation.uri}（${operation.reason}）`)
    .join('；');
  return `${summary}：${reasons}`;
}

function compareByUri(left: WritePlan, right: WritePlan): number {
  const leftUri = left.operation.uri;
  const rightUri = right.operation.uri;
  if (leftUri === rightUri) {
    return 0;
  }
  return leftUri < rightUri ? -1 : 1;
}

/**
 * 版本快照不是记忆：路径段里出现 `.history` 就是一份旧值（W98）。
 *
 * 判定按**段**而不是子串：`memories/preferences/.history/` 是 W98 写入的位置，
 * 而 `.history.md` 这样的文件名是普通记忆（`identity` 可以是 `.history`），按
 * `includes('/.history/')` 判会把它一起漏掉。
 */
function isVersionFile(uri: Uri): boolean {
  return uri.segments.includes(HISTORY_DIRECTORY);
}

/**
 * 记忆合并服务。
 *
 * **这是破坏性操作**（会 `delete`）。调用方必须先确认。
 */
export class ConsolidationService {
  readonly #memory: ConsolidationServiceDeps['memory'];
  readonly #stat: ConsolidationServiceDeps['stat'];
  readonly #search: ConsolidationServiceDeps['search'];
  readonly #llm: ConsolidationServiceDeps['llm'];
  readonly #logger: Logger;
  readonly #maxIterations: number;

  constructor(deps: ConsolidationServiceDeps) {
    this.#memory = deps.memory;
    this.#stat = deps.stat;
    this.#search = deps.search;
    this.#llm = deps.llm;
    this.#logger = deps.logger;
    this.#maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  /**
   * 合并一个 scope 下的记忆。
   *
   * **这是破坏性操作**（会 `delete`）。调用方必须先确认；`options.dryRun` 默认
   * `true`，不传就只预览。
   *
   * 返回的 `adds` / `updates` / `deletes` 是**已应用**（`dryRun` 时是「将要应用」）
   * 的 URI；`trace` 是每一轮模型输出的摘要。
   */
  async consolidate(scope: Uri, options: ConsolidateOptions): Promise<ConsolidationResult> {
    const dryRun = options.dryRun ?? true;
    const memoriesDirectory = scope.child(MEMORIES_DIRECTORY);
    const inventory = await this.#inventory(memoriesDirectory, options);

    if (inventory.candidates.length === 0) {
      this.#logger.info('记忆合并：scope 下没有生效中的记忆', { scope: scope.toString() });
      return { adds: [], updates: [], deletes: [], trace: [] };
    }

    const { operations, trace } = await this.#explore(
      scope,
      memoriesDirectory,
      inventory.candidates,
    );

    const validation = validateOperations(operations, {
      // 用索引枚举到的**全部 active** 记忆文件 URI。`add` 一条已存在的 active
      // 记忆会覆盖它，这一步先整批拒绝；pending / archived 不在 `glob` 的结果里
      // （它是检索面），由 `#plan` 按路径复查。
      existing: inventory.uris,
      allowedScopes: [memoriesDirectory.toStringAsDirectory()],
    });
    if ('error' in validation) {
      // 整批拒绝：一半操作被执行、一半被丢弃会得到一份自相矛盾的记忆库。
      throw new ComemError('INVALID_ARGUMENT', `模型产出的操作整批被拒绝：${validation.error}`, {
        scope: scope.toString(),
        operations: operations.map((operation) => `${operation.kind} ${operation.uri}`),
      });
    }

    const plans = await this.#plan(scope, validation.valid);
    const adds: string[] = [];
    const updates: string[] = [];
    const deletes: string[] = [];

    if (dryRun) {
      for (const plan of plans) {
        if (plan.operation.kind === 'add') {
          adds.push(plan.operation.uri);
        } else if (plan.operation.kind === 'update') {
          updates.push(plan.operation.uri);
        } else {
          deletes.push(plan.operation.uri);
        }
      }
      this.#logger.info('记忆合并预览完成（未写盘）', {
        scope: scope.toString(),
        adds: adds.length,
        updates: updates.length,
        deletes: deletes.length,
      });
      return { adds, updates, deletes, trace };
    }

    try {
      for (const plan of [...plans].sort(compareByUri)) {
        if (plan.schema === null) {
          // 删除必须可解释：`reason` 是模型给的理由，进日志（§11.8）。
          await this.#memory.remove(plan.uri);
          deletes.push(plan.uri.toString());
          this.#logger.info('记忆合并删除了记忆', {
            scope: scope.toString(),
            uri: plan.uri.toString(),
            reason: plan.operation.reason,
          });
          continue;
        }
        const write = await this.#memory.upsertMemory(scope, plan.schema, {
          // 与直接传字段等价（identity + content 都在 `values` 里，路径同
          // `upsertMemory` 内部渲染的那一个），但 `{ uri, update }` 形态能带上
          // `provenance`：被本批删除的记忆的归档来源要并进保留者（W97）。
          uri: renderMemoryUri(scope, plan.schema, plan.values),
          update: () => plan.values,
          // `plan.sources` 在 `#plan` 里已经 `Uri.tryParse` 过，直接传，不再 parse。
          ...(plan.sources.length === 0
            ? {}
            : { provenance: { sources: plan.sources } }),
        });
        (write.created ? adds : updates).push(write.uri.toString());
        this.#logger.info('记忆合并写入了记忆', {
          scope: scope.toString(),
          uri: write.uri.toString(),
          memoryType: write.memoryType,
          created: write.created,
          reason: plan.operation.reason,
        });
      }
    } catch (error) {
      const failure = ComemError.from(error);
      // 不回滚：`MemoryService` 没有事务，逐字节前像也拿不回来（见文件头）。
      // 已经应用的操作写进 details，运维按这份清单收尾。
      throw new ComemError(
        failure.code,
        `记忆合并中途失败，已应用的 ${adds.length + updates.length + deletes.length} 条操作没有回滚：${failure.message}`,
        {
          ...(failure.details ?? {}),
          scope: scope.toString(),
          adds: [...adds],
          updates: [...updates],
          deletes: [...deletes],
        },
      );
    }

    this.#logger.info('记忆合并完成', {
      scope: scope.toString(),
      adds: adds.length,
      updates: updates.length,
      deletes: deletes.length,
      iterations: trace.length,
    });
    return { adds, updates, deletes, trace };
  }

  /**
   * 有界的探索循环。
   *
   * 每一轮把「清单 + 已读正文 + 轮次」交给模型；`read` 轮把请求的正文加进上下文，
   * `finish` 轮结束。到 `#maxIterations` 还没 `finish` 抛 `RESOURCE_EXHAUSTED`，
   * **不做部分应用**。
   */
  async #explore(
    scope: Uri,
    memoriesDirectory: Uri,
    inventory: readonly InventoryEntry[],
  ): Promise<{ operations: readonly ConsolidationOperation[]; trace: ConsolidationTraceEntry[] }> {
    const reads = new Map<string, string>();
    const trace: ConsolidationTraceEntry[] = [];

    for (let iteration = 1; iteration <= this.#maxIterations; iteration += 1) {
      const prompt = buildConsolidationPrompt({
        scope: memoriesDirectory.toStringAsDirectory(),
        inventory,
        reads,
        iteration,
        maxIterations: this.#maxIterations,
      });
      const output = await this.#llm.generateJson(prompt, consolidationOutputSchema);

      if (output.action === 'read') {
        const requested = output.uris ?? [];
        if (requested.length === 0) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `记忆合并第 ${iteration} 轮的 read 动作没有给出 uris。`,
            { iteration, scope: scope.toString() },
          );
        }
        const readUris: string[] = [];
        for (const raw of requested) {
          const uri = Uri.tryParse(raw);
          if (uri === null || !memoriesDirectory.isAncestorOf(uri)) {
            // 隔离：读也只能读这个 scope 下的记忆。
            throw new ComemError(
              'INVALID_ARGUMENT',
              `记忆合并第 ${iteration} 轮请求读取 scope 外的路径：${raw}。`,
              { iteration, uri: raw, scope: scope.toString() },
            );
          }
          const record = await this.#memory.read(uri);
          if (record === null) {
            throw new ComemError(
              'NOT_FOUND',
              `记忆合并第 ${iteration} 轮请求读取的记忆不存在：${uri.toString()}。`,
              { iteration, uri: uri.toString() },
            );
          }
          reads.set(uri.toString(), pageContent(record));
          readUris.push(uri.toString());
        }
        trace.push({
          iteration,
          action: 'read',
          readUris,
          summary: `请求读取 ${readUris.length} 条记忆的正文。`,
        });
        continue;
      }

      const operations = normalizeOperations(output);
      trace.push({
        iteration,
        action: 'finish',
        readUris: [],
        summary: describeOperations(operations),
      });
      return { operations, trace };
    }

    throw new ComemError(
      'RESOURCE_EXHAUSTED',
      `记忆合并在 ${this.#maxIterations} 轮内没有结束：模型一直在读，没有给出操作。没有应用任何操作。`,
      {
        scope: scope.toString(),
        maxIterations: this.#maxIterations,
        read: [...reads.keys()],
      },
    );
  }

  /**
   * 枚举 scope 下生效中的记忆。
   *
   * **`pending` / `archived` 不是合并候选**：`pending` 还在复核（§11.6），删掉它
   * 等于绕过复核闸门；`archived` 已被 TTL 归档（§11.7），清理它要按 TTL 的策略走。
   * 两者都不该由一次合并顺手处理。
   *
   * 清单来自检索索引（文件是真相，索引是派生，§7）：文件写了但索引还没同步时，
   * 这条记忆不会出现在清单里，也就不会被合并——漏合并比「合并了一份陈旧的正文」安全。
   */
  async #inventory(
    memoriesDirectory: Uri,
    options: ConsolidateOptions,
  ): Promise<ScopeInventory> {
    const uris = await this.#search.glob(GLOB_PATTERN, {
      scopes: [memoriesDirectory.toString()],
      subject: options.subject,
      principals: options.principals,
      limit: INVENTORY_LIMIT,
    });

    if (uris.length >= INVENTORY_LIMIT) {
      this.#logger.warn('记忆合并的清单达到条数上限，本次只合并前若干条', {
        scope: memoriesDirectory.toString(),
        limit: INVENTORY_LIMIT,
      });
    }

    const candidates: InventoryEntry[] = [];
    const all = new Set<string>();
    for (const value of [...uris].sort()) {
      const uri = Uri.tryParse(value);
      if (uri === null || isVersionFile(uri)) {
        // 版本文件是**已经失效的旧值**（W98）：`status` 仍是 `active`，靠 `valid_until`
        // 才和当前值区分开。合并清单问的是「当前有哪些记忆」，所以它不进候选清单
        // （`candidates`），也就不会被模型当成一条可以 `delete` 的记忆（删掉一份版本
        // 就掐断了 `supersedes` 链）。
        //
        // 但版本文件**占用 `glob` 的返回名额**：`limit: INVENTORY_LIMIT` 是
        // `SearchService.glob` 查询本身的参数，按路径段过滤发生在它返回之后（下面的
        // `continue`），所以 `uris` 里确实混着版本文件。占用有上界——写入时每个
        // identity 只保留最新 `MAX_VERSIONS = 5` 份（`MemoryService` 的截断）。
        //
        // 检索面看不到版本文件是因为 `find` / `search` 带 `asOf`（`node.valid_until`
        // 过滤）；`glob` 是路径工具，契约是磁盘，没有 `asOf`。不给 `SearchService.glob`
        // 加这个参数（那会改检索层的公开签名，影响面比这条缺陷大），在路径段上排除。
        continue;
      }
      const record = await this.#memory.read(uri);
      if (record === null) {
        // 不是记忆文件（`memories/` 下可能有用户手工放的普通 Markdown）。
        continue;
      }
      const canonical = record.uri.toString();
      all.add(canonical);
      if (record.status !== 'active') {
        continue;
      }
      candidates.push({
        uri: canonical,
        memoryType: record.memoryType,
        summary: summarize(record),
        updatedAt: record.updatedAt,
      });
    }
    return { candidates, uris: all };
  }

  /**
   * 把操作解析成写盘计划。**任何一条解析不出来都整批失败**，且发生在任何写入之前。
   *
   * 这里挡住的是「模型给了一个语法合法但写不回去的操作」：路径不在记忆类型目录下、
   * `identity` 不能由路径推出（固定文件名的 `profile`）、`addOnly` 类型被 update、
   * 文件里的 `memory_type` 与路径不一致（写回会渲染到另一个文件）。
   *
   * 另外两处是**磁盘上的手改值**，不是模型输出：
   *
   * - 被删记录的 `sources` 混进非 URI（写盘阶段不再 parse，坏值只能在这里拦）；
   * - 被 update 的记录字段类型不对或 identity 不齐（`upsertMemory` 锁内的同一份
   *   校验会落在写盘循环里，那时删除已经应用且不回滚）。
   */
  async #plan(
    scope: Uri,
    operations: readonly ConsolidationOperation[],
  ): Promise<readonly WritePlan[]> {
    const deletes: DeletePlan[] = [];
    const upserts: Omit<UpsertPlan, 'sources'>[] = [];
    /**
     * 本批被删除记忆的归档来源：原始值 → 已校验的 `Uri`，顺序 = 操作顺序；末尾并进
     * 每条写出的记忆（W97）。键保留原始字符串（去重沿用 `appendSources` 的「按
     * 字符串精确比较」），值是校验结果，写盘阶段直接用。
     */
    const deletedSources = new Map<string, Uri>();

    for (const operation of operations) {
      const uri = Uri.parse(operation.uri);
      // 版本是 `supersedes` 链上的旧值（W98），删掉一份就断链。但这条守卫不改变
      // 任何成功/失败结果，只改变 `add` 的拒绝理由：
      //
      // - `delete` / `update` 的版本 URI 到不了这里：`validateOperations` 先用
      //   `inventory.uris`（`all`，已排除版本文件）判「指向的记忆不存在」，整批在
      //   `#plan` 之前就拒绝了；
      // - `add` 的版本 URI 能到这里（`add` 不要求路径出现在清单里）。不过即使删掉
      //   这条守卫，`resolveMemoryTarget` 也会返回 null——版本相对路径比记忆类型的
      //   文件名模板多一段 `.history`——同样整批失败；
      // - 所以保留它的唯一理由是 `add` 的拒绝文案：说「是记忆的版本文件」比说
      //   「不在任何记忆类型的目录下」更能让人看清错在哪。
      if (isVersionFile(uri)) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `${operation.uri} 是记忆的版本文件（.history 下的旧值快照），版本文件不参与合并；请改为对规范路径操作。`,
          { uri: operation.uri, kind: operation.kind },
        );
      }
      if (operation.kind === 'delete') {
        // 记录在这里读到，来源也跟着取走：删除之后磁盘上只剩它的归档历史。
        const record = this.#assertActive(await this.#requireRecord(operation.uri, uri));
        // 来源要并进保留者，就得在**写盘之前**确认它能被写成 URI。frontmatter 可以
        // 被手工改坏（`sources: [not-a-uri]`，`parseSources` 只挑非空字符串），留到
        // 写回时才 `Uri.parse` 会在删除已经应用之后抛错——没有回滚。
        for (const source of record.sources) {
          const parsed = Uri.tryParse(source);
          if (parsed === null) {
            throw new ComemError(
              'INVALID_ARGUMENT',
              `记忆 ${operation.uri} 的 sources 里有不合法的归档 URI：${source}；先修好这个字段再合并。`,
              { uri: operation.uri, source },
            );
          }
          if (!deletedSources.has(source)) {
            deletedSources.set(source, parsed);
          }
        }
        deletes.push({ operation, uri, schema: null, values: null });
        continue;
      }

      const target = resolveMemoryTarget(scope, uri);
      if (target === null) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `${operation.uri} 不在任何记忆类型的目录下，无法写回。`,
          { uri: operation.uri, kind: operation.kind },
        );
      }

      if (operation.kind === 'add') {
        // `profile` 这类固定文件名的类型，identity 字段不出现在模板里：新增一条
        // 无法用路径表达，只能 update。等到 `upsertMemory` 抛错就只剩一句
        // 「identity 不能为空」，看不出是哪一步的问题。
        const missing = identityFields(target.schema)
          .map((field) => field.name)
          .filter((name) => target.identity[name] === undefined);
        if (missing.length > 0) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `${target.schema.type} 的 identity 字段 ${missing.join('、')} 不能由路径推出，不能用 add；修改已有记忆请用 update。`,
            { uri: operation.uri, memoryType: target.schema.type, fields: missing },
          );
        }
        // `glob` 是检索面（§8.4），只返回 `status = 'active'` 的节点（§11.7）。
        // `pending` / `archived` 的记忆不在清单里，但文件真实存在；模型可以凭空
        // 写出这条路径（不算幻觉）。写盘前按路径复读一次状态：`add` 覆盖它们
        // 等于绕过复核闸门（§11.6）或 TTL 策略（§11.7）。
        const existing = await this.#memory.read(uri);
        if (existing !== null) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `记忆 ${operation.uri} 已存在（status=${existing.status}），add 会覆盖它：pending 还在复核（§11.6），archived 已被 TTL 归档（§11.7）。`,
            { uri: operation.uri, status: existing.status },
          );
        }
        // 记忆语义的 `read` 返回 `null` 不等于「路径空着」：`#readDocument` 把「路径
        // 存在但不是可解析的记忆」也算成 `null`（没有 frontmatter、或 frontmatter 缺
        // `memory_type`）。`memories/` 下的文件是**人可以直接编辑**的，用户完全可能
        // 在那里放手写笔记；`write` / `edit` 也能建普通文件。写盘阶段的
        // `upsertMemory` 用同一套记忆语义判「新建」，所以这里不按文件系统复查一次的
        // 话，那份文件会被静默换成一条记忆，同批的 delete 还已经生效。
        //
        // 只看 `kind === 'file'`：目录占位走原来的 `EISDIR`（`memory.read` 在解析
        // 之前就会因读目录失败而抛 `INVALID_ARGUMENT`），不是这条要拦的「文件」。
        // `ContentStore.stat` 跟随符号链接，所以指向普通文件的链接在这里也被当成文件
        // 拦下——替换链接本身同样是丢数据。
        const path = await this.#stat.stat(uri);
        if (path !== null && path.kind === 'file') {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `${operation.uri} 已被一份非记忆文件占用（缺少 frontmatter 或 memory_type），add 会覆盖它；先移走那个文件，或换一个路径。`,
            { uri: operation.uri, kind: path.kind },
          );
        }
        const values = { ...target.identity, [CONTENT_FIELD]: operation.content };
        // identity 值要能被 `renderPath` 接受：`Uri.parse` 只拒绝整段等于 `..` 的段，
        // `a..b` 这种值能一路走到这里，直到写盘时 `renderMemoryUri` 才拒绝它。那时
        // 排在它前面的删除已经应用且不回滚。与下面 `update` 分支同一写法：渲染一次
        // 并比对，渲染不出来（identity 值含 `..`）或落到另一个文件都整批失败。
        if (renderMemoryUri(scope, target.schema, values).toString() !== operation.uri) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `记忆 ${operation.uri} 的 identity 值无法渲染回同一路径，写回会落到另一个文件。`,
            { uri: operation.uri, memoryType: target.schema.type },
          );
        }
        upserts.push({ operation, uri, schema: target.schema, values });
        continue;
      }

      if (target.schema.operationMode === 'addOnly') {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `${target.schema.type} 类型只允许新增，不能 update：${operation.uri}。`,
          { uri: operation.uri, memoryType: target.schema.type },
        );
      }
      const record = this.#assertActive(await this.#requireRecord(operation.uri, uri));
      if (record.memoryType !== target.schema.type) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `路径 ${operation.uri} 属于 ${target.schema.type}，文件里的记忆类型是 ${record.memoryType}；先修好元数据再合并。`,
          { uri: operation.uri, memoryType: record.memoryType, pathType: target.schema.type },
        );
      }

      const values: Record<string, unknown> = {
        ...record.fields,
        [CONTENT_FIELD]: operation.content,
      };
      // identity 与路径不一致时，`upsertMemory` 会渲染到**另一个文件**：写成功、
      // 目标没变、还多出一条重复记忆。这种文件是手工改坏的，不能顺带覆盖。
      if (renderMemoryUri(scope, target.schema, values).toString() !== operation.uri) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `记忆 ${operation.uri} 的 identity 字段与路径不一致，写回会落到另一个文件。`,
          { uri: operation.uri, memoryType: target.schema.type },
        );
      }

      // 字段类型与 identity 齐备：这些值来自磁盘上可能被手工改坏的 frontmatter，
      // 校验与 `upsertMemory` 锁内那一份是同一实现（`domain/memory-type.ts`）。
      // 留到写盘循环里才报，删除已经应用且不回滚。
      assertMemoryIdentity(target.schema, values);
      assertFieldTypes(target.schema, values);

      upserts.push({ operation, uri, schema: target.schema, values });
    }

    // 写出的每条记忆继承本批被删除记忆的来源：它们的正文参与了这次收敛。顺序 =
    // 保留者自己的在前（`upsertMemory` 追加时保住原顺序）、被删的按操作顺序在后，
    // 去重与 20 条上限沿用 `memory.ts` 的同一套策略。值取上面 `tryParse` 校验过的
    // `Uri`，写盘阶段不再 parse。
    const inheritedKeys = appendSources([], [...deletedSources.keys()]);
    const inherited = inheritedKeys
      .map((source) => deletedSources.get(source))
      // `inheritedKeys` 只可能来自 `deletedSources` 的键，filter 只用于收窄类型。
      .filter((source): source is Uri => source !== undefined);
    return [
      ...deletes,
      ...upserts.map((plan) => ({ ...plan, sources: inherited }) satisfies UpsertPlan),
    ];
  }

  /** 读一条记忆；不存在（含并发删除）时抛 `NOT_FOUND`。 */
  async #requireRecord(raw: string, uri: Uri): Promise<MemoryRecord> {
    const record = await this.#memory.read(uri);
    if (record === null) {
      throw new ComemError('NOT_FOUND', `记忆不存在：${raw}。`, { uri: raw });
    }
    return record;
  }

  /**
   * `pending` / `archived` 不是合并候选，写回时也要挡住。
   *
   * 清单里已经过滤掉它们，但模型可以**凭空写出**一条真实存在的路径（不算幻觉）。
   * 只靠清单过滤的话，这条路径会通过「存在」校验然后被删除——等于绕过复核闸门
   * （§11.6）或 TTL 策略（§11.7）。写回前读一次状态，把这条不变量钉在写盘路径上。
   */
  #assertActive(record: MemoryRecord): MemoryRecord {
    if (record.status !== 'active') {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `记忆 ${record.uri.toString()} 的状态是 ${record.status}，不是合并候选：pending 还在复核（§11.6），archived 已被 TTL 归档（§11.7）。`,
        { uri: record.uri.toString(), status: record.status },
      );
    }
    return record;
  }
}

/** 读正文用 `content` 字段，与合并步骤的输入同一形态（`memory-extract.ts`）。 */
function pageContent(record: MemoryRecord): string {
  const content = record.fields[CONTENT_FIELD];
  return typeof content === 'string' ? content : '';
}
