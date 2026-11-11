/**
 * 设置用户密码（架构文档 §12.7 多用户部署的引导入口）。
 *
 * 用法：
 *
 * ```bash
 * printf '%s' '新密码' | pnpm password local
 * ```
 *
 * **密码从 stdin 读，不从命令行参数读**：`ps` / shell history 会留下 `argv`，
 * 而密码进进程表就等于泄露。stdin 走管道，`printf` 的那一行是唯一需要清理的地方。
 *
 * 为什么需要这个命令：管理面设密码的端点自己也要认证，全新实例没有任何凭据，
 * 循环依赖。启动时会自动建 `user:local`（`server.subject`）但没有密码——这个
 * 命令补上第一步。
 *
 * 不启动调度器、不建服务图：只打开数据库写一行哈希。与 `reindex` 同样只做一件事。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConsoleLogger } from '../adapters/log/console.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { UserRepository } from '../adapters/sqlite/user-repository.js';
import { ComemError } from '../domain/errors.js';
import { hashSecret } from '../services/password.js';

import { loadCommandConfig } from './config.js';

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/** 读 stdin 的全部内容（`printf '%s' ... | pnpm password`）。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 从数据根打开数据库并设密码。返回用户 ID。 */
export async function setPassword(
  username: string,
  password: string,
  options: {
    readonly path?: string;
    readonly env?: NodeJS.ProcessEnv;
    /** 进程参数；缺省取真实 `process.argv.slice(2)`，`--config` / `--data-dir` 靠它生效 */
    readonly argv?: readonly string[];
  } = {},
): Promise<string> {
  if (password === '') {
    throw new ComemError('INVALID_ARGUMENT', '密码不能为空。');
  }

  // 走统一入口：漏传 `argv` 会让 `--config` / `--data-dir` 静默失效，密码就写到
  // 错误的数据根上（见 `commands/config.ts`）。
  const config = loadCommandConfig(options);
  const dataDir = config.dataDir;
  // `_meta/` 由服务启动时创建；它不存在说明数据根还没初始化，`openDatabase` 只会
  // 报 `unable to open database file`——那句话不指向任何下一步。
  const metaDir = join(dataDir, META_DIRECTORY);
  if (!existsSync(metaDir)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `数据根还没有初始化：${dataDir} 下没有 _meta 目录。先启动一次服务（它会建库），或检查 dataDir 配置是否指向正确的数据根。`,
      { dataDir },
    );
  }

  const logger = new ConsoleLogger({ level: 'warn' });
  const db = openDatabase(join(metaDir, DATABASE_FILE));
  try {
    runMigrations(db);
    const users = new UserRepository({ db, logger });
    if (users.get(username) === null) {
      throw new ComemError(
        'NOT_FOUND',
        `用户不存在：${username}。首次部署先在控制台 /setup 创建管理员；已经有管理员时在「用户与组」页（或 POST /admin/users）创建账号，再设密码。`,
        { username },
      );
    }
    users.setPasswordHash(username, await hashSecret(password), new Date());
    // 密码写进去了，但认证关着时登录端点返回 404——不说的话，使用者会以为
    // 「设好密码就能登录」，然后在 /login 上找不到原因。
    if (!config.auth.enabled) {
      process.stderr.write(
        '警告：密码已写入，但认证未启用（auth.enabled = false），登录端点不可用。要在 config.yaml 里打开 auth.enabled 并重启，才能用多用户登录。\n',
      );
    }
    return username;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const username = process.argv[2];
  if (username === undefined || username === '') {
    process.stderr.write('用法：printf \'%s\' \'新密码\' | pnpm password <username>\n');
    process.exitCode = 2;
  } else {
    try {
      const password = (await readStdin()).trimEnd();
      await setPassword(username, password, { argv: process.argv.slice(2) });
      process.stdout.write(`已设置 ${username} 的密码。\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
