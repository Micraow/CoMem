/**
 * 提交管线第 2 步：记忆抽取（架构文档 §10.1、§11.3、§11.4）。
 *
 * 六条核心链路之一。输入是归档的消息，输出是一批「URI + 字段级合并操作」。
 *
 * ## 为什么用预取而不是循环检索（§11.3）
 *
 * 抽取要判断「这条新信息是新增还是更新已有记忆」。不读已有记忆就判断不了，只能盲目
 * 新增，结果是大量重复。v1 用**预取**：按每个记忆类型的目录各做一次检索，把 top-N
 * 命中直接塞进 prompt，然后单次输出。省 token，质量略低；reAct 循环留到 v2。
 *
 * ## page_id（§11.4）
 *
 * 让模型直接输出 URI 会引入拼写错误与幻觉路径。这里把读到的记忆编号成 `page_id`
 * （1、2、3……），模型只看见编号；新建项用 `>= NEW_PAGE_ID_START` 的编号，避免与
 * 已读项冲突。服务端再把编号映射回 URI。
 *
 * **越界编号不抛错**：模型引用一个没读过的编号是常见错误，整条操作进 `skipped`，
 * 其余操作照常应用。抛错会让一次抽取里的一条坏操作毁掉十九条好操作。
 *
 * ## 重试与截断（§11.4）
 *
 * 两者都在 `LlmService` 里：解析失败只重试一次（第二次仍失败抛 `INVALID_ARGUMENT`），
 * 截断（`finishReason === 'length'`）不重试、直接抛 `PROVIDER_UNAVAILABLE`。这一步
 * 不做任何额外重试——重试两次解析失败只会把「模型不会」拖成「等更久」。
 *
 * ## 工具输出默认隐藏（§10.1）
 *
 * `tool_use` / `tool_result` 会泄漏环境变量、数据库内容与文件系统结构，用户记忆抽取
 * 默认丢弃它们（`renderMessageText` 里的 `[tool_use ...]` / `[tool_result ...]`
 * 段落整体消失）。只有 agent 作用域才带上，且截断到 500 字符——那是 v2 的事。
 */

import { z } from 'zod';
import type { ZodType } from 'zod';

import type { MemoryOperationsFile, SkippedMemoryOperation } from '../../../domain/archive.js';
import { ComemError } from '../../../domain/errors.js';
import type { LlmPrompt } from '../../../domain/llm.js';
import type { Logger } from '../../../domain/log.js';
import type { MemoryTypeSchema } from '../../../domain/memory-type.js';
import { BUILTIN_MEMORY_TYPES, getMemoryType } from '../../../domain/memory-types/index.js';
import type { BatchOperation, MergeOperation } from '../../../domain/merge-op.js';
import { renderMessageText, type SessionMessage } from '../../../domain/session.js';
import type { Uri } from '../../../domain/uri.js';

import type { MemoryRecord } from '../../memory.js';
import { assertMemoryIdentity, renderMemoryUri } from '../../memory.js';
import { buildExtractPrompt, NEW_PAGE_ID_START, type ExtractPage } from '../../prompts/extract.js';
import { CommitStep, type StepContext } from '../pipeline.js';

/** 跨步骤传递产物的键（`memory_merge` 消费）。 */
export const EXTRACT_RESULT_KEY = 'memory_extract.result';

/**
 * 抽取结果。
 *
 * `memoryTypes` 是 URI → 记忆类型的旁路映射：`BatchOperation` 是冻结契约，只带
 * URI，而合并与写 `memory_diff.json` 都要知道类型。
 */
export interface MemoryExtractResult {
  readonly operations: readonly BatchOperation[];
  readonly skipped: readonly SkippedMemoryOperation[];
  readonly memoryTypes: ReadonlyMap<string, string>;
}

export interface MemoryExtractStepDeps {
  readonly memory: {
    prefetch(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      query: string,
      topN: number,
    ): Promise<readonly MemoryRecord[]>;
  };
  readonly llm: {
    generateJson<T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T>;
  };
  /**
   * 写/读 `archive_NNN/memory_operations.json`（保留名，必须按归档目录定位）。
   *
   * 抽取结果**必须落盘**：`stepsDone` 已经声称这一步跑完了，重放会跳过它。产物
   * 只存在 `StepContext.state` 里的话，任何在之后发生的瞬态失败（供应商 503、
   * 租约过期、进程重启）都会让 `memory_merge` 拿到空 `state`。
   */
  readonly archive: {
    writeMemoryOperations(archiveUri: Uri, operations: MemoryOperationsFile): Promise<void>;
    /** 不存在返回 `null`（正常状态：这一步还没跑过）。 */
    readMemoryOperations(archiveUri: Uri): Promise<MemoryOperationsFile | null>;
  };
  readonly logger: Logger;
  /**
   * 用户画像的收敛预算（架构文档 §11.1）。
   *
   * 画像整段注入每次会话的开头，超过 `maxChars` 时提示词要求这次整份重写。
   * **必填**：漏传会让画像无限增长，而配置自检的 L2 会把它当成「配置值进入可选
   * 属性」报出来（`scripts/check-config.ts`）。
   */
  readonly profile: {
    readonly maxChars: number;
  };
  /**
   * 每个多文件记忆类型预取的条数。
   *
   * 默认 5：来源是架构文档 §11.3 的 `max(5, prefetchTopN)`。5 是「够判断新增还是
   * 更新」的经验下界，没有实测数据。
   */
  readonly prefetchTopN?: number;
}

