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

import type { ConsolidationPorts, DeletePlan, UpsertPlan, WritePlan } from './types.js';

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
  ports: Pick<ConsolidationPorts, 'memory' | 'stat'>,
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
    // 版本是 `supersedes` 链上的旧值（W98），删掉一份就断链。但这条守卫不改变
    // 任何成功/失败结果，只改变 `add` 的拒绝理由：
    //
    // - `delete` / `update` 的版本 URI 到不了这里：`validateOperations` 先用
    //   `inventory.uris`（`all`，已排除版本文件）判「指向的记忆不存在」，整批在
    //   写盘计划之前就整批拒绝了；
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
      const record = assertActive(await requireRecord(memory, operation.uri, uri));
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
      const existing = await memory.read(uri);
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
      const path = await stat.stat(uri);
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
async function requireRecord(
  memory: ConsolidationPorts['memory'],
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
