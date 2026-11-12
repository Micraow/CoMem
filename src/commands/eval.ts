/**
 * 检索质量评估命令（W23）。
 *
 * 用法：
 *
 * ```bash
 * pnpm eval                                  # 跑 eval/datasets/basic.yaml
 * pnpm eval --dataset eval/datasets/basic.yaml --k 5
 * pnpm eval --engines fts5,vector,hybrid     # 只跑指定引擎
 * pnpm eval --rerank                         # 追加 hybrid+rerank 变体
 * pnpm eval --hotness-weight 0.1             # 追加 hybrid+hotness 变体
 * pnpm eval --level-weights 1,1,1            # 追加 hybrid+levels（关掉层级先验）
 * pnpm eval --json                           # 机器可读输出
 * ```
 *
 * ## 输出约定
 *
 * **stdout 只放结果**（表格或 JSON），日志与进度走 stderr。这样
 * `pnpm eval --json > report.json` 拿到的是一份干净结果，而不是被日志行割裂的
 * JSON——与 `reindex` 同一条约定。
 *
 * 表格用 Unicode 制表符（`┌─┬┐`），不依赖终端宽度：列宽按内容算，中文按两列宽
 * 计。目的是**能直接贴进文档**，而不是「在某种终端里看起来还行」。
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { ConsoleLogger } from '../adapters/log/console.js';
import { createContainer } from '../bootstrap/container.js';
import { ComemError, errorMessage } from '../domain/errors.js';
import type { RetrievalEngine } from '../domain/retrieval.js';
import { parseDataset } from '../eval/dataset.js';
import {
  EvalRunner,
  type EvalReport,
  type EvalVariant,
} from '../eval/runner.js';

import { readFlag } from '../config/file.js';
import { loadCommandConfig } from './config.js';

export interface EvalCliOptions {
  readonly datasetPath: string;
  readonly k: number;
  /** 默认变体的引擎集合；`--rerank` 等追加变体不受它影响 */
  readonly engines: readonly RetrievalEngine[];
  readonly configPath?: string;
  /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` 靠它生效 */
  readonly argv?: readonly string[];
  readonly rerank: boolean;
  readonly hotnessWeight?: number;
  readonly levelWeights?: { readonly l0: number; readonly l1: number; readonly l2: number };
}

const DEFAULT_DATASET_PATH = 'eval/datasets/basic.yaml';

/** 默认 top-k，与 `EvalRunner` 的 `DEFAULT_K` 同源（10）。 */
const DEFAULT_K = 10;

const ENGINES: readonly RetrievalEngine[] = ['fts5', 'vector', 'hybrid'];

function isRetrievalEngine(value: string): value is RetrievalEngine {
  return (ENGINES as readonly string[]).includes(value);
}

/** `--engines` 的取值：逗号分隔，去重，非法值直接报错。 */
function parseEngines(raw: string): readonly RetrievalEngine[] {
  const engines: RetrievalEngine[] = [];
  for (const token of raw.split(',')) {
    const engine = token.trim();
    if (engine === '') {
      continue;
    }
    if (!isRetrievalEngine(engine)) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `--engines 只支持 ${ENGINES.join(' | ')}：${engine}`,
        { engine },
      );
    }
    if (!engines.includes(engine)) {
      engines.push(engine);
    }
  }
  if (engines.length === 0) {
    throw new ComemError('INVALID_ARGUMENT', '--engines 不能为空。', {});
  }
  return engines;
}

/** `--level-weights l0,l1,l2`。 */
function parseLevelWeights(raw: string): {
  readonly l0: number;
  readonly l1: number;
  readonly l2: number;
} {
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 3) {
    throw new ComemError('INVALID_ARGUMENT', '--level-weights 需要三个逗号分隔的数：l0,l1,l2', {
      value: raw,
    });
  }
  const [l0, l1, l2] = parts;
  if (l0 === undefined || l1 === undefined || l2 === undefined) {
    throw new ComemError('INVALID_ARGUMENT', '--level-weights 需要三个数。', { value: raw });
  }
  for (const weight of [l0, l1, l2]) {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `--level-weights 的值必须是正数：${raw}`, {
        value: raw,
      });
    }
  }
  return { l0, l1, l2 };
}

function parseK(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_K;
  }
  const k = Number(raw);
  if (!Number.isInteger(k) || k <= 0) {
    throw new ComemError('INVALID_ARGUMENT', `--k 必须是正整数：${raw}`, { k: raw });
  }
  return k;
}

function parseHotnessWeight(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const weight = Number(raw);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new ComemError('INVALID_ARGUMENT', `--hotness-weight 必须在 [0, 1] 内：${raw}`, {
      weight: raw,
    });
  }
  return weight;
}

function parseArgs(argv: readonly string[]): EvalCliOptions {
  const datasetPath = readFlag(argv, 'dataset') ?? DEFAULT_DATASET_PATH;
  const enginesRaw = readFlag(argv, 'engines');
  const configPath = readFlag(argv, 'config');
  const levelWeightsRaw = readFlag(argv, 'level-weights');
  const hotnessWeight = parseHotnessWeight(readFlag(argv, 'hotness-weight'));

  return {
    datasetPath,
    k: parseK(readFlag(argv, 'k')),
    engines: enginesRaw === undefined ? ENGINES : parseEngines(enginesRaw),
    ...(configPath === undefined ? {} : { configPath }),
    rerank: argv.includes('--rerank'),
    ...(hotnessWeight === undefined ? {} : { hotnessWeight }),
    ...(levelWeightsRaw === undefined ? {} : { levelWeights: parseLevelWeights(levelWeightsRaw) }),
  };
}

/**
 * 默认变体 + 显式追加的可选变体。
 *
 * `--engines` 只过滤默认的三个单引擎变体；`--rerank` / `--hotness-weight` /
 * `--level-weights` 是「额外加一个对照」，不会因为 `--engines` 里没有 hybrid
 * 就消失——用户显式要的对照必须出现在报告里。
 */
function buildVariants(options: EvalCliOptions): readonly EvalVariant[] {
  const variants: EvalVariant[] = options.engines.map((engine) => ({ name: engine, engine }));

  if (options.rerank) {
    variants.push({
      name: 'hybrid+rerank',
      engine: 'hybrid',
      overrides: { rerankEnabled: true },
    });
  }
  if (options.hotnessWeight !== undefined) {
    variants.push({
      name: `hybrid+hotness=${String(options.hotnessWeight)}`,
      engine: 'hybrid',
      overrides: { hotnessWeight: options.hotnessWeight },
    });
  }
  if (options.levelWeights !== undefined) {
    // 层级加权在两种路径上都生效（`SearchService.#rank` 的单引擎排序，与
    // `reciprocalRankFusion` 里每个后端的贡献）。对照变体必须挂在 `hybrid` 上：
    // 默认引擎就是 `hybrid`（`config.example.yaml`），只测 `fts5` 测不到
    // 「层级先验有没有进入融合」这条路径。
    variants.push({
      name: 'hybrid+levels',
      engine: 'hybrid',
      overrides: { levelWeights: options.levelWeights },
    });
  }
  return variants;
}

