import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { isArtifactName, isReservedName } from '../../../src/adapters/fs/path.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  ResourceService,
  type ReconcileEntry,
  type ResourceStorage,
  type StageUploadInput,
  type StagedUpload,
  type StagedUploadInfo,
} from '../../../src/services/resource.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const PARENT = 'comem://user/alice/resources';
const DOCS = `${PARENT}/docs`;
const SPEC = `${DOCS}/spec.md`;
const ATTACHMENT = `${DOCS}/.attachments/spec.pdf`;

let dataDir: string;
let db: DatabaseSync;
let store: ContentStore;
let locks: PathLockManager;
let index: SqliteFtsIndex;
let summary: SummaryService;
let storage: ResourceStorage;
let logger: RecordingLogger;
let service: ResourceService;

interface RecordingLogger extends Logger {
  readonly warnings: string[];
  readonly errors: string[];
}

function createLogger(): RecordingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: RecordingLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warnings.push(message);
    }),
    error: vi.fn((message: string) => {
      errors.push(message);
    }),
    child: () => logger,
    warnings,
    errors,
  };
  return logger;
}

/**
 * 真实临时目录版的 `ResourceStorage`。
 *
 * 生产实现由 bootstrap 注入（`services/` 不能 import `node:fs`）。这里用
 * `_meta/tmp/` 与 `_meta/reconcile.log` 落盘，断言的是真实文件。
 */
