/**
 * 评估数据集的解析与校验（W23）。
 *
 * 数据集是**评估的输入，也是评估最容易做假的地方**。所以这一层的职责不是「把
 * YAML 读进来」，而是「在读进来的那一刻就把不可能成立的标注挡掉」：
 *
 * - 语料的 key 必须是合法的 `comem://` URI。拼错的 URI 不会报错，只会让检索
 *   永远命中不到——最后表现为「某个引擎召回率莫名其妙地低」。
 * - 标注里引用的 URI 必须真的在语料里。引用一个不存在的文档等于把「检索失败」
 *   记在检索头上，而它其实是「数据集写错了」。
 * - 分级相关度必须是 `0–3` 的整数。越界值在 nDCG 的指数增益下会放大成任意
 *   分数，`0.5` 这种半档则会让「同一个标注换一种写法得到不同分数」。
 *
 * **启动即抛，不静默跳过。** 跳过一条坏标注的后果是「这次评估的查询数少了 3 条」，
 * 而报告里只写「30 条查询」——没人会去数。宁可让 `pnpm eval` 直接失败。
 *
 * 数据集格式（YAML 或 JSON，解析后是同一个对象）见 `eval/README.md`。
 */

import { ComemError } from '../domain/errors.js';
import { Uri } from '../domain/uri.js';

/**
 * 一条查询的标注。
 *
 * `relevant` 与 `graded` 是**同一份判断的两种粒度**：前者是二值（相关 / 不相关），
 * 后者是 0–3 的分级。分开而不是「graded 为 0 就当不相关」，是因为两种标注的语义
 * 不同——`graded` 里出现 `0` 表示「这条文档我明确判为不相关」，而「没出现在
 * `graded` 里」表示「没标注」。前者会进入 IDCG 的候选，后者不会。
 */
export interface EvalCase {
  readonly query: string;
  /** 二值相关性：用于 recall / MRR */
  readonly relevant: readonly string[];
  /** 分级相关性（0-3）：用于 nDCG。缺省时 relevant 里的算 1 */
  readonly graded?: Readonly<Record<string, number>>;
}

export interface EvalDataset {
  readonly name: string;
  readonly description: string;
  /** 语料：URI → 正文 */
  readonly corpus: Readonly<Record<string, string>>;
  readonly cases: readonly EvalCase[];
}

/**
 * 分级相关度的上界。
 *
 * 3 是 TREC 与多数 IR 教程采用的四档标注（0–3）的上界：0 不相关、1 边缘、2 相关、
 * 3 高度相关。四档足够区分「同一个主题的不同文档」，再多档人工标注的一致性会先
 * 崩掉。改这个值要同时改 `eval/datasets/*.yaml` 里所有标注。
 */
const MAX_GRADE = 3;

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(`${field} 必须是字符串。`, { field, value });
  }
  return value;
}

