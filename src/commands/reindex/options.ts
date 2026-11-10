/**
 * 命令的输入输出契约（`ReindexOptions` / `ReindexResult`）与命令行选项解析。
 *
 * 选项只解析 `--only` / `--dry-run`，其余 flag 归 `loadCommandConfig`。
 */

import { ComemError } from '../../domain/errors.js';

export interface ReindexOptions {
  /** 数据根（测试注入用）；命令行传 `--data-dir` */
  readonly dataDir?: string;
  /** 配置文件路径（测试注入用）；命令行传 `--config` */
  readonly configPath?: string;
  /** 环境变量（测试注入用）；缺省 `process.env` */
  readonly env?: NodeJS.ProcessEnv;
  /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` / `--data-dir` 靠它生效 */
  readonly argv?: readonly string[];
  /** `--only=embeddings|index|links|all`，默认 all */
  readonly only?: 'embeddings' | 'index' | 'links' | 'all';
  readonly dryRun?: boolean;
}

export interface ReindexResult {
  /** 磁盘上的节点数（文件 + 目录）。`dryRun` 时是「会被处理」的数量 */
  readonly scanned: number;
  /** 实际写入的检索索引 / 向量条数 */
  readonly rewritten: number;
  /**
   * 本次写入 `node_embedding` 的行数（一个文件一条）。
   *
   * 与 `rewritten` 分开：`rewritten` 是「有东西被写回的节点数」，一次写入既可能
   * 只重写检索索引，也可能顺带补齐向量。切换 `retrieval.engine` 之后要回答的是
   * 「补齐了多少条向量」，只有这个字段能回答。
   */
  readonly vectors: number;
  /**
   * 本次按 `sources` 重建的 `derived_from` 边数（一条记忆可以有多条）。
   *
   * 与 `rewritten` 分开，理由同 `vectors`：一次重建既可能重写索引行，也可能顺带
   * 重算关联边。手工改过 `sources` 之后要回答的是「边重算了几条」，只有这个字段能答。
   */
  readonly links: number;
  /** 嵌入没变而跳过的文件数 */
  readonly skipped: number;
  /** 解析失败或嵌入降级的节点数 */
  readonly failed: number;
}

/** 解析 `--only` 的取值。非法值直接抛 `INVALID_ARGUMENT`，不静默取默认。 */
function parseOnly(raw: string): ReindexOptions['only'] {
  if (raw === 'embeddings' || raw === 'index' || raw === 'links' || raw === 'all') {
    return raw;
  }
  throw new ComemError(
    'INVALID_ARGUMENT',
    `--only 只支持 embeddings | index | links | all：${raw}`,
    { only: raw },
  );
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = `--${name}`;
  for (const [index, arg] of argv.entries()) {
    if (arg === prefixed) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${prefixed}=`)) {
      return arg.slice(prefixed.length + 1);
    }
  }
  return undefined;
}

/**
 * 只解析命令自己的参数。`--config` / `--data-dir` 归 `loadCommandConfig` 解析：
 * 在这里再读一遍就会多一份「哪个 flag 算配置」的实现，漏一个就静默失效。
 */
export function parseArgs(argv: readonly string[]): ReindexOptions {
  const only = readFlag(argv, 'only');
  return {
    ...(only === undefined ? {} : { only: parseOnly(only) }),
    ...(argv.includes('--dry-run') ? { dryRun: true } : {}),
  };
}
