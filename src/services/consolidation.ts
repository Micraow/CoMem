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
 * `addOnly` 类型不能 update）都在任何写入之前完成，把「中途失败」压到只剩 I/O 与
 * 加锁失败；真的中途失败时，错误 `details` 里带上已经应用过的 `adds` / `updates` /
 * `deletes`，由运维按这份清单收尾。
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

import {
  resolveMemoryTarget,
  validateOperations,
  type ConsolidationOperation,
} from '../domain/consolidation.js';
import { ComemError } from '../domain/errors.js';
import type { LlmPrompt } from '../domain/llm.js';
import type { Logger } from '../domain/log.js';
import { identityFields, type MemoryTypeSchema } from '../domain/memory-type.js';
import { Uri } from '../domain/uri.js';

import { renderMemoryUri, type MemoryRecord, type MemoryService } from './memory.js';
import type { SearchService } from './search.js';

export interface ConsolidationServiceDeps {
  readonly memory: Pick<MemoryService, 'read' | 'upsertMemory' | 'remove'>;
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
 * **全部**记忆文件的 URI，用作 `validateOperations` 的 `existing`——`add` 不能覆盖
 * 一条 `pending` / `archived` 的记忆（它不在清单里，但文件真的存在）。
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
 * 记忆合并服务。
 *
 * **这是破坏性操作**（会 `delete`）。调用方必须先确认。
 */
export class ConsolidationService {
  readonly #memory: ConsolidationServiceDeps['memory'];
  readonly #search: ConsolidationServiceDeps['search'];
  readonly #llm: ConsolidationServiceDeps['llm'];
  readonly #logger: Logger;
  readonly #maxIterations: number;

  constructor(deps: ConsolidationServiceDeps) {
    this.#memory = deps.memory;
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
      // 用**全部**记忆文件的 URI，不是清单里的：`add` 一条已存在但不在清单里的
      // 记忆（pending / archived）会覆盖它，等于绕过复核闸门或 TTL 策略。
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
        const write = await this.#memory.upsertMemory(scope, plan.schema, plan.values);
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
      if (uri === null) {
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
   */
  async #plan(
    scope: Uri,
    operations: readonly ConsolidationOperation[],
  ): Promise<readonly WritePlan[]> {
    const plans: WritePlan[] = [];

    for (const operation of operations) {
      const uri = Uri.parse(operation.uri);
      if (operation.kind === 'delete') {
        this.#assertActive(await this.#requireRecord(operation.uri, uri));
        plans.push({ operation, uri, schema: null, values: null });
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
        plans.push({
          operation,
          uri,
          schema: target.schema,
          values: { ...target.identity, [CONTENT_FIELD]: operation.content },
        });
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

      plans.push({ operation, uri, schema: target.schema, values });
    }

    return plans;
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
