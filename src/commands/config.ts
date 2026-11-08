/**
 * 命令行的统一配置入口（架构文档 §18）。
 *
 * `--config` / `--data-dir` 从真实 `process.argv` 解析——**每个命令都必须用它**，
 * 不要自己拼 `loadConfig({...})`。自己拼的代价是漏传 `argv` 时 flag 静默失效，
 * 而 `pnpm password` 会把密码设到错误的数据根上。
 *
 * 为什么默认值取 `process.argv.slice(2)` 而不是 `[]`：漏传 `argv` 是这条链路上
 * 唯一的静默失败点（`loadConfig` 在 `argv` 为空时回落到当前目录的 `config.yaml`，
 * 不报错）。把「不传就是真实进程参数」写进入口，漏传命令就不能再悄悄换掉数据根。
 *
 * 测试要注入配置时用 `path`（优先于 `--config`）或显式 `argv`：
 *
 * ```ts
 * await setPassword('alice', 'pw', { argv: ['--config', badYaml] });
 * ```
 */

import { loadConfig, type ComemConfig } from '../config/index.js';

export interface CommandConfigOptions {
  /** 进程参数；缺省取真实 `process.argv.slice(2)`。只识别 `--config` 与 `--data-dir` */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** 配置文件路径，优先于 `--config`（测试注入用） */
  path?: string;
  /** 覆盖容器判定，透传给 `resolveDataDir`（§6.5） */
  container?: boolean;
  /** 覆盖 root 判定，透传给 `resolveDataDir`（§6.5） */
  isRoot?: boolean;
}

export function loadCommandConfig(options: CommandConfigOptions = {}): ComemConfig {
  return loadConfig({
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.container === undefined ? {} : { container: options.container }),
    ...(options.isRoot === undefined ? {} : { isRoot: options.isRoot }),
    argv: [...(options.argv ?? process.argv.slice(2))],
  });
}