/**
 * 每个多文件记忆类型预取的条数（默认 5）。
 *
 * 导出给 `experience_distill`：归纳也要预取已有经验，条数用同一个下界，避免两处
 * 各自写一个数字后慢慢漂移。
 */
export const DEFAULT_PREFETCH_TOP_N = 5;

const patchBlockSchema = z.object({
  search: z.string(),
  replace: z.string(),
});

/**
 * 字段级合并操作（§11.2 的四个 kind）。
 *
 * 与 `domain/merge-op.ts` 的 `MergeOperation` 同构。schema 在这里，是因为
 * `generateJson` 需要把形状翻译成供应商的 JSON Schema；领域类型不带运行时信息。
 */
const mergeOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('patch'),
    field: z.string(),
    blocks: z.array(patchBlockSchema),
  }),
  z.object({ kind: z.literal('replace'), field: z.string(), value: z.unknown() }),
  z.object({ kind: z.literal('sum'), field: z.string(), delta: z.number() }),
  z.object({ kind: z.literal('immutable'), field: z.string(), value: z.unknown() }),
]);

const extractOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upsert'),
    pageId: z.number(),
    type: z.string(),
    identity: z.record(z.string(), z.string()),
    operations: z.array(mergeOperationSchema),
  }),
  z.object({ kind: z.literal('delete'), pageId: z.number() }),
]);

const extractOutputSchema = z.object({ operations: z.array(extractOperationSchema) });

type ExtractOutput = z.infer<typeof extractOutputSchema>;

function skip(
  memoryType: string,
  reasonCode: string,
  reason: string,
): SkippedMemoryOperation {
  return { memoryType, reasonCode, reason };
}

/**
 * 丢掉工具输出（§10.1 的「用户记忆抽取默认隐藏工具输出」）。
 *
 * 按 part 类型丢弃：`tool_result.output` 是多行文本，按行丢弃只会留下它的一部分，
 * 而「一部分工具输出」照样泄漏，还看不出被截断过。整个 part 消失才是「隐藏」。
 */
export function stripToolParts(messages: readonly SessionMessage[]): LlmPrompt['messages'] {
  const result: { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[] =
    [];
  for (const message of messages) {
    const parts = message.parts.filter(
      (part) => part.kind !== 'tool_use' && part.kind !== 'tool_result',
    );
    const content = renderMessageText({ ...message, parts });
    if (content.trim() === '') {
      continue;
    }
    // `LlmMessage` 没有 `tool` 角色：工具消息的正文属于「用户侧输入」，按 user 渲染。
    result.push({ role: message.role === 'tool' ? 'user' : message.role, content });
  }
  return result;
}

/**
 * 预取的检索 query：最后一条用户消息。没有用户消息时是空串（`find` 会直接返回空）。
 *
 * 导出给 `experience_distill`：两条步骤都要「按这次会话找相关记忆」，查询构造只应
 * 有一份（改了一处、另一处不跟着改，预取就会悄悄取到不相干的记忆）。
 */
export function retrievalQuery(messages: readonly SessionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') {
      return renderMessageText(message);
    }
  }
  return '';
}

/**
 * 页面正文取 `content` 字段。
 *
 * 必须与 `applyPatch` 的输入一致：合并步骤在 `fields.content` 上应用 SEARCH/REPLACE，
 * 模型看到的若是带 `## content` 标题的整段正文，SEARCH 永远匹配不上。
 */
export function pageContent(record: MemoryRecord): string {
  const content = record.fields['content'];
  return typeof content === 'string' ? content : '';
}

/**
 * 今天的本地日期，`YYYY-MM-DD`。
 *
 * 用本地时间而不是 `toISOString()` 的 UTC：画像的 `(as of YYYY-MM-DD)` 后缀是写给
 * 人看的，UTC 在 UTC+8 的 0–8 点会显示成昨天。日期只用于「只留最新值」的判定，
 * 差一天不影响语义，但差一天是错的。
 */
