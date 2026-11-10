/**
 * 会话自动提交与过期的端到端验收（架构文档 §10.2.1、§11.7）。
 *
 * 这一份从 `createContainer` 起来，配置走真实 YAML：`session.autoCommit.*` /
 * `session.expiry.*` / `memory.ttl.*` 此前**没有任何生产调用点**，服务层单测
 * （`tests/integration/services/session.test.ts` 的 `shouldAutoCommit`）直接构造
 * `SessionService` 再同步调判定函数，绕过了「谁在什么时候调它」——那正是缺陷能藏住
 * 的地方。这里只信「起容器 → tick → 看磁盘」。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  RequestLogRepository,
  type RequestLogRow,
} from '../../../src/adapters/sqlite/request-log-repository.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { Logger } from '../../../src/domain/log.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { estimateTokens, renderMessageText } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

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

/**
 * 写一条真正的记忆文件（带 frontmatter 的 `memory_type`）。
 *
 * TTL 只清理「确实是记忆」的文档：没有 `memory_type` 的普通 Markdown 不归档、也不
 * 物理删除（§11.7）。这些用例测的是调度器把配置传给清扫，所以输入必须是记忆，
 * 不能是裸正文——否则它们会在新判据下正确地什么也不做。
 */
async function writeMemory(
  containerUnderTest: Container,
  uri: Uri,
  content: string,
): Promise<void> {
  await containerUnderTest.services.filesystem.write(
    uri,
    [
      '---',
      'memory_type: preferences',
      'status: active',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-01T00:00:00.000Z',
      '---',
      '',
      '## content',
      '',
      content,
    ].join('\n'),
    AUTH_PRINCIPALS,
  );
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

/**
 * 相对此刻的一个 ISO 时刻。
 *
 * 用于把索引行伪装成「若干天前写入 / 归档」的记忆：TTL 的判据是索引里的
 * `updated_at` / `archived_at`，不是文件的 mtime，而等真实时钟走过一天不现实。
 * 这与本文件既有 TTL 用例的做法一致；改的是**时间输入**，不是被测逻辑。
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * MILLISECONDS_PER_DAY).toISOString();
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
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
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
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
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

  /**
   * `session.autoCommit.idleTimeoutSeconds` 默认 0（关）。此前只有
   * `tests/unit/domain/session.test.ts` 直接调 `shouldAutoCommit` 纯函数，没有任何
   * 测试证明「真实装配下空闲真的会触发提交」——判定函数写好了而没人按时调它，
   * 正是这个开关能静默失效的地方。
   */
  it('idleTimeoutSeconds 到期后自动提交：archive_001 落盘，live 只剩 keepRecentCount 条', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    enabled: true',
        '    pendingTokenThreshold: 1000000',
        '    messageCountThreshold: 100000',
        '    minCommitIntervalSeconds: 0',
        '    idleTimeoutSeconds: 60',
        '    keepRecentCount: 1',
      ].join('\n'),
    );
    container = started;

    const session = started.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    // 两条消息的 createdAt 都固定在 2026-01-01：相对此刻早已超过 60 秒空闲。
    // token / 消息数阈值刻意设得足够高，这一轮只能是「空闲」触发的。
    await session.addMessage(sessionUri, message('m0'));
    await session.addMessage(sessionUri, message('m1'));

    await expect(started.scheduler.tick()).resolves.toMatchObject({
      scanned: 1,
      committed: 1,
    });

    const live = await session.load(sessionUri);
    expect(live.messages.map((item) => item.id)).toEqual(['m1']);
    const archiveDirectory = join(sessionDirectory(sessionUri), 'history', 'archive_001');
    await expect(readdir(archiveDirectory)).resolves.toContain('messages.jsonl');
    const archived = (await readFile(join(archiveDirectory, 'messages.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n');
    expect(archived).toHaveLength(1);
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
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
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
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m0'));

    await expect(started.scheduler.tick()).resolves.toMatchObject({ deleted: 1 });
    // 删除会投递一次父目录（`sessions/`）的摘要失效：等它跑完再看磁盘，否则读到
    // 的是一份「正在被重算」的快照（`.abstract.md` / `.overview.md` / 临时锁文件
    // 都可能正好出现）。断言的是「会话目录没了」，不是「`sessions/` 是空目录」。
    await started.services.indexObserver.drain();
    const entries = await readdir(join(dataDir, 'user', 'local', 'sessions'));
    expect(entries).not.toContain(sessionUri.name);
  });
});

