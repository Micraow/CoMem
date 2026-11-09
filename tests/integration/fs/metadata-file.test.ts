import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDocument } from '../../../src/adapters/fs/frontmatter.js';
import {
  ABSTRACT_FILE_NAME,
  META_FILE_NAME,
  MetadataFileStore,
  OVERVIEW_FILE_NAME,
} from '../../../src/adapters/fs/metadata-file.js';
import { TEMP_FILE_PREFIX, toDiskPath } from '../../../src/adapters/fs/path.js';
import type { ArchiveMeta } from '../../../src/domain/archive.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { SessionMeta } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';

let dataDir: string;
let store: MetadataFileStore;
let logger: Logger;

const DIRECTORY = Uri.parse('comem://user/alice/memories');
const SESSION_URI = Uri.parse('comem://user/alice/sessions/sess_7f3a91c2');
const ARCHIVE_URI = Uri.parse('comem://user/alice/sessions/sess_7f3a91c2/history/archive_001');
const GENERATION = {
  generatedBy: 'llm',
  generatedAt: '2026-11-08T00:00:00.000Z',
  degraded: false,
} as const;

const SESSION_META: SessionMeta = {
  sessionId: 'sess_7f3a91c2',
  userId: 'alice',
  status: 'open',
  createdAt: '2026-11-08T00:00:00.000Z',
  commitCount: 0,
  lastCommitAt: null,
  pendingTokens: 0,
};

const ARCHIVE_META: ArchiveMeta = {
  archiveId: 'archive_001',
  phase1: {
    status: 'ready',
    messagesSha256: 'a'.repeat(64),
    archivedMessageIds: ['m1', 'm2'],
    retainedMessageIds: [],
  },
  stepsDone: ['archive_summary'],
  skippedSteps: [],
  taskId: 'task-1',
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-metadata-'));
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  store = new MetadataFileStore({ dataDir, logger });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function directoryPath(target: Uri = DIRECTORY): string {
  return toDiskPath(dataDir, target);
}

async function readRaw(name: string, target: Uri = DIRECTORY): Promise<string> {
  return readFile(join(directoryPath(target), name), 'utf8');
}

describe('readSummary', () => {
  it('目录不存在时返回空摘要，不抛错', async () => {
    await expect(
      store.readSummary(Uri.parse('comem://user/alice/never-created')),
    ).resolves.toEqual({ abstract: '', overview: '', complete: false, generation: null });
  });

  it('目录存在但没有摘要文件时返回空摘要', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '',
      overview: '',
      complete: false,
      generation: null,
    });
  });

  it('只有 L0 时 complete 为假', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await writeFile(join(directoryPath(), ABSTRACT_FILE_NAME), '一句话摘要\n', 'utf8');

    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '一句话摘要\n',
      overview: '',
      complete: false,
      generation: null,
    });
  });

  it('两个文件都在时 complete 为真，正文不带 frontmatter', async () => {
    await store.writeSummary(DIRECTORY, '一句话摘要', '完整概览', GENERATION);

    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '一句话摘要',
      overview: '完整概览',
      complete: true,
      generation: GENERATION,
    });
  });

  it('手工写的摘要没有 frontmatter 时 generation 为 null', async () => {
    // 手工编辑的 .overview.md 没有生成信息。返回 null 表示「来源未知」，
    // 不要编造 generatedBy: 'llm'——那会让监控页把手工内容算成模型产出。
    await mkdir(directoryPath(), { recursive: true });
    await writeFile(join(directoryPath(), '.overview.md'), '手工概览\n', 'utf8');

    const content = await store.readSummary(DIRECTORY);
    expect(content.overview).toBe('手工概览\n');
    expect(content.generation).toBeNull();
  });

  it('写入的临时文件不会被当成摘要读出来', async () => {
    await mkdir(directoryPath(), { recursive: true });
    // 模拟一个「写到一半」的临时文件：内容是不完整的 frontmatter。
    await writeFile(
      join(directoryPath(), `${TEMP_FILE_PREFIX}abc-12345678`),
      '---\ngenerated_by: ll',
      'utf8',
    );

    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '',
      overview: '',
      complete: false,
      generation: null,
    });
  });

  it('摘要是目录时抛 INVALID_ARGUMENT', async () => {
    await mkdir(join(directoryPath(), ABSTRACT_FILE_NAME), { recursive: true });

    let caught: unknown;
    try {
      await store.readSummary(DIRECTORY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('INVALID_ARGUMENT');
  });
});