function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 把模型输出解析成可应用的操作。
 *
 * 弱校验（§11.4）逐条做，失败的操作进 `skipped` 而不是抛错：
 *
 * 1. `memoryType` 必须在 `BUILTIN_MEMORY_TYPES` 里；
 * 2. identity 字段必须存在且能拼出合法路径（`renderPath` 会拒绝 `/`、`..`）；
 * 3. 字段名必须在 schema 里；
 * 4. 引用的 `page_id` 必须读过（新建项 `>= NEW_PAGE_ID_START` 除外）。
 */
function resolveOperations(
  output: ExtractOutput,
  scopeUri: Uri,
  pages: ReadonlyMap<number, ExtractPage>,
): MemoryExtractResult {
  const operations: BatchOperation[] = [];
  const skipped: SkippedMemoryOperation[] = [];
  const memoryTypes = new Map<string, string>();

  for (const operation of output.operations) {
    if (operation.kind === 'delete') {
      const page = pages.get(operation.pageId);
      if (page === undefined) {
        skipped.push(
          skip(
            'unknown',
            'unknown_page',
            `引用了没有读过的编号 ${operation.pageId}，跳过这条删除。`,
          ),
        );
        continue;
      }
      operations.push({ kind: 'delete', uri: page.uri });
      memoryTypes.set(page.uri, page.memoryType);
      continue;
    }

    const schema = getMemoryType(operation.type);
    if (schema === undefined) {
      skipped.push(
        skip(
          operation.type,
          'unknown_memory_type',
          `记忆类型 ${operation.type} 不存在，跳过这条操作。`,
        ),
      );
      continue;
    }

    let uri: Uri;
    try {
      assertMemoryIdentity(schema, operation.identity);
      uri = renderMemoryUri(scopeUri, schema, operation.identity);
    } catch (error) {
      skipped.push(
        skip(
          operation.type,
          'invalid_identity',
          `identity 拼不出合法路径：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }
    const uriString = uri.toString();

    const page = pages.get(operation.pageId);
    if (operation.pageId < NEW_PAGE_ID_START) {
      if (page === undefined) {
        skipped.push(
          skip(operation.type, 'unknown_page', `引用了没有读过的编号 ${operation.pageId}。`),
        );
        continue;
      }
      if (page.uri !== uriString) {
        skipped.push(
          skip(
            operation.type,
            'page_mismatch',
            `编号 ${operation.pageId} 指向 ${page.uri}，与 identity 推出的 ${uriString} 不一致。`,
          ),
        );
        continue;
      }
      if (page.memoryType !== operation.type) {
        skipped.push(
          skip(
            operation.type,
            'memory_type_mismatch',
            `编号 ${operation.pageId} 的记忆类型是 ${page.memoryType}，与输出的 ${operation.type} 不一致。`,
          ),
        );
        continue;
      }
    } else if (page !== undefined) {
      skipped.push(
        skip(
          operation.type,
          'duplicate_page_id',
          `新建编号 ${operation.pageId} 与已读记忆冲突，新建项要用 ≥ ${NEW_PAGE_ID_START} 的编号。`,
        ),
      );
      continue;
    }

    if (operation.operations.length === 0) {
      skipped.push(skip(operation.type, 'empty_operations', '没有任何字段操作，跳过。'));
      continue;
    }

    const unknownField = operation.operations.find(
      (merge) => !schema.fields.some((field) => field.name === merge.field),
    );
    if (unknownField !== undefined) {
      skipped.push(
        skip(
          operation.type,
          'unknown_field',
          `字段 ${unknownField.field} 不在记忆类型 ${operation.type} 里。`,
        ),
      );
      continue;
    }

    // 新建记忆时 identity 字段还没落过盘：把 identity 当成 `replace` 操作插到最前面，
    // 合并步骤拿到的就是「一份完整字段」。否则 `upsertMemory` 会因为 identity 缺失
    // 拒绝写入，而模型在输出里已经给过 identity 了，再让它重复一遍没有意义。
    if (operation.pageId >= NEW_PAGE_ID_START) {
      for (const [field, value] of Object.entries(operation.identity)) {
        operations.push({ kind: 'upsert', uri: uriString, operation: { kind: 'replace', field, value } });
      }
    }
    for (const mergeOperation of operation.operations) {
      const resolved: MergeOperation = mergeOperation;
      operations.push({ kind: 'upsert', uri: uriString, operation: resolved });
    }
    memoryTypes.set(uriString, operation.type);
  }

  return { operations, skipped, memoryTypes };
}

/** `state` 里的抽取结果；`memory_merge` 用它做类型收窄，不用断言。 */
export function isMemoryExtractResult(value: unknown): value is MemoryExtractResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('operations' in value) || !('skipped' in value) || !('memoryTypes' in value)) {
    return false;
  }
  return (
    Array.isArray(value.operations) &&
    Array.isArray(value.skipped) &&
    value.memoryTypes instanceof Map
  );
}

/** 抽取结果 → 落盘形状（§6.6 的 `memory_operations.json`）。 */
function toMemoryOperationsFile(
  archiveUri: Uri,
  result: MemoryExtractResult,
): MemoryOperationsFile {
  return {
    archiveUri: archiveUri.toString(),
    extractedAt: new Date().toISOString(),
    operations: [...result.operations],
    skipped: [...result.skipped],
    memoryTypes: [...result.memoryTypes],
  };
}

/** 落盘形状 → 抽取结果（`memoryTypes` 还原成 `Map`）。 */
function fromMemoryOperationsFile(file: MemoryOperationsFile): MemoryExtractResult {
  return {
    operations: file.operations,
    skipped: file.skipped,
    memoryTypes: new Map(file.memoryTypes),
  };
}

export class MemoryExtractStep extends CommitStep {
  readonly name = 'memory_extract' as const;

  readonly #memory: MemoryExtractStepDeps['memory'];
  readonly #llm: MemoryExtractStepDeps['llm'];
  readonly #archive: MemoryExtractStepDeps['archive'];
  readonly #logger: Logger;
  readonly #profileMaxChars: number;
  readonly #prefetchTopN: number;

  constructor(deps: MemoryExtractStepDeps) {
    super();
    this.#memory = deps.memory;
    this.#llm = deps.llm;
    this.#archive = deps.archive;
    this.#logger = deps.logger;
    this.#profileMaxChars = deps.profile.maxChars;
    this.#prefetchTopN = deps.prefetchTopN ?? DEFAULT_PREFETCH_TOP_N;
  }

  async run(context: StepContext): Promise<void> {
    const pages = await this.#prefetchPages(context);

    const prompt = buildExtractPrompt({
      messages: stripToolParts(context.messages),
      memoryTypes: Object.values(BUILTIN_MEMORY_TYPES),
      pages: [...pages.values()],
      previousOverview: context.latestArchiveOverview ?? undefined,
      profileMaxChars: this.#profileMaxChars,
      today: localDate(new Date()),
    });

    const output = await this.#llm.generateJson(prompt, extractOutputSchema);
    const result = resolveOperations(output, context.scopeUri, pages);

    // 先落盘再进 `state`：`state` 只是本次运行的缓存，重放时靠的是归档目录里的
    // 产物。反过来的话，写盘失败会留下一个「步骤已完成、产物不存在」的归档。
    await this.#archive.writeMemoryOperations(
      context.archiveUri,
      toMemoryOperationsFile(context.archiveUri, result),
    );
    context.state.set(EXTRACT_RESULT_KEY, result);

    this.#logger.info('记忆抽取完成', {
      archive: context.archiveUri.toString(),
      pages: pages.size,
      operations: result.operations.length,
      skipped: result.skipped.length,
    });
  }

  /**
   * 重放：这一步在 `stepsDone` 里，但 `state` 是新的。从归档目录读回抽取结果。
   *
   * 读不到是真正的装配 / 数据错误——`stepsDone` 声称跑过，产物却不在。用
   * `INVALID_ARGUMENT`（终态）而不是可重试错误：重放一次还是同一个缺失。
   */
  override async rehydrate(context: StepContext): Promise<void> {
    const file = await this.#archive.readMemoryOperations(context.archiveUri);
    if (file === null) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `归档元数据声称 memory_extract 已完成，但 memory_operations.json 不存在：${context.archiveUri.toString()}`,
        { archive: context.archiveUri.toString() },
      );
    }
    context.state.set(EXTRACT_RESULT_KEY, fromMemoryOperationsFile(file));
    this.#logger.debug('已从归档目录恢复抽取结果', {
      archive: context.archiveUri.toString(),
      operations: file.operations.length,
    });
  }

  /** §11.3 的预取：每个记忆类型各一次，编号跨类型连续。 */
  async #prefetchPages(context: StepContext): Promise<Map<number, ExtractPage>> {
    const query = retrievalQuery(context.messages);
    const pages = new Map<number, ExtractPage>();
    let nextPageId = 1;

    for (const schema of Object.values(BUILTIN_MEMORY_TYPES)) {
      const records = await this.#memory.prefetch(
        context.scopeUri,
        schema,
        query,
        this.#prefetchTopN,
      );
      for (const record of records) {
        pages.set(nextPageId, {
          pageId: nextPageId,
          uri: record.uri.toString(),
          content: pageContent(record),
          memoryType: record.memoryType,
        });
        nextPageId += 1;
      }
    }

    return pages;
  }
}
