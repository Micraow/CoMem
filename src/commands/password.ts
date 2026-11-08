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
  const logger = new ConsoleLogger({ level: 'warn' });
  const db = openDatabase(join(config.dataDir, META_DIRECTORY, DATABASE_FILE));
  try {
    runMigrations(db);
    const users = new UserRepository({ db, logger });
    if (users.get(username) === null) {
      throw new ComemError('NOT_FOUND', `用户不存在：${username}`, { username });
    }
    users.setPasswordHash(username, await hashSecret(password), new Date());
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
