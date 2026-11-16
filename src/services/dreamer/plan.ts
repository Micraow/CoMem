/**
 * 操作 → 写盘计划（架构文档 §11.8「校验：整批失败」「写回」「溯源」）。
 */

import {
  resolveMemoryTarget,
  type ConsolidationOperation,
} from '../../domain/consolidation.js';
import { ComemError } from '../../domain/errors.js';
import {
  assertFieldTypes,
  assertMemoryIdentity,
  identityFields,
} from '../../domain/memory-type.js';
import { isVersionFile } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';

import { appendSources, renderMemoryUri, type MemoryRecord } from '../memory.js';

import type { DreamerPorts, DeletePlan, UpsertPlan, WritePlan } from './types.js';

const CONTENT_FIELD = 'content';

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
export async function planOperations(
  ports: Pick<DreamerPorts, 'memory' | 'stat'>,
  scope: Uri,
  operations: readonly ConsolidationOperation[],
): Promise<readonly WritePlan[]> {
  const { memory, stat } = ports;
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
    if (operation.kind !== 'delete' && uri.parent()?.name === 'preferences' && uri.name.startsWith('inferred-')) {
      throw new ComemError('INVALID_ARGUMENT', '推断偏好只能通过证据校验与复核流程写入。', { uri: operation.uri });
    }
    if (isVersionFile(uri)) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `${operation.uri} 是记忆的版本文件（.history 下的旧值快照），版本文件不参与合并；请改为对规范路径操作。`,
        { uri: operation.uri, kind: operation.kind },
      );
    }
    if (operation.kind === 'delete') {
      const record = assertActive(await requireRecord(memory, operation.uri, uri));
      if (record.entityId !== undefined) throw new ComemError('INVALID_ARGUMENT', '有稳定身份的实体不能由自动合并删除，请先明确纠正其关联。', { uri: operation.uri });
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
      const existing = await memory.read(uri);
      if (existing !== null) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `记忆 ${operation.uri} 已存在（status=${existing.status}），add 会覆盖它：pending 还在复核（§11.6），archived 已被 TTL 归档（§11.7）。`,
          { uri: operation.uri, status: existing.status },
        );
      }
      const path = await stat.stat(uri);
      if (path !== null && path.kind === 'file') {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `${operation.uri} 已被一份非记忆文件占用（缺少 frontmatter 或 memory_type），add 会覆盖它；先移走那个文件，或换一个路径。`,
          { uri: operation.uri, kind: path.kind },
        );
      }
      const values = { ...target.identity, [CONTENT_FIELD]: operation.content };
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
    const record = assertActive(await requireRecord(memory, operation.uri, uri));
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
    if (renderMemoryUri(scope, target.schema, values).toString() !== operation.uri) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `记忆 ${operation.uri} 的 identity 字段与路径不一致，写回会落到另一个文件。`,
        { uri: operation.uri, memoryType: target.schema.type },
      );
    }

    assertMemoryIdentity(target.schema, values);
    assertFieldTypes(target.schema, values);

    upserts.push({ operation, uri, schema: target.schema, values });
  }

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
async function requireRecord(
  memory: DreamerPorts['memory'],
  raw: string,
  uri: Uri,
): Promise<MemoryRecord> {
  const record = await memory.read(uri);
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
function assertActive(record: MemoryRecord): MemoryRecord {
  if (record.status !== 'active') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `记忆 ${record.uri.toString()} 的状态是 ${record.status}，不是合并候选：pending 还在复核（§11.6），archived 已被 TTL 归档（§11.7）。`,
      { uri: record.uri.toString(), status: record.status },
    );
  }
  return record;
}
