#!/usr/bin/env node
/**
 * `co-mem` 安装与自检（架构文档 §15.8 的目录、§14 的端点）。
 *
 * ```bash
 * co-mem install --host claude-code [--settings ~/.claude/settings.json]
 * co-mem doctor
 * co-mem uninstall --host claude-code
 * ```
 *
 * ## 为什么写进宿主 settings 而不是自建配置
 *
 * 宿主的 hook 配置是它唯一会读的地方。插件自己维护一份清单，还要在宿主升级时
 * 对账——那是两份状态。`install` 直接改宿主的 settings，`uninstall` 只删我们
 * 加的那些条目（按脚本路径匹配），别人的 hook 一个不动。
 *
 * ## 备份
 *
 * 改之前写 `<settings>.bak`。**只有文件已存在时才写**：不存在时备份一份空文件
 * 只会让 `uninstall` 之后多出一个看不懂的残留。
 *
 * ## 为什么用绝对路径 + `--host`
 *
 * hook 命令由宿主的 shell 执行，工作目录不确定。脚本路径必须绝对；宿主名用
 * 参数传（`--host`），避免依赖 `VAR=value cmd` 这种 POSIX 专有的前缀语法。
 */

import { realpathSync } from 'node:fs';
import { access, chmod, constants, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveTempDir } from './lib/config.mjs';
import { createHttpClient } from './lib/http.mjs';

/** 本包的根目录。 */
const ROOT = dirname(fileURLToPath(import.meta.url));

/** 六个 hook（架构文档 §15.2 的表格）。 */
export const HOOK_EVENTS = Object.freeze({
  SessionStart: 'session-start.mjs',
  UserPromptSubmit: 'user-prompt-submit.mjs',
  PreToolUse: 'pre-tool-use.mjs',
  PostToolUse: 'post-tool-use.mjs',
  Stop: 'stop.mjs',
  PreCompact: 'pre-compact.mjs',
});

/** 需要按工具名预过滤的事件（少起进程）。 */
const MATCHERS = Object.freeze({ PreToolUse: 'Read|Write|Edit' });

/** 各宿主的默认 settings 路径。 */
const DEFAULT_SETTINGS = Object.freeze({
  'claude-code': join(homedir(), '.claude', 'settings.json'),
  dsh: join(homedir(), '.dsh', 'settings.json'),
});

/**
 * 判断一个 hook 条目是不是我们加的。
 *
 * 按脚本路径匹配（`servers/xxx.mjs`），不按事件名——同名事件下可能还有别人的
 * hook，删错一个就破坏用户已有的自动化。
 */
const SCRIPT_MARKER = join('integrations', 'servers');

export function isCoMemHook(hook) {
  return (
    typeof hook === 'object' &&
    hook !== null &&
    typeof hook.command === 'string' &&
    (hook.command.includes(SCRIPT_MARKER) || hook.command.includes('integrations\\servers'))
  );
}

function isCoMemMatcherGroup(group) {
  if (typeof group !== 'object' || group === null || !Array.isArray(group.hooks)) {
    return false;
  }
  return group.hooks.length > 0 && group.hooks.every((hook) => isCoMemHook(hook));
}

function shellQuote(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

/** 生成一条 hook 命令。绝对路径，`--host` 决定适配器。 */
export function hookCommand(event, host, options = {}) {
  const script = join(options.root ?? ROOT, 'servers', HOOK_EVENTS[event]);
  const executable = options.execPath ?? process.execPath;
  return `${shellQuote(executable)} ${shellQuote(script)} --host ${host}`;
}

/** 生成一个 matcher group。 */
export function hookGroup(event, host, options = {}) {
  const matcher = MATCHERS[event];
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: hookCommand(event, host, options) }],
  };
}

function settingsPathFor(host, explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }
  const value = DEFAULT_SETTINGS[host];
  if (value === undefined) {
    throw new Error(`未知宿主：${host}（可用：${Object.keys(DEFAULT_SETTINGS).join(' / ')}）`);
  }
  return value;
}

