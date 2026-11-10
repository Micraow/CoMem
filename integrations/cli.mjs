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

/**
 * 宿主事件名 → 脚本（架构文档 §15.2 的表格）。
 *
 * 键是**宿主**事件名（写进宿主 settings 的那一层必须用宿主认识的名字）；
 * 内部事件名在 `lib/events.mjs`。两边的键集必须一致：认识但没装的事件等于
 * 一个永远不会出现的事件名，装了但没登记的事件会被适配器拒绝——`event-names`
 * 测试会断言这一点。
 */
export const HOOK_EVENTS = Object.freeze({
  SessionStart: 'session-start.mjs',
  UserPromptSubmit: 'user-prompt-submit.mjs',
  PreToolUse: 'pre-tool-use.mjs',
  PostToolUse: 'post-tool-use.mjs',
  Stop: 'stop.mjs',
  PreCompact: 'pre-compact.mjs',
  // 同一条链路：两个事件都是「对话要没了，把待处理消息交出去」。预算不同
  // （1200ms vs 30000ms），由 `lib/lifecycle.mjs` 按事件分开给。
  SessionEnd: 'pre-compact.mjs',
});

/** 需要按工具名预过滤的事件（少起进程）。 */
const MATCHERS = Object.freeze({ PreToolUse: 'Read|Write|Edit' });

/**
 * 各宿主的默认 settings 路径。两处都实测过宿主真的读——把 `hooks` 写成字符串，
 * 看宿主拿哪个路径报类型错：
 *
 * | 宿主 | 路径 | 实测报错 |
 * |---|---|---|
 * | `claude-code` | `~/.claude/settings.json` | `<path> (hooks): "hooks" must be an object mapping event names to matcher arrays` |
 * | `codex` | `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`） | `failed to parse hooks config <path>: … expected struct HookEventsToml` |
 *
 * 两个宿主的形状一致：顶层 `hooks` 是「事件名 → matcher 组数组」，与 `install`
 * 写入的一致。`codex` 的 `hooks` 受 `config.toml` 的 `[features].hooks` 控制
 * （Codex 0.167 的 `codex features list` 里 `hooks` 是 `stable true`，默认开启），
 * 而且**首次运行前要在 `/hooks` 里信任一次**：信任状态记在
 * `hooks.state."…".trusted_hash` 里，`install` 写不进去。
 *
 * **项目级 `<repo>/.codex/hooks.json` 未验证**：非交互的 `codex exec` 在 git 仓库
 * 根目录里没有读它（可能要先经过交互式信任）。用 `--settings` 指到项目级路径前
 * 先自己确认一次。
 *
 * `dsh` 不在这张表里——DSH 没有 settings 里的 hook 面，见 `UNSUPPORTED_HOSTS`。
 */
const DEFAULT_SETTINGS = Object.freeze({
  'claude-code': join(homedir(), '.claude', 'settings.json'),
  codex: join(homedir(), '.codex', 'hooks.json'),
});

/**
 * 不支持 `install` 的宿主，值是给人看的失败说明。
 *
 * **DSH 为什么不能装。** DSH 0.2.2-rc.1 读的配置是
 * `$DSH_HOME/profiles/<name>/settings.yaml`，而它已经是遗留文件：启动时
 * `@deepseek-ai/dsh-settings` 的 `importLegacyDocument` 把它一次性导入 profile 并
 * 改名为 `settings.yaml.imported`（`lib/index.js:346-349`）。`~/.dsh/settings.json`
 * 一个读者都没有——写它不报错，只是永远不生效。
 *
 * DSH 的 hook 面**完全由插件提供**：`@deepseek-ai/dsh-hooks-claude-code`（Claude
 * Code 方言）或 `@deepseek-ai/dsh-hooks-codex`（Codex 方言），挂在
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里，用 `configPath` 指向一个
 * `hooks.json`，或指向一个 `hooks` 键里放着配置的 settings 文件。字段名来自这两个
 * 包 0.2.2-rc.1 的 README。
 *
 * `install` 完不成这条链路：它要往 profile 里装插件、改一份 YAML，两件都不做；
 * 两个桥还各只实现 5 个事件（没有 `PreCompact` / `SessionEnd`），`Stop` 拿到的
 * `transcript_path` 也永远是空值。写一个没人读的文件比报错更难发现——用户会以为
 * 装好了。所以这里直接失败。
 *
 * **未验证**：本机没有装这两个桥包，`configPath` 能否真的让 CoMem 的 hook 跑起来
 * 没有端到端验证；字段名来自包 README，不是实测。
 */
