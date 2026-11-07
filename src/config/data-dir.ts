/**
 * 数据根推导（架构文档 §6.5）。
 *
 * 没有「一个默认值走天下」的答案：桌面单用户、系统服务、容器三种运行形态的惯例不同，
 * 所以按运行形态推导默认值，并且永远允许显式覆盖。
 */

import { existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface ResolveDataDirOptions {
  /** `--data-dir` 或 `COMEM_DATA_DIR` 的值；空串按未提供处理 */
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  /** 平台。默认 `process.platform`，可注入以便测三种布局 */
  platform?: NodeJS.Platform;
  /** 用户主目录。默认 `os.homedir()`，可注入以便测三种布局 */
  homedir?: string;
  /** 是否在容器里。默认按 `/.dockerenv` 存在或 pid 1 判定（架构文档 §6.5） */
  container?: boolean;
  /** 是否以 root 运行。默认 `process.getuid?.() === 0`（架构文档 §6.5） */
  isRoot?: boolean;
}

/** `/var/lib/<app>` 是 FHS 定义的应用可变状态数据位置，容器与系统服务都用它。 */
const SYSTEM_DATA_DIR = '/var/lib/comem';

function isContainerProcess(): boolean {
  return existsSync('/.dockerenv') || process.pid === 1;
}

function isRootProcess(): boolean {
  return process.getuid?.() === 0;
}

export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();

  // 1. 显式值优先：`--data-dir` 或 `COMEM_DATA_DIR`。
  const explicit = options.explicit ?? env.COMEM_DATA_DIR;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  // 2./3. 容器与系统服务：XDG 是桌面会话规范，容器里 `$HOME` 不可预测也没法挂卷。
  const container = options.container ?? isContainerProcess();
  const isRoot = options.isRoot ?? isRootProcess();
  if (container || isRoot) {
    return SYSTEM_DATA_DIR;
  }

  // 4. 桌面单用户。
  const appData = env.APPDATA;
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'comem');
    case 'win32':
      return join(appData !== undefined && appData !== '' ? appData : join(home, 'AppData', 'Roaming'), 'comem');
    default: {
      const xdgDataHome = env.XDG_DATA_HOME;
      const base = xdgDataHome !== undefined && xdgDataHome !== '' ? xdgDataHome : join(home, '.local', 'share');
      return join(base, 'comem');
    }
  }
}