async function readSettings(file) {
  try {
    const text = await readFile(file, 'utf8');
    if (text.trim() === '') {
      return {};
    }
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings 顶层必须是对象。');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`读取 settings 失败：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

async function backup(file) {
  try {
    await access(file, constants.R_OK);
  } catch {
    return null;
  }
  const target = `${file}.bak`;
  await copyFile(file, target);
  return target;
}

async function writeSettings(file, settings) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function hooksOf(settings) {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return {};
  }
  return hooks;
}

/**
 * 安装：备份 → 清掉我们的旧条目 → 写入六条 → 落盘。
 *
 * 幂等：重复 install 不会产生重复条目（先清后写）。
 *
 * @param {{ host?: string, settingsPath?: string, root?: string, execPath?: string }} [options]
 * @returns {Promise<{ settingsPath: string, backupPath: string | null, events: string[] }>}
 */
export async function install(options = {}) {
  const host = options.host ?? 'claude-code';
  const settingsPath = settingsPathFor(host, options.settingsPath);
  const settings = await readSettings(settingsPath);
  const backupPath = await backup(settingsPath);

  const hooks = hooksOf(settings);
  for (const event of Object.keys(HOOK_EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing.filter((group) => !isCoMemMatcherGroup(group)), hookGroup(event, host, options)];
  }
  settings.hooks = hooks;

  // 脚本走 `node` 调用，执行位不是必需；设上是为了 `doctor` 的「可执行」检查与
  // 手工直接执行脚本的场景。失败（只读挂载）不阻断安装。
  for (const script of Object.values(HOOK_EVENTS)) {
    await chmod(join(options.root ?? ROOT, 'servers', script), 0o755).catch(() => {});
  }

  await writeSettings(settingsPath, settings);
  return { settingsPath, backupPath, events: Object.keys(HOOK_EVENTS) };
}

/**
 * 卸载：只删我们加的条目，空事件键一并清掉。
 *
 * @param {{ host?: string, settingsPath?: string }} [options]
 * @returns {Promise<{ settingsPath: string, backupPath: string | null, removed: number }>}
 */
export async function uninstall(options = {}) {
  const host = options.host ?? 'claude-code';
  const settingsPath = settingsPathFor(host, options.settingsPath);
  const settings = await readSettings(settingsPath);
  const backupPath = await backup(settingsPath);

  const hooks = hooksOf(settings);
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (isCoMemMatcherGroup(group)) {
        removed += group.hooks.length;
        continue;
      }
      // matcher group 里混着我们的条目与别人的：只摘掉我们的。
      if (typeof group === 'object' && group !== null && Array.isArray(group.hooks)) {
        const remaining = group.hooks.filter((hook) => !isCoMemHook(hook));
        removed += group.hooks.length - remaining.length;
        if (remaining.length === 0) {
          continue;
        }
        kept.push({ ...group, hooks: remaining });
        continue;
      }
      kept.push(group);
    }
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }
  await writeSettings(settingsPath, settings);
  return { settingsPath, backupPath, removed };
}

/**
 * 自检：四项，每项 `passed` + 一句怎么修。
 *
 * 依赖可注入：测试不碰真实 home 目录、不连真实服务端。
 *
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ name: string, passed: boolean, hint: string }[]>}
 */