/**
 * 跑一次评估。
 *
 * `--config` 通过闭包绑定到 `createContainer`，不经过 `EvalRunner` 的入参：
 * 执行器只负责「每个变体建一个容器」，配置从哪来是 CLI 的事。这样执行器的测试
 * 可以注入任意容器工厂，不需要碰配置文件。
 */
export async function runEval(options: EvalCliOptions): Promise<EvalReport> {
  // 统一入口先加载一次配置：`--config` 写坏时在读完数据集、建任何容器之前报错，
  // 而不是每个变体各报一次。
  loadCommandConfig({
    ...(options.configPath === undefined ? {} : { path: options.configPath }),
    ...(options.argv === undefined ? {} : { argv: options.argv }),
  });
  // `--data-dir` 对 eval 没有意义：每个变体都跑在 `mkdtemp` 的临时数据根里。
  // 明确拒绝而不是静默忽略——静默忽略会让人以为评估写进了自己的数据根。
  if (readFlag(options.argv ?? process.argv.slice(2), 'data-dir') !== undefined) {
    throw new ComemError('INVALID_ARGUMENT', 'eval 总是使用临时数据根，--data-dir 不生效。', {
      flag: '--data-dir',
    });
  }

  const raw: unknown = parseYaml(await readFile(options.datasetPath, 'utf8'));
  const dataset = parseDataset(raw);

  const logger = new ConsoleLogger({
    level: 'warn',
    // 日志走 stderr：stdout 留给表格 / JSON。
    write: (line) => process.stderr.write(line),
  });

  const createContainerWithConfig = (containerOptions: Parameters<typeof createContainer>[0] = {}) =>
    createContainer({
      ...containerOptions,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    });

  const runner = new EvalRunner({ createContainer: createContainerWithConfig, logger });
  return runner.run({ dataset, k: options.k, variants: buildVariants(options) });
}

