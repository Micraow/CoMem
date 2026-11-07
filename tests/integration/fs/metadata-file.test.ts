import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDocument } from '../../../src/adapters/fs/frontmatter.js';
import {
  ABSTRACT_FILE_NAME,
  MetadataFileStore,
  OVERVIEW_FILE_NAME,
} from '../../../src/adapters/fs/metadata-file.js';
import { TEMP_FILE_PREFIX, toDiskPath } from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';

let dataDir: string;
let store: MetadataFileStore;
let logger: Logger;

const DIRECTORY = Uri.parse('comem://user/alice/memories');
const GENERATION = {
  generatedBy: 'llm',
  generatedAt: '2026-11-08T00:00:00.000Z',
  degraded: false,
} as const;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-metadata-'));
  logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
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
    ).resolves.toEqual({ abstract: '', overview: '', complete: false });
  });

  it('目录存在但没有摘要文件时返回空摘要', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '',
      overview: '',
      complete: false,
    });
  });

  it('只有 L0 时 complete 为假', async () => {
    await mkdir(directoryPath(), { recursive: true });
    await writeFile(join(directoryPath(), ABSTRACT_FILE_NAME), '一句话摘要\n', 'utf8');

    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '一句话摘要\n',
      overview: '',
      complete: false,
    });
  });

  it('两个文件都在时 complete 为真，正文不带 frontmatter', async () => {
    await store.writeSummary(DIRECTORY, '一句话摘要', '完整概览', GENERATION);

    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '一句话摘要',
      overview: '完整概览',
      complete: true,
    });
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
    expect(content).toEqual({ abstract: '', overview: '', complete: true });
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

describe('removeSummary', () => {
  it('只删摘要文件，不动目录里的内容', async () => {
    await store.writeSummary(DIRECTORY, 'L0', 'L1');
    await writeFile(join(directoryPath(), 'note.md'), '内容\n', 'utf8');

    await store.removeSummary(DIRECTORY);

    expect(await readdir(directoryPath())).toEqual(['note.md']);
    await expect(store.readSummary(DIRECTORY)).resolves.toEqual({
      abstract: '',
      overview: '',
      complete: false,
    });
  });

  it('摘要不存在时是空操作', async () => {
    await expect(store.removeSummary(DIRECTORY)).resolves.toBeUndefined();
  });

  it('可以重复调用', async () => {
    await store.writeSummary(DIRECTORY, 'L0', 'L1');
    await store.removeSummary(DIRECTORY);

    await expect(store.removeSummary(DIRECTORY)).resolves.toBeUndefined();
  });
});