export async function doctor(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? ROOT;
  const checks = [];

  // 1. 服务端可达。
  try {
    const config = await loadConfig({ env });
    // 2s 是自检的等待上限（经验值）：doctor 是人工触发的，服务端在跑就秒回，
    // 等满默认的 5s 只会让人以为命令卡住了。
    const http = createHttpClient({ ...config, timeoutMs: 2000, fetchImpl: options.fetchImpl });
    await http.get('/health');
    checks.push({ name: '服务端可达', passed: true, hint: `已连接 ${config.baseUrl}` });
  } catch (error) {
    checks.push({
      name: '服务端可达',
      passed: false,
      hint: `启动服务端后重试；地址由 ${env['COMEM_BASE_URL'] ?? 'baseUrl'} 指定（${error instanceof Error ? error.message : String(error)}）`,
    });
  }

  // 2. 配置文件存在且填了 userId。
  try {
    const config = await loadConfig({ env });
    if (config.userId === '') {
      checks.push({
        name: '配置文件',
        passed: false,
        hint: `在 ${config.configFile} 里写 userId: <你的用户名>`,
      });
    } else {
      checks.push({ name: '配置文件', passed: true, hint: config.configFile });
    }
  } catch (error) {
    checks.push({
      name: '配置文件',
      passed: false,
      hint: `修复配置语法后重试（${error instanceof Error ? error.message : String(error)}）`,
    });
  }

  // 3. 六个 hook 脚本可执行。
  const missing = [];
  for (const script of Object.values(HOOK_EVENTS)) {
    try {
      await access(join(root, 'servers', script), constants.R_OK);
    } catch {
      missing.push(script);
    }
  }
  checks.push(
    missing.length === 0
      ? { name: 'hook 脚本', passed: true, hint: `${Object.keys(HOOK_EVENTS).length} 个入口可读` }
      : { name: 'hook 脚本', passed: false, hint: `缺少 ${missing.join(', ')}；重新运行 co-mem install` },
  );

  // 4. 游标文件可写（锁与去重也在同一个目录）。
  try {
    const dir = resolveTempDir(env);
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    const cursorFile = join(dir, 'comem-cursors.json');
    try {
      JSON.parse(await readFile(cursorFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    checks.push({ name: '游标文件可写', passed: true, hint: dir });
  } catch (error) {
    checks.push({
      name: '游标文件可写',
      passed: false,
      hint: `检查目录写权限，或用 COMEM_HOOK_TMPDIR 换一个可写目录（${error instanceof Error ? error.message : String(error)}）`,
    });
  }

  return checks;
}

/** 解析 `--key value` 形式的参数。 */
function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  return typeof value === 'string' && value !== '' && !value.startsWith('--') ? value : undefined;
}

const USAGE = `用法：
  co-mem install --host claude-code [--settings <path>]
  co-mem doctor
  co-mem uninstall --host claude-code [--settings <path>]`;

async function main(argv) {
  const command = argv[0];
  if (command === 'install') {
    const result = await install({ host: flag(argv, 'host'), settingsPath: flag(argv, 'settings') });
    process.stdout.write(`已安装 ${result.events.length} 个 hook 到 ${result.settingsPath}\n`);
    if (result.backupPath !== null) {
      process.stdout.write(`备份：${result.backupPath}\n`);
    }
    for (const [event, script] of Object.entries(HOOK_EVENTS)) {
      process.stdout.write(`  ${event.padEnd(16)} -> servers/${script}\n`);
    }
    return 0;
  }

  if (command === 'uninstall') {
    const result = await uninstall({ host: flag(argv, 'host'), settingsPath: flag(argv, 'settings') });
    process.stdout.write(`已从 ${result.settingsPath} 删除 ${result.removed} 条 CoMem hook\n`);
    if (result.backupPath !== null) {
      process.stdout.write(`备份：${result.backupPath}\n`);
    }
    return 0;
  }

  if (command === 'doctor') {
    const checks = await doctor();
    let failed = 0;
    for (const check of checks) {
      process.stdout.write(`${check.passed ? '通过' : '失败'}  ${check.name}  ${check.hint}\n`);
      if (!check.passed) {
        failed += 1;
      }
    }
    return failed === 0 ? 0 : 1;
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

/**
 * 是不是被直接执行（而不是被测试 import）。
 *
 * 不能直接比字符串：`bin` 装出来的是符号链接，Node 给的 `argv[1]` 是链接路径。
 * 两边都取 realpath 再比。
 */
function isEntryPoint() {
  const argv = process.argv[1];
  if (argv === undefined) {
    return false;
  }
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isEntryPoint();
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