/**
 * 单个码点的显示宽度。
 *
 * 东亚宽字符（CJK、假名、全角标点、emoji）按两列计，其余按一列。这不是完整的
 * Unicode East Asian Width 实现——只覆盖评估报告里会出现的区间。表格要「能贴进
 * 文档」，宽度算错的后果是边框错位，而不是数据错误。
 */
function codePointWidth(code: number): number {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    ? 2
    : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function padCell(text: string, width: number, align: 'left' | 'right'): string {
  const padding = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'left' ? `${text}${padding}` : `${padding}${text}`;
}

interface Column {
  readonly header: string;
  readonly align: 'left' | 'right';
}

/**
 * 渲染成可贴进文档的表格。
 *
 * 分隔线用 `├┼┤` / `└┴┘`，与 `┌┬┐` 同一套制表符——混用 ASCII 的 `+` 会在
 * 等宽字体里错位。
 */
function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((column, index) =>
    Math.max(
      displayWidth(column.header),
      ...rows.map((row) => displayWidth(row[index] ?? '')),
    ),
  );

  const rule = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`;

  const renderRow = (cells: readonly string[]): string =>
    `│${columns
      .map((column, index) => ` ${padCell(cells[index] ?? '', widths[index] ?? 0, column.align)} `)
      .join('│')}│`;

  const lines = [rule('┌', '┬', '┐'), renderRow(columns.map((column) => column.header))];
  lines.push(rule('├', '┼', '┤'));
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  lines.push(rule('└', '┴', '┘'));
  return lines.join('\n');
}

/**
 * 报告 → 表格。
 *
 * 表格里的数字保留 3 位小数：指标本身是 `[0, 1]` 的比例，3 位已经足够区分
 * 变体（0.001 的差异在这个规模的数据集上没有统计意义）。延迟保留 1 位小数，
 * 单位毫秒——`find` 的延迟在个位数到几十毫秒之间，1 位小数够看。
 */
export function formatReport(report: EvalReport): string {
  const queryCount = report.variants[0]?.metrics.queryCount ?? 0;
  const columns: readonly Column[] = [
    { header: '变体', align: 'left' },
    { header: `Recall@${String(report.k)}`, align: 'right' },
    { header: 'MRR', align: 'right' },
    { header: `NDCG@${String(report.k)}`, align: 'right' },
    { header: 'p50', align: 'right' },
    { header: 'p95', align: 'right' },
  ];
  const rows = report.variants.map((variant) => [
    variant.name,
    variant.metrics.recallAtK.toFixed(3),
    variant.metrics.mrr.toFixed(3),
    variant.metrics.ndcgAtK.toFixed(3),
    `${variant.latency.p50Ms.toFixed(1)}ms`,
    `${variant.latency.p95Ms.toFixed(1)}ms`,
  ]);

  return [
    `数据集 ${report.dataset}（${String(queryCount)} 条查询，k=${String(report.k)}）`,
    '',
    renderTable(columns, rows),
    '',
  ].join('\n');
}

/** 只有直接执行（`tsx src/commands/eval.ts`）时才跑 CLI 入口，测试 import 不触发。 */
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  runEval({ ...parseArgs(argv), argv }).then(
    (report) => {
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    },
    (error: unknown) => {
      process.stderr.write(`eval 失败：${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
