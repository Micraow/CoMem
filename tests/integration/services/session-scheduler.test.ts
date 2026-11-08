/**
 * 会话自动提交与过期的端到端验收（架构文档 §10.2.1、§11.7）。
 *
 * 这一份从 `createContainer` 起来，配置走真实 YAML：`session.autoCommit.*` /
 * `session.expiry.*` / `memory.ttl.*` 此前**没有任何生产调用点**，服务层单测
 * （`tests/integration/services/session.test.ts` 的 `shouldAutoCommit`）直接构造
 * `SessionService` 再同步调判定函数，绕过了「谁在什么时候调它」——那正是缺陷能藏住
 * 的地方。这里只信「起容器 → tick → 看磁盘」。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { estimateTokens, renderMessageText } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = 'comem://user/local';

/** 一天的毫秒数；`memory.ttl.defaultDays` 的换算来源。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 一条消息的正文：1500 个汉字。
 *
 * `estimateTokens` 对 CJK 按 1 码点 1 token 计（`domain/session.ts`），所以 5 条消息
 * 是 7500 token。阈值 5000 让「4 条就超」——不必写满 150000 的默认值，测试也不该因为
 * 分词器的精度而红。
 */
const MESSAGE_TEXT = '记住这个偏好'.repeat(250);

let dataDir: string;
let container: Container | undefined;

async function startContainer(yaml: string): Promise<Container> {
  const configPath = join(dataDir, 'config.yaml');
  await writeFile(configPath, yaml, 'utf8');
  return createContainer({
    // 配置从临时目录读，不是仓库根：本机的 `config.yaml` 可能指向真实网关。
    configPath,
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
}

function message(id: string): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text: MESSAGE_TEXT }],
    // 固定在过去：过期用例要有确定的「多久没动」。
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function sessionDirectory(sessionUri: Uri): string {
  return join(dataDir, 'user', 'local', 'sessions', sessionUri.name);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-session-scheduler-'));
  container = undefined;
});

afterEach(async () => {
  await container?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('自动提交（container → tick）', () => {
  it('写够 5000 token → tick → archive_001 出现，live 只剩 keepRecentCount 条', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    enabled: true',
        '    pendingTokenThreshold: 5000',
        '    messageCountThreshold: 100000',
        '    minCommitIntervalSeconds: 0',
        '    keepRecentCount: 3',
      ].join('\n'),
    );
    container = started;
    expect(started.scheduler.started).toBe(true);

    const session = started.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE));
    for (let index = 0; index < 5; index += 1) {
      await session.addMessage(sessionUri, message(`m${index}`));
    }
    const before = await session.load(sessionUri);
    expect(before.messageCount).toBe(5);
    expect(before.pendingTokens).toBeGreaterThan(5000);

    const result = await started.scheduler.tick();

    expect(result).toMatchObject({ skipped: false, scanned: 1, committed: 1 });

    // 归档目录与归档消息真的落盘了（不是「任务建了、文件没有」）。
    const archiveDirectory = join(sessionDirectory(sessionUri), 'history', 'archive_001');
    await expect(readdir(archiveDirectory)).resolves.toContain('messages.jsonl');
    const archived = (await readFile(join(archiveDirectory, 'messages.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n');
    expect(archived).toHaveLength(2);

    // 活跃会话只剩 keepRecentCount 条，且 token 数降回阈值以下。
    const after = await session.load(sessionUri);
    expect(after.messages.map((item) => item.id)).toEqual(['m2', 'm3', 'm4']);
    expect(after.pendingTokens).toBe(
      after.messages.reduce((total, item) => total + estimateTokens(renderMessageText(item)), 0),
    );
    expect(after.pendingTokens).toBeLessThan(5000);

    // 提交计数器与时间戳跟着走：下一轮的限速器与归档序号都靠它。
    const meta: unknown = JSON.parse(
      await readFile(join(sessionDirectory(sessionUri), '.meta.json'), 'utf8'),
    );
    expect(meta).toMatchObject({ commitCount: 1 });
    expect(meta).toMatchObject({ lastCommitAt: expect.any(String) });

    // 阶段一建了归档任务（阶段二由 CommitRunner 认领）。
    expect(started.services.task.claimable()).toHaveLength(1);
  });

  it('第二个 tick 在 minCommitIntervalSeconds 内不重复提交', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    pendingTokenThreshold: 5000',
        '    messageCountThreshold: 100000',
        '    minCommitIntervalSeconds: 3600',
        '    keepRecentCount: 1',
      ].join('\n'),
    );
    container = started;

    const session = started.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE));
    for (let index = 0; index < 5; index += 1) {
      await session.addMessage(sessionUri, message(`m${index}`));
    }

    await expect(started.scheduler.tick()).resolves.toMatchObject({ committed: 1 });
    // 再补一条消息：阈值仍然满足，但限速器不允许第二次归档。
    await session.addMessage(sessionUri, message('m5'));
    await expect(started.scheduler.tick()).resolves.toMatchObject({ committed: 0 });

    const history = await session.listArchives(sessionUri);
    expect(history.map((uri) => uri.name)).toEqual(['archive_001']);
  });
});