describe('临时上传清理（container → tick）', () => {
  it('超过 24 小时的上传被清理，新的留下，条数进轮次摘要', async () => {
    const started = await startContainer(['session:', '  autoCommit:', '    enabled: true'].join('\n'));
    container = started;
    expect(started.scheduler.started).toBe(true);

    const tmpDir = join(dataDir, '_meta', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const oldId = 'staged_old';
    const oldPath = join(tmpDir, oldId);
    await writeFile(oldPath, new Uint8Array([1]));
    await writeFile(
      `${oldPath}.meta.json`,
      JSON.stringify({
        uploadId: oldId,
        fileName: 'old.pdf',
        size: 1,
        // 比 24 小时阈值再早一秒：直接写元数据，不依赖 sleep。
        stagedAtMs: Date.now() - 24 * 60 * 60 * 1000 - 1000,
      }),
      'utf8',
    );
    const fresh = await started.services.resource.stageUpload(new Uint8Array([2]), {
      fileName: 'fresh.pdf',
    });

    const result = await started.scheduler.tick();

    expect(result).toMatchObject({ stagedSwept: 1 });
    await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fresh.tempPath)).toBeInstanceOf(Buffer);
  });
});

describe('记忆 TTL（container → 清扫）', () => {

  it('memory.ttl.defaultDays 是滑动窗口：超出窗口的记忆归档，窗口内的留下', async () => {
    const started = await startContainer(['memory:', '  ttl:', '    defaultDays: 30'].join('\n'));
    container = started;
    expect(started.scheduler.started).toBe(true);

    const stale = Uri.parse(SCOPE).child('memories', 'preferences', 'stale.md');
    const fresh = Uri.parse(SCOPE).child('memories', 'preferences', 'fresh.md');
    await writeMemory(started, stale, '很久以前写下的偏好。');
    await writeMemory(started, fresh, '刚写下的偏好。');
    await started.services.indexObserver.drain();

    // 把其中一条改成「31 天前写入、之后再没被访问」。判据就是索引里的
    // `max(updated_at, last_accessed_at)`，改这一列等价于一条放置了 31 天的记忆
    // （文件的 mtime 不方便构造，而 TTL 不读 mtime）。
    started.db
      .prepare('UPDATE node SET updated_at = ? WHERE uri = ?')
      .run(new Date(Date.now() - 31 * MILLISECONDS_PER_DAY).toISOString(), stale.toString());

    await expect(started.scheduler.tick()).resolves.toMatchObject({ ttlArchived: 1 });

    const statusOf = (uri: Uri): string =>
      String(started.db.prepare('SELECT status FROM node WHERE uri = ?').get(uri.toString())?.['status']);
    expect(statusOf(stale)).toBe('archived');
    expect(statusOf(fresh)).toBe('active');
  });

  /**
   * 滑动窗口的输入是「最后一次被使用」。检索命中也是使用——但记录访问在
   * `SearchService.#recordHits` 里，曾经被 `telemetry.hotness.weight === 0` 门控挡住，
   * 默认部署下 `last_accessed_at` 永远不刷新，TTL 对「只被 find 命中、没被 read」的
   * 记忆失效（`src/services/search.ts` 的注释已按 TTL 的第二读者改写）。
   *
   * 这条从容器起：默认 `weight`（0）→ `search.find` 命中 → 清扫 → 被命中的留下、
   * 没被命中的归档。它测的是用户可见结局，不是「`recordAccess` 被调用了」。
   */
  it('find 命中刷新 last_accessed_at（默认 weight=0）：被命中的不归档，没命中的归档', async () => {
    const started = await startContainer(
      ['memory:', '  ttl:', '    defaultDays: 30'].join('\n'),
    );
    container = started;

    const caught = Uri.parse(SCOPE).child('memories', 'preferences', 'caught.md');
    const cold = Uri.parse(SCOPE).child('memories', 'preferences', 'cold.md');
    await writeMemory(started, caught, '滑动窗口刷新访问时间。');
    await writeMemory(started, cold, '这条与查询无关。');
    await started.services.indexObserver.drain();

    // 两条都是 31 天前写入；窗口内只有「被检索命中」这一条活下来。
    started.db
      .prepare('UPDATE node SET updated_at = ? WHERE uri IN (?, ?)')
      .run(daysAgo(31), caught.toString(), cold.toString());

    const hits = await started.services.search.find('滑动窗口刷新', {
      scopes: [`${SCOPE}/memories`],
      subject: 'user:local',
      principals: AUTH_PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toEqual([caught.toString()]);

    // `recordAccess` 是 fire-and-forget：等一个宏任务再清扫，不依赖实现细节。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const access = started.db
      .prepare('SELECT last_accessed_at FROM node WHERE uri = ?')
      .get(caught.toString());
    expect(access?.['last_accessed_at']).not.toBeNull();

    await expect(started.scheduler.tick()).resolves.toMatchObject({ ttlArchived: 1 });

    const statusOf = (uri: Uri): string =>
      String(started.db.prepare('SELECT status FROM node WHERE uri = ?').get(uri.toString())?.['status']);
    expect(statusOf(caught)).toBe('active');
    expect(statusOf(cold)).toBe('archived');
  });

  /**
   * `memory.ttl.retentionDays` 默认 0（永不物理删除）。此前只有
   * `tests/integration/services/ttl.test.ts` 直接 `new TtlService(...)` 传参测得第二段，
   * 没有任何测试证明「配置里的 retentionDays 会经容器传到清扫里」——传丢了不会报错，
   * 只会让磁盘永远不会被回收。
   */
  it('retentionDays 到期后物理删除：索引行与文件一起消失', async () => {
    const started = await startContainer(
      ['memory:', '  ttl:', '    defaultDays: 1', '    retentionDays: 1'].join('\n'),
    );
    container = started;
    expect(started.scheduler.started).toBe(true);

    const stale = Uri.parse(SCOPE).child('memories', 'preferences', 'stale.md');
    await writeMemory(started, stale, '很久没被使用的偏好。');
    await started.services.indexObserver.drain();

    // 第一段：两天的写入时间越过 1 天窗口 → 只软归档，文件还在。
    started.db
      .prepare('UPDATE node SET updated_at = ? WHERE uri = ?')
      .run(daysAgo(2), stale.toString());
    await expect(started.scheduler.tick()).resolves.toMatchObject({
      ttlArchived: 1,
      ttlPurged: 0,
    });
    await expect(started.services.filesystem.read(stale, AUTH_PRINCIPALS)).resolves.toBeDefined();

    // 第二段：归档时刻也往前拨两天，越过 1 天保留期 → 物理删除。
    started.db
      .prepare('UPDATE node SET archived_at = ? WHERE uri = ?')
      .run(daysAgo(2), stale.toString());
    await expect(started.scheduler.tick()).resolves.toMatchObject({
      ttlArchived: 0,
      ttlPurged: 1,
    });

    expect(
      started.db.prepare('SELECT uri FROM node WHERE uri = ?').get(stale.toString()),
    ).toBeUndefined();
    // 用户可见的结局：检索面再也列不出这条记忆（索引行已随文件删除）。
    const remaining = await started.services.search.glob('**/*.md', {
      scopes: [`${SCOPE}/memories`],
      subject: 'user:local',
      principals: AUTH_PRINCIPALS,
    });
    expect(remaining.map((uri) => uri.toString())).not.toContain(stale.toString());
  });

  /**
   * 第二段是**独立**开关：`defaultDays: 0` + `retentionDays: 30` 是「不再新增归档、
   * 只回收已有归档」的合法配法，`TtlService` 一直支持（ttl.test 的「第一段关着
   * （ttlDays=0）时第二段照常清理已归档的行」）。但 `schedulerEnabled` 曾经只看第一段
   * 与自动提交/过期，这种配置会被当成「全关」，调度器根本不起——物理删除永不发生。
   *
   * 造数据不经过第一段：直接写索引行成「已归档、归档时刻在保留期之外」。这样断言只
   * 依赖 `retentionDays`。`autoCommit` 关、`expiry = 0`，调度器能启动的唯一原因就是
   * `retentionDays > 0`。
   */
  it('只配 retentionDays（defaultDays=0）时调度器也启动，并物理删除已归档超期记忆', async () => {
    const started = await startContainer(
      [
        'session:',
        '  autoCommit:',
        '    enabled: false',
        'memory:',
        '  ttl:',
        '    defaultDays: 0',
        '    retentionDays: 1',
      ].join('\n'),
    );
    container = started;

    expect(started.config.memory.ttl.defaultDays).toBe(0);
    expect(started.config.memory.ttl.retentionDays).toBe(1);
    // 唯一能让调度器起来的原因：retentionDays > 0。
    expect(started.scheduler.started).toBe(true);

    const archived = Uri.parse(SCOPE).child('memories', 'preferences', 'archived.md');
    await writeMemory(started, archived, '归档满一天，应当被回收。');
    await started.services.indexObserver.drain();

    // 直接造「已归档且 archived_at 在保留期之外」，不依赖第一段。
    started.db
      .prepare("UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?")
      .run(daysAgo(2), archived.toString());

    await expect(started.scheduler.tick()).resolves.toMatchObject({
      ttlArchived: 0,
      ttlPurged: 1,
    });

    // 索引行没了。
    expect(
      started.db.prepare('SELECT uri FROM node WHERE uri = ?').get(archived.toString()),
    ).toBeUndefined();
    // 文件也没了：用户看到的是磁盘上的记忆真的被回收。
    await expect(
      stat(join(dataDir, 'user', 'local', 'memories', 'preferences', 'archived.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // 检索面同样列不出来。
    const remaining = await started.services.search.glob('**/*.md', {
      scopes: [`${SCOPE}/memories`],
      subject: 'user:local',
      principals: AUTH_PRINCIPALS,
    });
    expect(remaining.map((uri) => uri.toString())).not.toContain(archived.toString());
  });
});

describe('配置全关', () => {
  const ALL_OFF_YAML = [
    'session:',
    '  autoCommit:',
    '    enabled: false',
    '  expiry:',
    '    idleTimeoutSeconds: 0',
    'memory:',
    '  ttl:',
    '    defaultDays: 0',
  ].join('\n');

  it('自动提交、会话过期、记忆 TTL 全关时不起定时器', async () => {
    const started = await startContainer(ALL_OFF_YAML);
    container = started;

    expect(started.scheduler.started).toBe(false);
    // 关掉定时器不等于「调度器没了」：手动 tick 仍然可用（测试与脚本要确定点）。
    await expect(started.scheduler.tick()).resolves.toMatchObject({ skipped: false, scanned: 0 });
  });

  it('调度器不启动时，启动清理仍是 request_log 的唯一保证', async () => {
    // 启动清理在 `createContainer` 内部执行，超期行只能在它之前写进同一个库。
    await mkdir(join(dataDir, '_meta'), { recursive: true });
    const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
    runMigrations(db);
    const noop = (): void => undefined;
    const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
    const requestLog = new RequestLogRepository({ db, logger: silentLogger });
    const now = Date.now();
    const row = (id: string, ageDays: number): RequestLogRow => ({
      id,
      requestId: `req_${id}`,
      method: 'GET',
      path: '/api/v1/health',
      statusCode: 200,
      durationMs: 1,
      phases: null,
      errorCode: null,
      subject: 'user:local',
      createdAt: new Date(now - ageDays * MILLISECONDS_PER_DAY).toISOString(),
    });
    requestLog.insert(row('stale', 8));
    requestLog.insert(row('fresh', 1));
    db.close();

    const started = await startContainer(ALL_OFF_YAML);
    container = started;
    expect(started.scheduler.started).toBe(false);

    // 只按天裁：默认 `retainRows` 是 10 万，两条规则都不会误删窗口内的行。
    expect(
      started.db
        .prepare('SELECT id FROM request_log ORDER BY id')
        .all()
        .map((item) => item['id']),
    ).toEqual(['fresh']);
  });
});