function createStorage(root: string): ResourceStorage {
  const metaDir = join(root, '_meta');
  const tempDir = join(metaDir, 'tmp');
  const bytesPath = (uploadId: string): string => join(tempDir, `${uploadId}.bin`);
  const infoPath = (uploadId: string): string => join(tempDir, `${uploadId}.json`);

  return {
    async stage(input: StageUploadInput): Promise<string> {
      await mkdir(tempDir, { recursive: true });
      const tempPath = bytesPath(input.uploadId);
      await writeFile(tempPath, input.bytes);
      const info: StagedUploadInfo = {
        uploadId: input.uploadId,
        fileName: input.fileName,
        size: input.bytes.byteLength,
        tempPath,
        stagedAtMs: input.stagedAtMs,
      };
      await writeFile(infoPath(input.uploadId), JSON.stringify(info), 'utf8');
      return tempPath;
    },

    async readStaged(uploadId: string): Promise<StagedUpload | null> {
      try {
        const info = JSON.parse(
          await readFile(infoPath(uploadId), 'utf8'),
        ) as StagedUploadInfo;
        const bytes = new Uint8Array(await readFile(bytesPath(uploadId)));
        return { info, bytes };
      } catch {
        return null;
      }
    },

    async listStaged(): Promise<readonly StagedUploadInfo[]> {
      let names: string[];
      try {
        names = await readdir(tempDir);
      } catch {
        return [];
      }
      const infos: StagedUploadInfo[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue;
        }
        try {
          infos.push(JSON.parse(await readFile(join(tempDir, name), 'utf8')) as StagedUploadInfo);
        } catch {
          // 损坏的元数据没有清理价值，跳过即可。
        }
      }
      return infos.sort((left, right) => left.stagedAtMs - right.stagedAtMs);
    },

    async removeStaged(uploadId: string): Promise<void> {
      await rm(bytesPath(uploadId), { force: true });
      await rm(infoPath(uploadId), { force: true });
    },

    async appendReconcile(entry: ReconcileEntry): Promise<void> {
      await mkdir(metaDir, { recursive: true });
      await appendFile(join(metaDir, 'reconcile.log'), `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}

function createService(options: { maxFileBytes?: number; maxFiles?: number } = {}): ResourceService {
  return new ResourceService({
    store,
    locks,
    index,
    summary,
    storage,
    logger,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-resource-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  store = new ContentStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 5, defaultTimeoutMs: 2000 });
  index = new SqliteFtsIndex({ db, logger });
  summary = new SummaryService({
    nodes: new NodeRepository({ db, logger }),
    index,
    metadata: new MetadataFileStore({ dataDir, logger }),
    store,
    db,
    generator: new RuleSummarizer(),
    logger,
    locks,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
  });
  storage = createStorage(dataDir);
  service = createService();
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function addFiles(
  files: readonly { readonly path: string; readonly content?: string; readonly summary?: string }[],
  options: { readonly uploadId?: string } = {},
): Promise<Awaited<ReturnType<ResourceService['addResource']>>> {
  return service.addResource({
    parentUri: Uri.parse(PARENT),
    files: files.map((file) => ({ ...file, uploadId: options.uploadId })),
    subject: 'user:alice',
    principals: ['user:alice'],
  });
}

describe('addResource', () => {
  it('单文件导入：落盘、索引有记录、摘要失效被调用', async () => {
    const markStale = vi.spyOn(summary, 'markStale');

    const result = await addFiles([{ path: 'docs/spec.md', content: '# 规格', summary: '规格说明' }]);

    expect(result.created.map((uri) => uri.toString())).toEqual([SPEC]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.tokens.indexed).toBe(1);

    const onDisk = await readFile(join(dataDir, 'user/alice/resources/docs/spec.md'), 'utf8');
    expect(onDisk).toContain('# 规格');
    expect(onDisk).toContain('summary: 规格说明');

    const stat = await index.stat(SPEC);
    expect(stat).not.toBeNull();
    expect(stat?.kind).toBe('document');
    expect(stat?.contextType).toBe('resource');
    expect(stat?.abstract).toBe('规格说明');
    expect(markStale).toHaveBeenCalledTimes(1);
  });

  it('100 文件批量：索引一次、writeText 100 次、摘要按唯一目录去重', async () => {
    const upsert = vi.spyOn(index, 'upsert');
    const writeText = vi.spyOn(store, 'writeText');
    const markStale = vi.spyOn(summary, 'markStale');

    const files = Array.from({ length: 100 }, (_, position) => ({
      path: `dir-${position % 10}/file-${position}.md`,
      content: `# 文件 ${position}`,
    }));

    const result = await addFiles(files);

    expect(result.created).toHaveLength(100);
    expect(result.tokens.indexed).toBe(100);
    // 批量写入只应该产生**一次**携带 100 条记录的索引事务。摘要重算会再写索引，
    // 那是另一笔独立开销，所以这里按「含 100 条的调用」而不是总调用次数断言——
    // 断言总次数会在摘要真的生效时误红。
    const batchCalls = upsert.mock.calls.filter((call) => call[0].length === 100);
    expect(batchCalls).toHaveLength(1);
    expect(writeText).toHaveBeenCalledTimes(100);
    expect(markStale).toHaveBeenCalledTimes(10);
  });

  it('100 个文件全在同一个目录时摘要只失效一次', async () => {
    const markStale = vi.spyOn(summary, 'markStale');

    const files = Array.from({ length: 100 }, (_, position) => ({
      path: `docs/file-${position}.md`,
      content: `# 文件 ${position}`,
    }));

    await addFiles(files);

    expect(markStale).toHaveBeenCalledTimes(1);
  });

  it('附件：uploadId 落盘到同级的 .attachments 并进索引', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const staged = await service.stageUpload(bytes, { fileName: 'spec.pdf' });

    const result = await service.addResource({
      parentUri: Uri.parse(PARENT),
      files: [{ path: 'docs/spec.md', uploadId: staged.uploadId, content: '# 规格' }],
      subject: 'user:alice',
      principals: ['user:alice'],
    });

    expect(result.attachments.map((uri) => uri.toString())).toEqual([ATTACHMENT]);
    expect(Array.from(await readFile(join(dataDir, 'user/alice/resources/docs/.attachments/spec.pdf')))).toEqual(
      Array.from(bytes),
    );

    const stat = await index.stat(ATTACHMENT);
    expect(stat).not.toBeNull();
    expect(stat?.contextType).toBe('resource');
  });

  it('同名附件加后缀，不覆盖已有附件', async () => {
    const first = await service.stageUpload(new Uint8Array([1]), { fileName: 'spec.pdf' });
    const second = await service.stageUpload(new Uint8Array([2]), { fileName: 'spec.pdf' });

    await service.addResource({
      parentUri: Uri.parse(PARENT),
      files: [{ path: 'docs/a.md', uploadId: first.uploadId, content: 'a' }],
      subject: 'user:alice',
      principals: ['user:alice'],
    });
    await service.addResource({
      parentUri: Uri.parse(PARENT),
      files: [{ path: 'docs/b.md', uploadId: second.uploadId, content: 'b' }],
      subject: 'user:alice',
      principals: ['user:alice'],
    });

    const attachments = await readdir(join(dataDir, 'user/alice/resources/docs/.attachments'));
    expect(attachments.sort()).toEqual(['spec-1.pdf', 'spec.pdf']);
    expect(Array.from(await readFile(join(dataDir, 'user/alice/resources/docs/.attachments/spec.pdf')))).toEqual([1]);
    expect(Array.from(await readFile(join(dataDir, 'user/alice/resources/docs/.attachments/spec-1.pdf')))).toEqual([2]);
  });

  it('不合法路径进 skipped 而不抛错', async () => {
    const result = await addFiles([
      { path: '../escape.md', content: 'x' },
      { path: '/absolute.md', content: 'x' },
      { path: 'docs/./dot.md', content: 'x' },
      { path: '.abstract.md', content: 'x' },
      { path: 'docs/ok.md', content: 'ok' },
    ]);

    expect(result.created.map((uri) => uri.toString())).toEqual([`${DOCS}/ok.md`]);
    expect(result.skipped.map((entry) => entry.path)).toEqual([
      '../escape.md',
      '/absolute.md',
      'docs/./dot.md',
      '.abstract.md',
    ]);
  });

  it('批次内重复 path 后者赢并记 warn', async () => {
    const result = await addFiles([
      { path: 'docs/spec.md', content: '旧内容' },
      { path: 'docs/spec.md', content: '新内容' },
    ]);

    expect(result.created).toHaveLength(1);
    expect(await readFile(join(dataDir, 'user/alice/resources/docs/spec.md'), 'utf8')).toBe(
      '新内容',
    );
    expect(logger.warnings).toContain('同一批次里出现重复路径，后者覆盖前者。');
  });

  it('maxFiles 超限抛 RESOURCE_EXHAUSTED，消息带实际数量与上限', async () => {
    const limited = createService({ maxFiles: 2 });

    await expect(
      limited.addResource({
        parentUri: Uri.parse(PARENT),
        files: [
          { path: 'a.md', content: 'a' },
          { path: 'b.md', content: 'b' },
          { path: 'c.md', content: 'c' },
        ],
        subject: 'user:alice',
        principals: ['user:alice'],
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED', message: expect.stringContaining('3') });
  });

  it('stageUpload 超过 maxFileBytes 抛 RESOURCE_EXHAUSTED', async () => {
    const limited = createService({ maxFileBytes: 4 });

    await expect(limited.stageUpload(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      message: expect.stringContaining('5'),
    });
  });

  it('sweepStaged 删除超时的临时文件，保留新的', async () => {
    const old = await storage.stage({
      uploadId: 'old',
      fileName: 'old.pdf',
      bytes: new Uint8Array([1]),
      stagedAtMs: Date.now() - 120_000,
    });
    const fresh = await service.stageUpload(new Uint8Array([2]), { fileName: 'fresh.pdf' });

    const removed = await service.sweepStaged(60);

    expect(removed).toBe(1);
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fresh.tempPath)).toBeInstanceOf(Buffer);
    expect(await storage.readStaged('old')).toBeNull();
    expect(await storage.readStaged(fresh.uploadId)).not.toBeNull();
  });

  it('部分失败：写失败进 skipped，其余成功，reconcile.log 有记录', async () => {
    // 目标位置先建一个目录：写文件会以 EISDIR 失败。
    await store.mkdir(Uri.parse(`${DOCS}/blocked.md`), { recursive: true });

    const result = await addFiles([
      { path: 'docs/ok.md', content: 'ok' },
      { path: 'docs/blocked.md', content: 'blocked' },
    ]);

    expect(result.created.map((uri) => uri.toString())).toEqual([`${DOCS}/ok.md`]);
    expect(result.skipped.map((entry) => entry.path)).toEqual(['docs/blocked.md']);

    const reconcile = await readFile(join(dataDir, '_meta/reconcile.log'), 'utf8');
    expect(reconcile).toContain('docs/blocked.md');
  });

  it('索引写失败不回滚文件，失败 URI 进 reconcile.log', async () => {
    vi.spyOn(index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    const result = await addFiles([
      { path: 'docs/a.md', content: 'a' },
      { path: 'docs/b.md', content: 'b' },
    ]);

    expect(result.created).toHaveLength(2);
    expect(result.tokens.indexed).toBe(0);
    expect(await readFile(join(dataDir, 'user/alice/resources/docs/a.md'), 'utf8')).toBe('a');
    expect(await readFile(join(dataDir, 'user/alice/resources/docs/b.md'), 'utf8')).toBe('b');

    const reconcile = await readFile(join(dataDir, '_meta/reconcile.log'), 'utf8');
    expect(reconcile).toContain('索引坏了');
    expect(reconcile).toContain(SPEC.replace('spec.md', 'a.md'));
    expect(reconcile).toContain(SPEC.replace('spec.md', 'b.md'));
  });
});

describe('uri 校验', () => {
  it('保留名作为普通路径段被拒绝', () => {
    expect(() => Uri.parse(PARENT).child('.acl.json')).toThrow(ComemError);
  });

  it('.attachments 是普通目录名，不是内部产物', () => {
    // §6.5 的附件目录带 `.` 前缀，但 path.ts 的判定只认固定保留名、锁文件后缀
    // 与临时文件前缀。这条断言把「能作为路径段」钉住。
    expect(isReservedName('.attachments')).toBe(false);
    expect(isArtifactName('.attachments')).toBe(false);
    expect(Uri.parse(PARENT).child('.attachments').toString()).toBe(`${PARENT}/.attachments`);
  });
});
