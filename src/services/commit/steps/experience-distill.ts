/**
 * 提交管线第 5 步：经验归纳（架构文档 §10.1 阶段二的第 5 步、§11.6 复核闸门）。
 *
 * ## 为什么是一条独立步骤
 *
 * `experiences` 曾经和其余七类共用 `memory_extract`：提示词里只有类型清单的一行，
 * 模型顺手写一条 patch 就算「经验」。那是**抽取**，判断的是「这条信息落在哪个字段」，
 * 没有「读整段会话、重写整条结论」的动作；归纳要的是后者——从这次会话提炼「以后
 * 遇到同类问题可以照做的做法」，并与同 topic 的已有结论合并成**一份完整正文**。
 *
 * ## 为什么排在最后
 *
 * 它只依赖归档目录（`sources` 的来源）与记忆文件本身，不消费前四步的产物。放在
 * 最后有两个好处：前四步的产物（`memory_operations.json` / `memory_diff.json` /
 * 摘要失效）先落盘，归纳失败时它们已经可重放；而「这次没有可归纳的经验」也不
 * 影响前面的产物。归纳写出的记忆追加进同一份清单（见 `experience-diff.ts`）。
 *
 * ## 与抽取的分工靠提示词隔离
 *
 * `prompts/extract-system.md` 明说「经验类的结论留给归纳步骤」。没有那句时同一批
 * 消息会被两条路径各写一次：抽取写补丁、归纳写整段，同一个 topic 被覆盖两次，
 * 而两次写入的合并语义不同。
 *
 * ## 失败边界
 *
 * - 一条经验写不进去（topic 拼不出合法路径、正文为空）记 `warn` 跳过，不抛：一条
 *   坏经验不该让整个归档失败。`renderPath` 会拒绝含 `/`、`..`、反斜杠或控制字符
 *   的 identity，跳过的理由写进日志。
 * - 空数组是合法结论：这次没有可复用的经验，不写盘，步骤成功。
 * - `memory_link` 是 `sources` 的派生读模型。文件写成功、links 写失败时只记
 *   `error`，不回滚记忆、不让归档失败——links 能从 `sources` 重建（与
 *   `MemoryMergeStep` 同一条约定）。
 *
 * ## 重放
 *
 * 产物是磁盘上的记忆文件，默认的 `rehydrate` 就够（跳过 = 不重算，没有下游步骤要
 * 读 `state`）。重试会重新调模型：同一个 topic 落到同一个 URI，旧正文被整段覆盖，
 * 不会多出一条经验；内容不同时 W98 的版本快照会多留一份旧值，上限 5 份。
 */

import { z } from 'zod';
import type { ZodType } from 'zod';

import { ComemError } from '../../../domain/errors.js';
import type { LlmPrompt } from '../../../domain/llm.js';
import type { Logger } from '../../../domain/log.js';
import type { MemoryLinkType } from '../../../domain/memory-link.js';
import type { MemoryTypeSchema } from '../../../domain/memory-type.js';
import { experiencesMemoryType } from '../../../domain/memory-types/experiences.js';
import type { Uri } from '../../../domain/uri.js';

import type { MemoryRecord, MemoryWrite, MemoryWriteResult } from '../../memory.js';
import { renderMemoryUri } from '../../memory.js';
import type { MemoryLinkService } from '../../memory-link.js';
import { buildExperiencePrompt, type ExistingExperience } from '../../prompts/experience.js';

import { CommitStep, type StepContext } from '../pipeline.js';
import { appendExperienceDiff, experienceDiffEntry, type ExperienceDiffArchive } from './experience-diff.js';
import {
  DEFAULT_PREFETCH_TOP_N,
  pageContent,
  retrievalQuery,
  stripToolParts,
} from './memory-extract.js';

/**
 * 记忆来源的边类型。取自 `MemoryLinkType` 联合，不另写一份字符串字面量
 * （与 `memory-merge.ts` 同一份理由：领域层没有为每种边导出常量）。
 */
const DERIVED_FROM: MemoryLinkType = 'derived_from';

export interface ExperienceDistillStepDeps {
  readonly memory: {
    /**
     * §11.3 的预取。归纳用它取「已有经验」：同 topic 的旧正文要参与合并，
     * 没读到的旧正文会被当成不存在，整段重写就变成了覆盖丢失。
     */
    prefetch(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      query: string,
      topN: number,
    ): Promise<readonly MemoryRecord[]>;
    upsertMemory(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      input: MemoryWrite,
    ): Promise<MemoryWriteResult>;
  };
  readonly llm: {
    generateJson<T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T>;
  };
  readonly archive: ExperienceDiffArchive;
  /**
   * `memory_link` 的写入口（§11.10）。只写 `derived_from`，所以只要 `addLinks`。
   *
   * `sources`（frontmatter）是**真相**，`memory_link` 是它的**派生读模型**。
   * 两者允许短暂不一致：links 能从 `sources` 重建。
   */
  readonly links: Pick<MemoryLinkService, 'addLinks'>;
  readonly logger: Logger;
}

/**
 * 一条归纳结果。
 *
 * `topic` 是 identity（决定文件路径），`content` 是整段正文。schema 在这里而不是
 * 领域层，是因为 `generateJson` 需要把形状翻译成供应商的 JSON Schema；领域类型
 * 不带运行时信息（与 `memory-extract.ts` 的 `extractOutputSchema` 同一份理由）。
 */
