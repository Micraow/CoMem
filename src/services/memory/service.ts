/**
 * `MemoryService`：记忆读写的编排与对外方法（架构文档 §6.6、§11.1、§11.3、§11.6）。
 *
 * 文档格式在 `document.ts`，版本快照在 `versioning.ts`，复核判定在 `review.ts`，
 * 读取与预取在 `query.ts`，端口与文件级原语在 `ports.ts`。这里只剩「按什么顺序
 * 组合它们」：锁、字段级合并、复核闸门与版本快照的触发条件。
 *
 * ## 并发：一条记忆一个 `exact` 锁（§18「并发控制」）
 *
 * 记忆写入是**读-改-写**：`readMemoryDocument` 拿 `createdAt` / `created` / `addOnly`
 * 判据，再整份覆盖。读在锁外时，两个写者各读一份旧正文、各写一份新的，后写者会
 * 把先写者的字段整段抹掉（并发合并同一个 `preferences` URI 就是这样丢字段的）。
 *
 * 所以锁归本服务：`upsertMemory` / `approve` / `reject` / `remove` 都在
 * `exact(uri)` 里完成「读 → 序列化 → 写」。粒度是**单文件**，不是 `memories/`
 * 子树——`tree` 会把同目录下无关的写入全部挡住。
 *
 * **`upsertMemory` 是字段级合并，不是整份替换。** 传进来的字段覆盖同名字段，
 * 没传的字段保留磁盘上的值。这一条是丢字段缺陷的另一半：调用方的读在锁外，
 * "读 → 改 → 写" 里的"改"只对自己动过的字段负责，保留其它字段才让两个并发写者
 * 的结果可以合并。整份替换时后写者会用它那份陈旧的字段值盖掉先写者的新值。
 *
 * **字段级合并只保护「不同字段」。** `profile` 只有一个 `content` 字段，两个并发
 * 写者各带一份基于旧正文算出的 `content` 时仍然是后写者赢。所以补丁形态的写入
 * 走 `{ uri, update }`：`update` 在锁内拿到磁盘上的最新字段，SEARCH/REPLACE 在
 * 最新正文上应用（`memory_merge` 用它，§18）。
 *
 * 锁**不可重入**（`adapters/fs/lock.ts` 是文件锁，同一进程内按锁路径排队）：任何
 * 调用方都不能在持有 `exact(uri)` 的同时再调这里的方法，否则等 5 秒后拿 `CONFLICT`。
 */

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { assertFieldTypes, assertMemoryIdentity, type MemoryTypeSchema } from '../../domain/memory-type.js';
import { profileMemoryType } from '../../domain/memory-types/index.js';
import { validateProfileBody } from '../../domain/profile-format.js';
import type { Uri } from '../../domain/uri.js';
import {
  CONTENT_FIELD,
  UPDATED_AT_FIELD,
  appendSources,
  renderBody,
  renderMemoryUri,
  serializeMemoryDocument,
  type MemoryStatus,
} from './document.js';
import { invalidArgument } from './errors.js';
import { readMemoryDocument, type MemoryFileStore, type MemorySearchPort, type MemoryServicePorts } from './ports.js';
import {
  listPendingMemories,
  prefetchMemories,
  readMemoryRecord,
  type MemoryRecord,
} from './query.js';
import { approveMemory, rejectMemory, type MemoryRejectResult } from './review.js';
import { writeVersionSnapshot } from './versioning.js';

export interface MemoryWriteResult {
  readonly uri: Uri;
  readonly memoryType: string;
  readonly created: boolean;
  /**
   * 是否真的落了盘。转换函数返回 `null`（没有可写的字段）时为 `false`，此时
   * `before` 与 `after` 相同、`created` 为 `false`。
   */
  readonly written: boolean;
  /** 应用前的正文，用于 `memory_diff.json` 的 `before` */
  readonly before: string | null;
  readonly after: string;
}

/** 记忆的字段集（字段名 → 值）。 */
export type MemoryFields = Readonly<Record<string, unknown>>;

/**
 * 在 `exact(uri)` 锁内执行的字段计算：拿到磁盘上的**最新**字段，返回要写的字段。
 *
 * 返回 `null` 表示「没有可写的字段」（例如补丁一条都没命中）：不落盘。覆盖写会
 * 白白推后 `updated_at`，还会把已复核的记忆打回 `pending`。
 */
export type MemoryUpdate = (current: MemoryFields) => MemoryFields | null;