describe('writeSummary', () => {
  it('父目录不存在时自动创建', async () => {
    const nested = Uri.parse('comem://user/alice/projects/comem/memories');
    await store.writeSummary(nested, 'L0', 'L1');

    await expect(store.readSummary(nested)).resolves.toEqual({
      abstract: 'L0',
      overview: 'L1',
      complete: true,
      generation: null,
    });
  });

  it('往返稳定：写完再读正文逐字节相同', async () => {
    const abstract = '一句话摘要，含 `代码` 与 emoji 😀。';
    const overview = '# 标题\n\n正文第一段。\n\n## 子标题\n\n正文第二段。\n';
    await store.writeSummary(DIRECTORY, abstract, overview);

    const content = await store.readSummary(DIRECTORY);
    expect(content.abstract).toBe(abstract);
    expect(content.overview).toBe(overview);
  });

  it('带生成信息时写入 frontmatter', async () => {
    await store.writeSummary(DIRECTORY, 'L0', 'L1', GENERATION);

    const document = parseDocument(await readRaw(ABSTRACT_FILE_NAME));
    expect(document.hasFrontmatter).toBe(true);
    expect(document.data).toEqual({
      generated_by: 'llm',
      generated_at: '2026-11-08T00:00:00.000Z',
      degraded: false,
    });
    expect(document.body).toBe('L0');
  });

  it('degraded 为真时落盘，供「摘要降级」标记使用', async () => {
    await store.writeSummary(DIRECTORY, 'L0', 'L1', { generatedBy: 'rule', degraded: true });

    const document = parseDocument(await readRaw(OVERVIEW_FILE_NAME));
    expect(document.data['generated_by']).toBe('rule');
    expect(document.data['degraded']).toBe(true);
    // 没给 generated_at 时不写这个键。
    expect(document.data).not.toHaveProperty('generated_at');
  });

  it('不传生成信息时保留磁盘上已有的其它 frontmatter 键', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await writeFile(
      join(directoryPath(), ABSTRACT_FILE_NAME),
      '---\nfreshness: 3\nowner: alice\n---\n\n旧摘要\n',
      'utf8',
    );

    await store.writeSummary(DIRECTORY, '新摘要', 'L1');

    const document = parseDocument(await readRaw(ABSTRACT_FILE_NAME));
    expect(document.body).toBe('新摘要');
    expect(document.data).toEqual({ freshness: 3, owner: 'alice' });
    expect(document.hasFrontmatter).toBe(true);
  });

  it('传生成信息时只覆盖生成字段，其它键保留', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await writeFile(
      join(directoryPath(), ABSTRACT_FILE_NAME),
      '---\nfreshness: 3\ngenerated_by: rule\n---\n\n旧摘要\n',
      'utf8',
    );

    await store.writeSummary(DIRECTORY, '新摘要', 'L1', GENERATION);

    const document = parseDocument(await readRaw(ABSTRACT_FILE_NAME));
    expect(document.data).toEqual({
      freshness: 3,
      generated_by: 'llm',
      generated_at: '2026-11-08T00:00:00.000Z',
      degraded: false,
    });
  });

  it('写完之后目录里没有临时文件残留', async () => {
    await store.writeSummary(DIRECTORY, 'L0', 'L1', GENERATION);

    const names = await readdir(directoryPath());
    expect(names.filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
  });

  it('并发写不会互相踩踏，最终是两个文件之一', async () => {
    await Promise.all([
      store.writeSummary(DIRECTORY, 'L0-第一份', 'L1-第一份'),
      store.writeSummary(DIRECTORY, 'L0-第二份', 'L1-第二份'),
    ]);

    const content = await store.readSummary(DIRECTORY);
    expect(content.complete).toBe(true);
    expect(['L0-第一份', 'L0-第二份']).toContain(content.abstract);
    expect(['L1-第一份', 'L1-第二份']).toContain(content.overview);
    expect((await readdir(directoryPath())).filter((n) => n.startsWith(TEMP_FILE_PREFIX))).toEqual(
      [],
    );
  });

  it('空正文也能写（摘要还没生成完的状态）', async () => {
    await store.writeSummary(DIRECTORY, '', '', GENERATION);

    const content = await store.readSummary(DIRECTORY);
    expect(content).toEqual({ abstract: '', overview: '', complete: true, generation: GENERATION });
  });

  it('目标目录被同名文件占住时抛 ALREADY_EXISTS', async () => {
    await mkdir(join(dataDir, 'user', 'alice'), { recursive: true });
    await writeFile(directoryPath(), 'not a directory', 'utf8');

    let caught: unknown;
    try {
      await store.writeSummary(DIRECTORY, 'L0', 'L1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('ALREADY_EXISTS');
  });
});

/** 直接把一段文本写进目标目录的 `.meta.json`，模拟「磁盘上的文件被改坏」。 */
async function writeRawMeta(target: Uri, content: string): Promise<void> {
  const directory = directoryPath(target);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, META_FILE_NAME), content, 'utf8');
}