const UNSUPPORTED_HOSTS = Object.freeze({
  dsh: [
    'DSH 没有 settings 里的 hook 面，install 不会写 ~/.dsh/settings.json（那个文件没有读者）。',
    '',
    '  DSH 0.2.2-rc.1 读 $DSH_HOME/profiles/<name>/settings.yaml；它已是遗留文件，',
    '  启动时被一次性导入并改名为 settings.yaml.imported。',
    '',
    '  DSH 的 hook 面由插件提供：@deepseek-ai/dsh-hooks-claude-code 或',
    '  @deepseek-ai/dsh-hooks-codex，挂在 $DSH_HOME/profiles/<name>/cordis.patch.yml',
    '  里，用 configPath 指向一个 hooks 文件。本仓库不安装这两个插件、也不改 profile',
    '  的 YAML，所以 install 在这里无法完成。配置格式未端到端验证，两个桥各只实现',
    '  5 个事件（PreCompact / SessionEnd 不会触发）。',
    '',
    '  代替做法：',
    '    1. node integrations/cli.mjs install --host claude-code --settings <path>/hooks.json',
    '    2. 在 cordis.patch.yml 里加：',
    "         - name: '@deepseek-ai/dsh-hooks-claude-code'",
    '           config:',
    '             configPath: <path>/hooks.json',
    '    3. 验证：启动 DSH 后看日志里的 hook/invoked，再跑一轮对话看游标是否前进。',
    '',
    '  细节见 integrations/README.md 的「DSH」一节。',
  ].join('\n'),
});

/**
 * 宿主专属的 PreToolUse matcher 覆盖。
 *
 * Codex 没有 `Read` 工具：文件编辑走 `apply_patch`（别名 `Edit` / `Write`），命令走
 * `Bash`。matcher 按工具名过滤，多列几个别名只是少起进程，不影响正确性。
 */
const HOST_MATCHERS = Object.freeze({
  codex: Object.freeze({ PreToolUse: 'apply_patch|Edit|Write|Read' }),
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
  const matcher = HOST_MATCHERS[host]?.[event] ?? MATCHERS[event];
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: hookCommand(event, host, options) }],
  };
}

/**
 * 宿主能不能被 `install` / `uninstall` 写配置。
 *
 * 必须在**写第一个字节之前**调用：静默写一个没人读的文件，用户会以为装好了。
 * 显式传了 `--settings` 也不放行——`--host dsh` 选的是 DSH 适配器的载荷形状，
 * 而 DSH 只通过两个桥插件发 Claude Code / Codex 方言的载荷。
 */
function assertInstallable(host) {
  const explanation = UNSUPPORTED_HOSTS[host];
  if (explanation !== undefined) {
    throw new Error(explanation);
  }
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
 * 安装：备份 → 清掉我们的旧条目 → 写入 `HOOK_EVENTS` 里的每一条 → 落盘。
 *
 * 幂等：重复 install 不会产生重复条目（先清后写）。
 *
 * 不支持的宿主（`dsh`）在这里抛错，**一个字节都不写**。这是安装期失败：CLI 把
 * 说明打到 stderr、退出码非 0。
 *
 * @param {{ host?: string, settingsPath?: string, root?: string, execPath?: string }} [options]
 * @returns {Promise<{ settingsPath: string, backupPath: string | null, events: string[] }>}
 * @throws 宿主没有可写的配置落点（见 `UNSUPPORTED_HOSTS`）
 */
export async function install(options = {}) {
  const host = options.host ?? 'claude-code';
  assertInstallable(host);
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
 * 与 `install` 对称：不支持的宿主同样在写之前失败。旧版本可能已经往
 * `~/.dsh/settings.json` 写过东西，那个文件没有读者，删不删都不影响 DSH——这里
 * 不替用户收拾，只在说明里点出它的存在。
 *
 * @param {{ host?: string, settingsPath?: string }} [options]
 * @returns {Promise<{ settingsPath: string, backupPath: string | null, removed: number }>}
 * @throws 宿主没有可写的配置落点（见 `UNSUPPORTED_HOSTS`）
 */
export async function uninstall(options = {}) {
  const host = options.host ?? 'claude-code';
  assertInstallable(host);
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

  // 3. hook 脚本可读（`HOOK_EVENTS` 里的每个入口）。
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

/**
 * 取一个「写了就必须带值」的 flag。
 *
 * `flag()` 在下一个 token 缺失或以 `--` 开头时返回 `undefined`，`install` 于是退回
 * 默认宿主——`co-mem install --host` 会**静默写进 `~/.claude/settings.json`**，
 * 看起来还成功了。忘记值比打错宿主更难发现，所以这里直接报用法。
 */
function requiredFlag(argv, name) {
  if (!argv.includes(`--${name}`)) {
    return undefined;
  }
  const value = flag(argv, name);
  if (value === undefined) {
    throw new Error(
      `--${name} 缺值。用法：co-mem <install|uninstall> --host <claude-code|codex> [--settings <path>]`,
    );
  }
  return value;
}

const USAGE = `用法：
  co-mem install --host <claude-code|codex> [--settings <path>]
  co-mem doctor
  co-mem uninstall --host <claude-code|codex> [--settings <path>]

--host dsh 不可用：DSH 没有 settings 里的 hook 面，见 integrations/README.md 的「DSH」一节。`;

async function main(argv) {
  const command = argv[0];
  if (command === 'install') {
    const result = await install({
      host: requiredFlag(argv, 'host'),
      settingsPath: requiredFlag(argv, 'settings'),
    });
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
    const result = await uninstall({
      host: requiredFlag(argv, 'host'),
      settingsPath: requiredFlag(argv, 'settings'),
    });
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
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // 失败必须是**安装期可见**的：一行 stderr + 非 0 退出码。未捕获的
    // rejection 也会退 1，但它把说明埋进 stack trace，在 `| tail` 里看不见。
    process.stderr.write(
      `co-mem 失败：\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