/**
 * 需要读盘才能算出的写入。`update` 的输入是磁盘上的最新字段，返回值按字段级合并
 * 写回（没返回的字段保留磁盘上的值）。
 *
 * **为什么不只是 `(current) => values` 一个函数。** `upsertMemory` 的锁键是记忆
 * 文件的 URI，而 URI 由 identity 字段渲染（`renderMemoryUri`）。转换函数的输入依赖
 * 磁盘内容，渲染只能发生在读之后，而读必须在锁内——两者互相依赖。所以 URI 由调用方
 * 给出（它本来就有：补丁是按 URI 分组的），写盘前再用 identity 字段重渲染一次并
 * 比对，补丁改掉 identity 时直接拒绝，不做隐式 move。
 */
export interface MemoryUpdateInput {
  readonly uri: Uri;
  readonly update: MemoryUpdate;
  /**
   * 本次写入追加到 `sources` 的溯源（`Uri` 是产生这条记忆的归档，`archive_NNN`）。
   *
   * 缺省 = 不改 `sources`（保留磁盘上的值）。值与写入点绑定：写入方知道自己在为哪次
   * 归档写记忆，模型看不到原始材料 URI，让它输出只会得到幻觉。所以它不从抽取提示词
   * 里来，也不进 `MemoryFields`。
   *
   * 只放在「先读后写」这一形态上：直接传字段的调用方（`remember`、`consolidation`
   * 的写回）不掌握归档 URI，它们应当一个字段都不丢地保留旧值。
   */
  readonly provenance?: { readonly sources: readonly Uri[] };
}

/**
 * 写入内容。两种形态共用同一条实现：锁、字段级合并、`addOnly` 判据、复核闸门
 * （`status = pending`）都只写一遍。
 *
 * - 直接传字段：调用方已经知道自己要写什么。
 * - `{ uri, update }`：字段依赖磁盘上的最新正文（SEARCH/REPLACE 补丁）。
 */
export type MemoryWrite = MemoryFields | MemoryUpdateInput;

function isMemoryUpdateInput(input: MemoryWrite): input is MemoryUpdateInput {
  // 记忆字段的值只有 string / number / boolean / string[]（`FieldType`），
  // 只有转换形态的 `update` 是函数。
  return typeof (input as MemoryUpdateInput).update === 'function';
}

/**
 * 默认需要复核的记忆类型（§11.6）。
 *
 * **可以被 `memory.reviewRequired` 覆盖。** 曾经把它写死在这里，配置项存在但不生效——
 * 运维把 `rules` 从复核列表里去掉，写入仍然是 `pending`，然后控制台显示「待复核 1 条」
 * 而没有任何地方能解释它从哪来。
 *
 * 这份常量只是配置的默认值，不要直接用它判断。
 */
const DEFAULT_REVIEW_REQUIRED: readonly string[] = ['experiences', 'rules'];

export class MemoryService {
  readonly #filesystem: MemoryFileStore;
  readonly #locks: MemoryServicePorts['locks'];
  readonly #search: MemorySearchPort;
  readonly #logger: Logger;
  /** 需要复核的记忆类型。来自 `memory.reviewRequired`，不是写死的。 */
  readonly #reviewRequired: ReadonlySet<string>;

  constructor(ports: MemoryServicePorts) {
    this.#filesystem = ports.filesystem;
    this.#locks = ports.locks;
    this.#search = ports.search;
    this.#logger = ports.logger;
    this.#reviewRequired = new Set(ports.reviewRequired ?? DEFAULT_REVIEW_REQUIRED);
  }