describe('会话过期（container → tick）', () => {
  it('idleTimeoutSeconds 到期后归档：status 变 archived，消息还在', async () => {
    const started = await startContainer(
      [
        'session:',
        // 关掉自动提交，只留过期：验证两个开关是独立的。
        '  autoCommit:',
        '    enabled: false',
        '  expiry:',
        '    idleTimeoutSeconds: 60',
        '    action: archive',
      ].join('\n'),
    );
    container = started;
    expect(started.scheduler.started).toBe(true);

    const session = started.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE));
    await session.addMessage(sessionUri, message('m0'));

    await expect(started.scheduler.tick()).resolves.toMatchObject({ expired: 1, deleted: 0 });

    const archived = await session.load(sessionUri);
    expect(archived.status).toBe('archived');
    expect(archived.messages).toHaveLength(1);
  });

  it('action: delete 时物理删除会话目录', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    enabled: false',
        '  expiry:',
        '    idleTimeoutSeconds: 60',
        '    action: delete',
      ].join('\n'),
    );
    container = started;

    const session = started.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE));
    await session.addMessage(sessionUri, message('m0'));

    await expect(started.scheduler.tick()).resolves.toMatchObject({ deleted: 1 });
    await expect(readdir(join(dataDir, 'user', 'local', 'sessions'))).resolves.toEqual([]);
  });
});

describe('记忆 TTL（container → 写入）', () => {
  it('memory.ttl.defaultDays 真的落到 node.expires_at 上', async () => {
    const started = await startContainer(['memory:', '  ttl:', '    defaultDays: 30'].join('\n'));
    container = started;
    expect(started.scheduler.started).toBe(true);

    const memory = Uri.parse(SCOPE).child('memories', 'preferences', 'code-style.md');
    await started.services.filesystem.write(memory, '用户偏好 TypeScript 严格模式。');
    await started.services.indexObserver.drain();

    const row = started.db.prepare('SELECT expires_at FROM node WHERE uri = ?').get(memory.toString());
    const expiresAt = row?.['expires_at'];
    expect(typeof expiresAt).toBe('string');

    // 30 天后的**绝对时刻**（不是相对天数，也不是 NULL）。基准是写入时间，与断言
    // 时刻相差不到一秒，用 29.9–30.1 天留出边界。
    const deltaDays = (Date.parse(String(expiresAt)) - Date.now()) / MILLISECONDS_PER_DAY;
    expect(deltaDays).toBeGreaterThan(29.9);
    expect(deltaDays).toBeLessThan(30.1);
  });
});

describe('配置全关', () => {
  it('自动提交、会话过期、记忆 TTL 全关时不起定时器', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    enabled: false',
        '  expiry:',
        '    idleTimeoutSeconds: 0',
        'memory:',
        '  ttl:',
        '    defaultDays: 0',
      ].join('\n'),
    );
    container = started;

    expect(started.scheduler.started).toBe(false);
    // 关掉定时器不等于「调度器没了」：手动 tick 仍然可用（测试与脚本要确定点）。
    await expect(started.scheduler.tick()).resolves.toMatchObject({ skipped: false, scanned: 0 });
  });
});