const experienceSchema = z.object({
  topic: z.string(),
  content: z.string(),
});

const distillOutputSchema = z.object({ experiences: z.array(experienceSchema) });

/** 今天的本地日期，`YYYY-MM-DD`。与 `memory-extract.ts` 的 `localDate` 同一份语义。 */
function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 一条记忆记录 → 提示词里的「已有经验」。正文取 `content` 字段，不带标题。 */
function toExisting(record: MemoryRecord): ExistingExperience {
  const topic = record.fields['topic'];
  return {
    topic: typeof topic === 'string' ? topic : record.uri.toString(),
    content: pageContent(record),
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
}

export class ExperienceDistillStep extends CommitStep {
  readonly name = 'experience_distill' as const;

  readonly #memory: ExperienceDistillStepDeps['memory'];
  readonly #llm: ExperienceDistillStepDeps['llm'];
  readonly #archive: ExperienceDiffArchive;
  readonly #links: ExperienceDistillStepDeps['links'];
  readonly #logger: Logger;

  constructor(deps: ExperienceDistillStepDeps) {
    super();
    this.#memory = deps.memory;
    this.#llm = deps.llm;
    this.#archive = deps.archive;
    this.#links = deps.links;
    this.#logger = deps.logger;
  }

  async run(context: StepContext): Promise<void> {
    const existing = await this.#prefetchExisting(context);

    // 工具输出与抽取保持同一条边界（§10.1）：`tool_result` 会泄漏环境变量、数据库
    // 内容与文件系统结构。经验归纳读的是「会话过程」，但过程里的原文不进模型。
    const output = await this.#llm.generateJson(
      buildExperiencePrompt({
        messages: stripToolParts(context.messages),
        existing,
        today: localDate(new Date()),
      }),
      distillOutputSchema,
    );

    if (output.experiences.length === 0) {
      // 空数组是结论，不是失败：这次会话没有值得沉淀的做法。
      this.#logger.info('这次没有可归纳的经验，未写入记忆', {
        archive: context.archiveUri.toString(),
        existing: existing.length,
      });
      return;
    }

    // 这次写入的原始材料就是本次归档本身（与 `MemoryMergeStep` 同一判据）：归纳
    // 模型看不到归档 URI，让它输出只会得到幻觉。
    const sources: readonly Uri[] = [context.archiveUri];
    const now = new Date().toISOString();
    const written: MemoryWriteResult[] = [];

    for (const experience of output.experiences) {
      const { topic, content } = experience;

      if (content.trim() === '') {
        // 空正文是一条坏经验，不是整批结论：跳过它，其余条目照常写。
        this.#logger.warn('经验正文为空，跳过这一条', {
          archive: context.archiveUri.toString(),
          topic,
        });
        continue;
      }

      let uri: Uri;
      try {
        uri = renderMemoryUri(context.scopeUri, experiencesMemoryType, { topic });
      } catch (error) {
        // `renderPath` 拒绝含 `/`、`..`、反斜杠或控制字符的 identity：模型给出的
        // topic 拼不出合法路径时跳过这一条，不让整个归档失败。
        this.#logger.warn('经验 topic 拼不出合法路径，跳过这一条', {
          archive: context.archiveUri.toString(),
          topic,
          error: ComemError.from(error).message,
        });
        continue;
      }

      // 同一个 topic 落到同一个 URI：已有正文由转换函数整段覆盖，这是「归纳」与
      // 「追加」的区别。补丁在 `upsertMemory` 的 `exact(uri)` 锁内应用。
      const write = await this.#memory.upsertMemory(context.scopeUri, experiencesMemoryType, {
        uri,
        // 溯源由服务端确定（W97）：来源是本次归档，不是模型编的出处。
        provenance: { sources },
        update: (current) => ({ ...current, topic, content, updatedAt: now }),
      });
      // 清单只记真写过的（转换函数返回 `null` 时没落盘）。
      if (write.written) written.push(write);

      // 先文件、后派生（与 `MemoryMergeStep` 同一个顺序）：反过来会让派生物比真相
      // 更早存在。links 写失败只记 error——记忆已经正确落盘，它能从 sources 重建。
      try {
        this.#links.addLinks(uri, [{ toUri: context.archiveUri, linkType: DERIVED_FROM }]);
      } catch (error) {
        this.#logger.error('记忆关联边写入失败，已忽略：记忆已落盘，可从 sources 重建。', {
          archive: context.archiveUri.toString(),
          uri: uri.toString(),
          error: ComemError.from(error).message,
        });
      }
    }

    await appendExperienceDiff(this.#archive, context.archiveUri, written.map(experienceDiffEntry));

    this.#logger.info('经验归纳完成', {
      archive: context.archiveUri.toString(),
      existing: existing.length,
      distilled: output.experiences.length,
      written: written.length,
    });
  }

  /** §11.3 的预取，只取 `experiences`；查询构造复用 `retrievalQuery`。 */
  async #prefetchExisting(context: StepContext): Promise<readonly ExistingExperience[]> {
    const records = await this.#memory.prefetch(
      context.scopeUri,
      experiencesMemoryType,
      retrievalQuery(context.messages),
      DEFAULT_PREFETCH_TOP_N,
    );
    return records.map(toExisting);
  }
}