  /** 读一条记忆；不存在返回 `null`。 */
  async read(uri: Uri): Promise<MemoryRecord | null> {
    return await readMemoryRecord(this.#filesystem, this.#logger, uri);
  }

  /**
   * 按记忆类型渲染路径并写。**字段级合并**：返回的字段覆盖磁盘上的同名字段，
   * 没返回的字段保留（见文件头「并发」）。
   *
   * `addOnly` 类型（`events`）在文件已存在时抛 `ALREADY_EXISTS`：事件是「某时发生了
   * 什么」，发生之后不会改变，覆盖写等于篡改历史（§11.1）。
   */
  async upsertMemory(
    scopeUri: Uri,
    schema: MemoryTypeSchema,
    input: MemoryWrite,
  ): Promise<MemoryWriteResult> {
    let target: MemoryUpdateInput;
    if (isMemoryUpdateInput(input)) {
      target = input;
    } else {
      // 直接传值：先校验 identity，`renderMemoryUri` 对缺失或非字符串的 identity
      // 只会说「必须是字符串」，定位不到「哪个字段不能为空」。
      assertMemoryIdentity(schema, input);
      target = {
        uri: renderMemoryUri(scopeUri, schema, input),
        // 直接传值时字段是静态的；合并仍然发生在锁内。
        update: () => input,
      };
    }

    // 锁覆盖整个读改写：`existing` 决定 `createdAt` / `created` / `addOnly` 判据，
    // 读在锁外时两个写者会各自基于同一份旧正文构造新正文（§18）。
    return this.#locks.withLock(
      target.uri,
      'exact',
      async () => {
        const existing = await readMemoryDocument(this.#filesystem, this.#logger, target.uri);
        const current = existing?.fields ?? {};
        // 补丁必须打在磁盘上的最新正文上：`current` 是锁内的读，不是调用方的快照。
        const next = target.update(current);
        if (next === null) {
          // 没有可写的字段：落盘只会改 `updated_at` 并把 `status` 打回 `pending`。
          return {
            uri: target.uri,
            memoryType: schema.type,
            created: false,
            written: false,
            before: existing?.body ?? null,
            after: existing?.body ?? '',
          };
        }

        // 合并而不是替换：转换函数只对自己返回的字段负责。
        const merged: Record<string, unknown> = { ...current, ...next };
        assertMemoryIdentity(schema, merged);
        assertFieldTypes(schema, merged);
        // 补丁改掉了 identity 字段（如 `name`）时，渲染出的路径与锁键不是同一个
        // 文件：写成功也只会多出一条重复记忆，目标文件里只剩半个结果。
        if (!renderMemoryUri(scopeUri, schema, merged).equals(target.uri)) {
          throw invalidArgument(
            `记忆 ${target.uri.toString()} 的 identity 字段被改写，写回会落到另一个文件。`,
            { uri: target.uri.toString(), memoryType: schema.type },
          );
        }
        if (existing !== null && schema.operationMode === 'addOnly') {
          throw new ComemError(
            'ALREADY_EXISTS',
            `记忆 ${target.uri.toString()} 已存在，${schema.type} 类型只允许新增。`,
            {
              uri: target.uri.toString(),
              memoryType: schema.type,
              // 供调用方区分「同一条事件重放」与「同 URI 的另一条事件」。两个值都
              // 在锁内读到，比较的是同一时刻的内容。
              existingContent: existing.fields[CONTENT_FIELD] ?? null,
              nextContent: merged[CONTENT_FIELD] ?? null,
            },
          );
        }

        const now = new Date().toISOString();
        // 覆盖写之前先把旧值留一份版本文件（W98）。判据用**正文有没有变**而不是
        // 「是不是覆盖写」：同一份正文再写一遍（重放、补 sources）没有旧值可丢，
        // 快照只会凭空多出五份一模一样的文件。
        const contentChanged =
          existing !== null && existing.fields[CONTENT_FIELD] !== merged[CONTENT_FIELD];
        // `addOnly` 已在上面抛错，`operationMode === 'upsert'` 这个判据在这里是显式
        // 的语义声明（只有「可覆盖写」的类型才有「被顶替的旧值」）。
        const snapshot =
          existing !== null &&
          existing.status === 'active' &&
          schema.operationMode === 'upsert' &&
          contentChanged
            ? await writeVersionSnapshot(
                this.#filesystem,
                this.#logger,
                scopeUri,
                schema,
                target.uri,
                existing,
                now,
              )
            : null;
        const supersedes = snapshot?.toString() ?? existing?.supersedes ?? null;

        const fields: Record<string, unknown> = { ...merged };
        if (schema.fields.some((field) => field.name === UPDATED_AT_FIELD)) {
          fields[UPDATED_AT_FIELD] = now;
        }
        const status: MemoryStatus = this.#reviewRequired.has(schema.type) ? 'pending' : 'active';
        // 溯源只在**真的写盘**时追加：合并循环里所有字段操作都失败时（`next === null`）
        // 这条记忆没有因为这次归档改变，给它记上一笔归档来源是错的。
        const sources = appendSources(
          existing?.sources ?? [],
          (target.provenance?.sources ?? []).map((source) => source.toString()),
        );

        const text = serializeMemoryDocument({
          uri: target.uri,
          memoryType: schema.type,
          status,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          schema,
          fields,
          sources,
          // 新文档的有效期从这一刻开始；`valid_until` 留空 = 仍然有效。
          validFrom: now,
          validUntil: null,
          supersedes,
        });
        await this.#filesystem.write(target.uri, text);

        this.#logger.info('记忆已写入', {
          uri: target.uri.toString(),
          memoryType: schema.type,
          status,
          created: existing === null,
        });

        // 画像的格式契约（§11.1）能由字面判定的部分在这里执行。**只告警，不拒绝**：
        // 拒绝或丢弃等于把模型抽到的事实直接扔掉，而且用户永远不知道。日志带
        // scope / URI / 违规类型与条数，**不带正文**——画像可能含个人信息。
        if (schema.type === profileMemoryType.type) {
          this.#warnProfileFormat(scopeUri, target.uri, fields[CONTENT_FIELD]);
        }

        return {
          uri: target.uri,
          memoryType: schema.type,
          created: existing === null,
          written: true,
          before: existing?.body ?? null,
          after: renderBody(fields[CONTENT_FIELD]),
        };
      },
      // 新记忆的父目录可能还不存在，此时锁文件也没有地方放——不建目录的话，
      // 两个并发写者会同时通过（见 `LockAcquireOptions.createParentDirectory`）。
      { createParentDirectory: true },
    );
  }

  /**
   * 复核通过：`pending` → `active`（§11.6）。已经是 `active` 时是空操作。
   *
   * 判定与写回在 `review.ts`，锁在这里取（§18）。
   */
  async approve(uri: Uri): Promise<void> {
    await this.#locks.withLock(uri, 'exact', async () => {
      await approveMemory(this.#filesystem, this.#logger, uri);
    });
  }

  /**
   * 复核拒绝（§11.6、§11.11）：回到写入前。判定、恢复与删除都在 `review.ts`，
   * 锁在这里取（§18）。
   */
  async reject(uri: Uri, reason: string): Promise<MemoryRejectResult> {
    return await this.#locks.withLock(
      uri,
      'exact',
      (): Promise<MemoryRejectResult> => rejectMemory(this.#filesystem, this.#logger, uri, reason),
    );
  }

  /**
   * 删除一条记忆（§11.5 的 `delete` 操作）。
   *
   * `rm -f` 语义：不存在不是错误。删除与覆盖写不同，它没有「部分成功」的形态，
   * 所以不需要读回来判断。**仍然持 `exact` 锁**：并发的 `upsertMemory` 会在
   * 「读完、还没写」之间被它看见，没有锁时删除与覆盖写的先后无法解释。
   */
  async remove(uri: Uri): Promise<void> {
    await this.#locks.withLock(uri, 'exact', async () => {
      await this.#filesystem.remove(uri);
    });
    this.#logger.info('记忆已删除', { uri: uri.toString() });
  }

  /** 待复核列表（§11.6）：遍历与 `.history` 的跳过在 `query.ts`。 */
  async listPending(
    scopeUri: Uri,
    options: { readonly limit?: number } = {},
  ): Promise<readonly MemoryRecord[]> {
    return await listPendingMemories(this.#filesystem, this.#logger, scopeUri, options);
  }

  /** §11.3 的抽取预取：目录检索、单文件直读、只返回 `active`（详见 `query.ts`）。 */
  async prefetch(
    scopeUri: Uri,
    schema: MemoryTypeSchema,
    query: string,
    topN: number,
  ): Promise<readonly MemoryRecord[]> {
    return await prefetchMemories(
      this.#filesystem,
      this.#logger,
      this.#search,
      scopeUri,
      schema,
      query,
      topN,
    );
  }

  /**
   * 画像正文不符合格式契约时记一条 warn（§11.1）。
   *
   * 调用点在写入成功之后：告警描述的是**已经落盘**的内容，写入失败时不该出现
   * 「画像不合规」的记录。
   *
   * 字段口径：`scope` 是画像所属的 scope 根（同一个 scope 只有一份画像），
   * `uri` 是具体文件，`rules` 是去重后的违规类型。正文与摘要都不进日志。
   */
  #warnProfileFormat(scopeUri: Uri, uri: Uri, content: unknown): void {
    const violations = validateProfileBody(typeof content === 'string' ? content : '');
    if (violations.length === 0) {
      return;
    }
    this.#logger.warn('画像正文不符合格式契约，已写入（仅告警）。', {
      scope: scopeUri.toString(),
      uri: uri.toString(),
      memoryType: profileMemoryType.type,
      violationCount: violations.length,
      rules: [...new Set(violations.map((violation) => violation.kind))],
    });
  }
}
