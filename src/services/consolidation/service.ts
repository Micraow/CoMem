/**
 * 记忆合并的编排与有界探索循环（架构文档 §11.8）。
 *
 * - 候选枚举 → `inventory.ts`
 * - 提示词 → `prompt.ts`；模型输出解析 → `output.ts`
 * - 操作 → 写盘计划 → `plan.ts`；写盘与预览 → `apply.ts`
 *
 * 轮次状态（已读正文 `reads`、`trace`、轮次计数）留在类里：它们跨轮存活，不随一次
 * 函数调用结束；`maxIterations` 同理，是实例的生命周期参数。
 */

import {
  validateOperations,
  type ConsolidationOperation,
} from '../../domain/consolidation.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { memoryContentOf } from '../../domain/memory-type.js';
import { Uri } from '../../domain/uri.js';

import { applyPlans } from './apply.js';
import { collectInventory } from './inventory.js';
import {
  consolidationOutputSchema,
  describeOperations,
  normalizeOperations,
} from './output.js';
import { planOperations } from './plan.js';
import { buildConsolidationPrompt } from './prompt.js';
import type {
  ConsolidateOptions,
  ConsolidationPorts,
  ConsolidationResult,
  ConsolidationServiceDeps,
  ConsolidationTraceEntry,
  InventoryEntry,
} from './types.js';

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

/** scope 下放记忆的目录（§6.5）。 */
const MEMORIES_DIRECTORY = 'memories';

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

  /** 跨文件函数的显式端口：它们拿到的就是这几个依赖，拿不到实例状态。 */
  #ports(): ConsolidationPorts {
    return {
      memory: this.#memory,
      stat: this.#stat,
      search: this.#search,
      logger: this.#logger,
    };
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
    const inventory = await collectInventory(this.#ports(), memoriesDirectory, options);

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
      // （它是检索面），由 `plan.ts` 按路径复查。
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

    const plans = await planOperations(this.#ports(), scope, validation.valid);
    const applied = await applyPlans(this.#ports(), scope, plans, dryRun);

    if (dryRun) {
      return { ...applied, trace };
    }

    this.#logger.info('记忆合并完成', {
      scope: scope.toString(),
      adds: applied.adds.length,
      updates: applied.updates.length,
      deletes: applied.deletes.length,
      iterations: trace.length,
    });
    return { ...applied, trace };
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
          reads.set(uri.toString(), memoryContentOf(record.fields));
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
}