/**
 * `.meta.json` 只由本模块写；内容不合法是程序缺陷，必须报 `INTERNAL` 而不是
 * `INVALID_ARGUMENT`（后者会让调用方以为该去改请求），并且消息里要带上是哪一份。
 */
async function expectCorruptMeta(run: () => Promise<unknown>, target: Uri): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  expect((caught as ComemError).code).toBe('INTERNAL');
  expect((caught as ComemError).message).toContain(target.toString());
}

describe('.meta.json 读写', () => {
  it('会话元数据往返：写完原样读回', async () => {
    const meta: SessionMeta = {
      ...SESSION_META,
      status: 'archived',
      commitCount: 3,
      lastCommitAt: '2026-11-08T01:00:00.000Z',
      pendingTokens: 42,
    };

    await store.writeSession(SESSION_URI, meta);

    await expect(store.readSession(SESSION_URI)).resolves.toEqual(meta);
  });

  it('归档元数据往返：stepsDone 的顺序原样保留', async () => {
    const meta: ArchiveMeta = {
      ...ARCHIVE_META,
      stepsDone: ['archive_summary', 'memory_extract', 'memory_merge'],
    };

    await store.writeArchive(ARCHIVE_URI, meta);

    await expect(store.readArchive(ARCHIVE_URI)).resolves.toEqual(meta);
  });

  it('不存在时返回 null（不是抛错）', async () => {
    await expect(store.readSession(SESSION_URI)).resolves.toBeNull();
    await expect(store.readArchive(ARCHIVE_URI)).resolves.toBeNull();
  });

  it('父目录不存在时自动创建', async () => {
    await store.writeSession(SESSION_URI, SESSION_META);

    await expect(store.readSession(SESSION_URI)).resolves.toEqual(SESSION_META);
  });

  it('键顺序固定、2 空格缩进、末尾换行', async () => {
    await store.writeSession(SESSION_URI, SESSION_META);

    const raw = await readFile(join(directoryPath(SESSION_URI), META_FILE_NAME), 'utf8');
    // 键顺序随实现漂移会让每次提交都产生 diff 噪声，与 `.acl.json` 一致。
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([
      'sessionId',
      'userId',
      'status',
      'createdAt',
      'commitCount',
      'lastCommitAt',
      'pendingTokens',
    ]);
    expect(raw).toContain('\n  "sessionId": "sess_7f3a91c2"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('写完之后目录里没有临时文件残留', async () => {
    await store.writeSession(SESSION_URI, SESSION_META);

    const names = await readdir(directoryPath(SESSION_URI));
    expect(names.filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
  });

  it('并发写不会互相踩踏，最终是两份之一', async () => {
    await Promise.all([
      store.writeSession(SESSION_URI, { ...SESSION_META, commitCount: 1 }),
      store.writeSession(SESSION_URI, { ...SESSION_META, commitCount: 2 }),
    ]);

    const meta = await store.readSession(SESSION_URI);
    expect([1, 2]).toContain(meta?.commitCount);
    expect(
      (await readdir(directoryPath(SESSION_URI))).filter((name) =>
        name.startsWith(TEMP_FILE_PREFIX),
      ),
    ).toEqual([]);
  });

  it('内容不是合法 JSON 时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, '{"sessionId": ');

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('顶层不是对象时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, '[]');

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('sessionId 不是字符串时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, sessionId: 42 }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('status 不是合法会话状态时抛 INTERNAL', async () => {
    // `archived` 是合法状态（空闲过期的终态），拿它当反例会让这条测试在实现补上
    // 归档之后通过——测的就不再是「非法状态被拒绝」。
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, status: 'deleted' }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('archived 是合法状态：归档后的会话能原样读回', async () => {
    const meta: SessionMeta = { ...SESSION_META, status: 'archived' };

    await store.writeSession(SESSION_URI, meta);

    await expect(store.readSession(SESSION_URI)).resolves.toEqual(meta);
  });

  it('createdAt 不是字符串时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, createdAt: null }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('commitCount 是字符串时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, commitCount: '0' }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('commitCount 是负数 / 小数时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, commitCount: 1.5 }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('lastCommitAt 既不是字符串也不是 null 时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, lastCommitAt: 0 }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('pendingTokens 不是数字时抛 INTERNAL', async () => {
    await writeRawMeta(SESSION_URI, JSON.stringify({ ...SESSION_META, pendingTokens: '0' }));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });

  it('归档顶层不是对象时抛 INTERNAL', async () => {
    await writeRawMeta(ARCHIVE_URI, '"archive_001"');

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('archiveId 不是字符串时抛 INTERNAL', async () => {
    await writeRawMeta(ARCHIVE_URI, JSON.stringify({ ...ARCHIVE_META, archiveId: 1 }));

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('stepsDone 含非法步骤名时抛 INTERNAL', async () => {
    // 步骤名拼错会让某一步被静默重放，记忆操作不幂等，所以必须在读的时候挡住。
    await writeRawMeta(ARCHIVE_URI, JSON.stringify({ ...ARCHIVE_META, stepsDone: ['summarize'] }));

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('stepsDone 不是数组时抛 INTERNAL', async () => {
    await writeRawMeta(ARCHIVE_URI, JSON.stringify({ ...ARCHIVE_META, stepsDone: 'archive_summary' }));

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('taskId 既不是字符串也不是 null 时抛 INTERNAL', async () => {
    await writeRawMeta(ARCHIVE_URI, JSON.stringify({ ...ARCHIVE_META, taskId: 7 }));

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('phase1 不是对象时抛 INTERNAL', async () => {
    await writeRawMeta(ARCHIVE_URI, JSON.stringify({ ...ARCHIVE_META, phase1: 'ready' }));

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('phase1.status 不是 preparing | ready 时抛 INTERNAL', async () => {
    await writeRawMeta(
      ARCHIVE_URI,
      JSON.stringify({ ...ARCHIVE_META, phase1: { ...ARCHIVE_META.phase1, status: 'done' } }),
    );

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('phase1.messagesSha256 不是字符串时抛 INTERNAL', async () => {
    await writeRawMeta(
      ARCHIVE_URI,
      JSON.stringify({ ...ARCHIVE_META, phase1: { ...ARCHIVE_META.phase1, messagesSha256: 0 } }),
    );

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('phase1 的消息 ID 不是字符串数组时抛 INTERNAL', async () => {
    await writeRawMeta(
      ARCHIVE_URI,
      JSON.stringify({
        ...ARCHIVE_META,
        phase1: { ...ARCHIVE_META.phase1, retainedMessageIds: [1] },
      }),
    );

    await expectCorruptMeta(() => store.readArchive(ARCHIVE_URI), ARCHIVE_URI);
  });

  it('字段齐全但少一个键时抛 INTERNAL（缺字段不能静默变成 undefined）', async () => {
    const withoutSessionId: Record<string, unknown> = { ...SESSION_META };
    delete withoutSessionId['sessionId'];
    await writeRawMeta(SESSION_URI, JSON.stringify(withoutSessionId));

    await expectCorruptMeta(() => store.readSession(SESSION_URI), SESSION_URI);
  });
});