/** 校验 corpus 的一个 key；不是合法 `comem://` URI 时转成数据集错误。 */
function requireUri(value: string, field: string): string {
  try {
    return Uri.parse(value).toString();
  } catch (error) {
    throw invalid(`${field} 不是合法的 comem:// URI：${value}`, {
      field,
      value,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseCorpus(raw: unknown): Readonly<Record<string, string>> {
  if (!isRecord(raw)) {
    throw invalid('corpus 必须是「URI → 正文」的对象。', { field: 'corpus' });
  }

  const corpus: Record<string, string> = {};
  for (const [uri, text] of Object.entries(raw)) {
    const normalized = requireUri(uri, 'corpus 的 key');
    if (normalized !== uri) {
      // 规范化之后与原文不同，说明这条 key 会以另一个形态进索引；写入时又会
      // 用到规范化后的形态，标注却还是原文——两边对不上。
      throw invalid(`corpus 的 key 不是规范形态：${uri}（应为 ${normalized}）`, {
        field: 'corpus',
        uri,
        normalized,
      });
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw invalid(`corpus 里 ${uri} 的正文不能为空。`, { field: 'corpus', uri });
    }
    corpus[uri] = text;
  }

  const uris = Object.keys(corpus);
  if (uris.length === 0) {
    throw invalid('corpus 不能为空。', { field: 'corpus' });
  }
  return corpus;
}

function parseGraded(raw: unknown, corpus: Readonly<Record<string, string>>, query: string): Record<string, number> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw invalid(`查询「${query}」的 graded 必须是「URI → 0–3 整数」的对象。`, {
      field: 'cases.graded',
      query,
    });
  }

  const graded: Record<string, number> = {};
  for (const [uri, relevance] of Object.entries(raw)) {
    requireUri(uri, `查询「${query}」的 graded key`);
    if (!(uri in corpus)) {
      throw invalid(`查询「${query}」的 graded 引用了语料里没有的文档：${uri}`, {
        field: 'cases.graded',
        query,
        uri,
      });
    }
    if (
      typeof relevance !== 'number' ||
      !Number.isInteger(relevance) ||
      relevance < 0 ||
      relevance > MAX_GRADE
    ) {
      throw invalid(
        `查询「${query}」给 ${uri} 的相关度必须是 0–${MAX_GRADE} 的整数，实际是 ${String(relevance)}。`,
        { field: 'cases.graded', query, uri, relevance },
      );
    }
    graded[uri] = relevance;
  }
  return graded;
}

function parseCase(raw: unknown, corpus: Readonly<Record<string, string>>, index: number): EvalCase {
  const field = `cases[${index}]`;
  if (!isRecord(raw)) {
    throw invalid(`${field} 必须是对象。`, { field });
  }

  const query = requireString(raw['query'], `${field}.query`).trim();
  if (query === '') {
    throw invalid(`${field}.query 不能为空。`, { field });
  }

  const relevantRaw = raw['relevant'];
  if (!Array.isArray(relevantRaw)) {
    throw invalid(`${field}.relevant 必须是 URI 数组。`, { field });
  }
  // 去重保留首次出现的顺序：同一条文档标两次不应该让召回率的分母变大。
  const relevant: string[] = [];
  const seen = new Set<string>();
  for (const item of relevantRaw) {
    if (typeof item !== 'string') {
      throw invalid(`${field}.relevant 里必须是字符串。`, { field, value: item });
    }
    requireUri(item, `${field}.relevant`);
    if (!(item in corpus)) {
      throw invalid(`查询「${query}」标注了语料里没有的文档：${item}`, {
        field: `${field}.relevant`,
        query,
        uri: item,
      });
    }
    if (!seen.has(item)) {
      seen.add(item);
      relevant.push(item);
    }
  }

  const graded = parseGraded(raw['graded'], corpus, query);
  return {
    query,
    relevant,
    ...(graded === undefined ? {} : { graded }),
  };
}

/**
 * 把已经解析好的 YAML / JSON 对象校验成 `EvalDataset`。
 *
 * 入参是 `unknown` 而不是 `EvalDataset`：调用方（CLI）读到的是一份用户可编辑的
 * 文件，类型系统在文件边界上是假的。所有字段在这里做一次运行时校验，之后整个
 * 评估流程可以信任数据集。
 *
 * 错误一律是 `INVALID_ARGUMENT`（`details.field` 指出是哪一段），除了 URI 解析
 * 失败会被转成同一个错误码——数据集错误不应该以 `INVALID_URI` 的形式冒到 CLI
 * 顶层，那会让人以为「命令行的 URI 参数写错了」。
 */
export function parseDataset(raw: unknown): EvalDataset {
  if (!isRecord(raw)) {
    throw invalid('数据集顶层必须是对象。', {});
  }

  const name = requireString(raw['name'], 'name').trim();
  if (name === '') {
    throw invalid('name 不能为空。', { field: 'name' });
  }

  const descriptionRaw = raw['description'];
  const description = descriptionRaw === undefined ? '' : requireString(descriptionRaw, 'description');

  const corpus = parseCorpus(raw['corpus']);

  const casesRaw = raw['cases'];
  if (!Array.isArray(casesRaw)) {
    throw invalid('cases 必须是数组。', { field: 'cases' });
  }
  if (casesRaw.length === 0) {
    throw invalid('cases 不能为空：没有查询的评估只会打印一张空表。', { field: 'cases' });
  }

  const cases = casesRaw.map((item, index) => parseCase(item, corpus, index));

  return { name, description, corpus, cases };
}
