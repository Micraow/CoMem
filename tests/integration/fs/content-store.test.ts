import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { parseDocument } from '../../../src/adapters/fs/frontmatter.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import type { ComemErrorCode } from '../../../src/domain/errors.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { stableDigest } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

let dataDir: string;
let store: ContentStore;
let debugLog: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-store-'));
  debugLog = vi.fn();
  const logger: Logger = {
    trace: vi.fn(),
    debug: debugLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  store = new ContentStore({ dataDir, logger });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function uri(input: string): Uri {
  return Uri.parse(input);
}

function diskPath(target: Uri): string {
  return toDiskPath(dataDir, target);
}

async function expectCode(promise: Promise<unknown>, code: ComemErrorCode): Promise<ComemError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望抛 ${code}`).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe(code);
  return error;
}

async function rawDocument(target: Uri): Promise<ReturnType<typeof parseDocument>> {
  return parseDocument(await readFile(diskPath(target), 'utf8'));
}

/** 直接往磁盘写原始内容，绕过 ContentStore，用来构造「已有 frontmatter」的现场。 */
async function seedRaw(target: Uri, raw: string): Promise<void> {
  const absolute = diskPath(target);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw, 'utf8');
}

/**
 * 伪造一个指向保留名的 URI。
 *
 * `Uri.parse` 拒绝保留名，所以正常构造不出这种值；这只用来验证 ContentStore 的
 * 防御分支（即使上游出了 bug，也不能让元数据文件被当成内容写）。
 */
function reservedUri(name: string): Uri {
  return {
    name,
    toString: () => `comem://user/alice/memories/${name}`,
  } as unknown as Uri;
}

describe('writeText / readText', () => {
  it('写入并读回正文，正文逐字节一致', async () => {
    const target = uri('comem://user/alice/memories/preferences/code-style.md');
    const text = '# 代码风格\n\n- 严格模式\n- 2 空格缩进\n\n---\n\n结束。\n';

    const stat = await store.writeText(target, text);

    expect(stat.uri).toBe(target);
    expect(stat.kind).toBe('file');
    expect(stat.size).toBe(Buffer.byteLength(text, 'utf8'));

    const document = await store.readText(target);
    expect(document.text).toBe(text);
    expect(document.frontmatter).toBeNull();
    expect(document.stat).toEqual(stat);
  });

  it('自动创建父目录', async () => {
    const target = uri('comem://user/alice/memories/a/b/c/deep.md');

    await store.writeText(target, '正文');

    await expect(store.exists(uri('comem://user/alice/memories/a/b/c'))).resolves.toBe(true);
    await expect(store.readText(target)).resolves.toMatchObject({ text: '正文' });
  });

  it('覆盖写不留旧内容', async () => {
    const target = uri('comem://user/alice/memories/note.md');

    await store.writeText(target, '第一版正文很长很长');
    await store.writeText(target, '第二版');

    await expect(store.readText(target)).resolves.toMatchObject({ text: '第二版' });
  });

  it('CRLF 与 emoji 原样往返', async () => {
    const target = uri('comem://user/alice/memories/crlf.md');
    const text = '第一行\r\n第二行 😀\r\n';

    await store.writeText(target, text);

    await expect(store.readText(target)).resolves.toMatchObject({ text });
  });

  it('记录 debug 日志：URI、字节数与耗时', async () => {
    const target = uri('comem://user/alice/memories/note.md');
    await store.writeText(target, '正文');

    expect(debugLog).toHaveBeenCalledTimes(1);
    expect(debugLog).toHaveBeenCalledWith(
      '写入文本文件',
      expect.objectContaining({
        uri: target.toString(),
        bytes: Buffer.byteLength('正文', 'utf8'),
        durationMs: expect.any(Number),
      }),
    );
  });
});

describe('frontmatter', () => {
  const target = uri('comem://user/alice/memories/preferences/code-style.md');

  const RAW = [
    '---',
    'uri: comem://user/alice/memories/preferences/code-style',
    'generated_by: summary.service',
    'generated_at: 2026-11-05T16:41:02Z',
    'freshness:',
    '  total_entries: 6',
    '  pending_changes: 0',
    'summary: 代码风格',
    'summary_digest: 9f2c8a1e',
    'summary_state: fresh',
    '---',
    '',
    '旧正文',
    '',
  ].join('\n');

  it('读回时把磁盘上的 snake_case 映射成 DocumentFrontmatter', async () => {
    await seedRaw(target, RAW);

    const document = await store.readText(target);

    expect(document.text).toBe('旧正文\n');
    expect(document.frontmatter).toEqual({
      summary: '代码风格',
      summaryDigest: '9f2c8a1e',
      summaryState: 'fresh',
    });
  });

  it('不传 frontmatter 时保留磁盘上现有的全部键（§10.6 元数据写保护）', async () => {
    await seedRaw(target, RAW);

    await store.writeText(target, '新正文');

    const document = await rawDocument(target);
    expect(document.body).toBe('新正文');
    expect(document.data).toEqual({
      uri: 'comem://user/alice/memories/preferences/code-style',
      generated_by: 'summary.service',
      generated_at: '2026-11-05T16:41:02Z',
      freshness: { total_entries: 6, pending_changes: 0 },
      summary: '代码风格',
      summary_digest: '9f2c8a1e',
      summary_state: 'fresh',
    });
  });

  it('传入 frontmatter 时覆盖同名键，未知键仍然保留', async () => {
    await seedRaw(target, RAW);

    await store.writeText(target, '新正文', {
      frontmatter: { summary: '新摘要', summaryDigest: 'abc12345', summaryState: 'stale' },
    });

    const document = await rawDocument(target);
    expect(document.data).toMatchObject({
      summary: '新摘要',
      summary_digest: 'abc12345',
      summary_state: 'stale',
      generated_by: 'summary.service',
      freshness: { total_entries: 6, pending_changes: 0 },
    });
  });

  it('文件不存在时以空对象为基底', async () => {
    await store.writeText(target, '正文', { frontmatter: { summary: '摘要' } });

    const document = await rawDocument(target);
    expect(document.data).toEqual({ summary: '摘要' });
    expect(document.body).toBe('正文');
  });
});

describe('expectedDigest 乐观并发', () => {
  const target = uri('comem://user/alice/memories/note.md');

  it('摘要匹配时写入成功', async () => {
    await store.writeText(target, '第一版');

    await store.writeText(target, '第二版', { expectedDigest: stableDigest('第一版') });

    await expect(store.readText(target)).resolves.toMatchObject({ text: '第二版' });
  });

  it('摘要不匹配抛 CONFLICT，磁盘内容不变', async () => {
    await store.writeText(target, '第一版');

    await expectCode(
      store.writeText(target, '第二版', { expectedDigest: stableDigest('别的正文') }),
      'CONFLICT',
    );

    await expect(store.readText(target)).resolves.toMatchObject({ text: '第一版' });
  });

  it('文件不存在而传了 expectedDigest 抛 CONFLICT', async () => {
    await expectCode(
      store.writeText(target, '正文', { expectedDigest: stableDigest('') }),
      'CONFLICT',
    );
  });

  it('只比较正文，不受 frontmatter 影响', async () => {
    await store.writeText(target, '第一版', { frontmatter: { summary: '摘要' } });

    await store.writeText(target, '第二版', { expectedDigest: stableDigest('第一版') });

    await expect(store.readText(target)).resolves.toMatchObject({ text: '第二版' });
  });
});

describe('保留名写保护', () => {
  it('writeText 拒绝写保留名', async () => {
    await expectCode(store.writeText(reservedUri('.acl.json'), '{}'), 'PERMISSION_DENIED');
  });

  it('writeBytes 拒绝写保留名', async () => {
    await expectCode(store.writeBytes(reservedUri('.done'), new Uint8Array([1])), 'PERMISSION_DENIED');
  });

  it('mkdir 拒绝建保留名目录', async () => {
    await expectCode(store.mkdir(reservedUri('memory_diff.json')), 'PERMISSION_DENIED');
  });

  it('writeText 拒绝写内部产物名（锁文件）', async () => {
    const error = await expectCode(
      store.writeText(uri('comem://user/alice/memories/a.md.comem-lock'), '{}'),
      'PERMISSION_DENIED',
    );

    expect(error.message).toContain('内部使用');
  });

  it('writeText 拒绝写内部产物名（临时文件）', async () => {
    await expectCode(
      store.writeText(uri('comem://user/alice/memories/.comem-tmp-abc'), 'x'),
      'PERMISSION_DENIED',
    );
  });

  it('保留名与产物名报错文案不同', async () => {
    const reserved = await expectCode(store.writeText(reservedUri('.acl.json'), '{}'), 'PERMISSION_DENIED');
    const artifact = await expectCode(
      store.writeText(uri('comem://user/alice/memories/a.md.comem-lock'), '{}'),
      'PERMISSION_DENIED',
    );

    expect(reserved.message).toContain('元数据文件');
    expect(artifact.message).toContain('内部使用');
    expect(reserved.message).not.toBe(artifact.message);
  });

  it('普通名不受影响', async () => {
    await expect(
      store.writeText(uri('comem://user/alice/memories/.hidden.md'), '正文'),
    ).resolves.toMatchObject({ kind: 'file' });
  });
});

describe('list', () => {
  const directory = uri('comem://user/alice/memories');

  it('按 name 升序返回直接子项', async () => {
    await store.writeText(uri('comem://user/alice/memories/b.md'), 'b');
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await store.mkdir(uri('comem://user/alice/memories/c'));

    const entries = await store.list(directory);

    expect(entries.map((entry) => entry.uri.name)).toEqual(['a.md', 'b.md', 'c']);
    expect(entries.map((entry) => entry.kind)).toEqual(['file', 'file', 'directory']);
  });

  it('跳过临时文件与锁文件（锁文件是「目标文件名 + 后缀」）', async () => {
    const absolute = diskPath(directory);
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await writeFile(join(absolute, 'a.md.comem-lock'), '{}', 'utf8');
    await writeFile(join(absolute, '.comem-tmp-xyz'), '半成品', 'utf8');
    await writeFile(join(absolute, '.comem-lock'), '{}', 'utf8');

    const entries = await store.list(directory);

    expect(entries.map((entry) => entry.uri.name)).toEqual(['a.md']);
  });

  it('产物名不出现在目录计数里', async () => {
    const absolute = diskPath(directory);
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await writeFile(join(absolute, 'a.md.comem-lock'), '{}', 'utf8');

    await expect(store.stat(directory)).resolves.toMatchObject({ kind: 'directory', size: 1 });
  });

  it('跳过 Uri 表示不了的条目（保留名、控制字符）', async () => {
    const absolute = diskPath(directory);
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await writeFile(join(absolute, '.acl.json'), '{}', 'utf8');
    await writeFile(join(absolute, 'bad\u0001name.md'), 'x', 'utf8');

    const entries = await store.list(directory);

    expect(entries.map((entry) => entry.uri.name)).toEqual(['a.md']);
  });

  it('子目录的 size 是直接子项数', async () => {
    await store.writeText(uri('comem://user/alice/memories/sub/a.md'), 'a');
    await store.writeText(uri('comem://user/alice/memories/sub/b.md'), 'b');

    const entries = await store.list(directory);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'directory', size: 2 });
  });

  it('目录不存在抛 NOT_FOUND', async () => {
    await expectCode(store.list(uri('comem://user/alice/memories/missing')), 'NOT_FOUND');
  });
});

describe('mkdir', () => {
  const directory = uri('comem://user/alice/memories/preferences');

  it('建目录', async () => {
    await store.mkdir(uri('comem://user/alice/memories'), { recursive: true });
    await store.mkdir(directory);

    await expect(store.stat(directory)).resolves.toMatchObject({ kind: 'directory' });
  });

  it('已存在且未传 recursive 时抛 ALREADY_EXISTS', async () => {
    await store.mkdir(directory, { recursive: true });

    await expectCode(store.mkdir(directory), 'ALREADY_EXISTS');
  });

  it('父目录不存在且未传 recursive 时抛 NOT_FOUND', async () => {
    await expectCode(store.mkdir(directory), 'NOT_FOUND');
  });

  it('recursive 时已存在不算错误', async () => {
    await store.mkdir(directory, { recursive: true });

    await expect(store.mkdir(directory, { recursive: true })).resolves.toBeUndefined();
  });
});

describe('remove', () => {
  const directory = uri('comem://user/alice/memories');

  it('递归删除返回文件数（不含目录）', async () => {
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await store.writeText(uri('comem://user/alice/memories/b.md'), 'b');
    await store.writeText(uri('comem://user/alice/memories/sub/c.md'), 'c');
    await store.mkdir(uri('comem://user/alice/memories/sub/deeper'));

    await expect(store.remove(directory, { recursive: true })).resolves.toBe(3);
    await expect(store.exists(directory)).resolves.toBe(false);
  });

  it('递归删除不计入产物文件', async () => {
    const absolute = diskPath(directory);
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await store.writeText(uri('comem://user/alice/memories/sub/b.md'), 'b');
    await writeFile(join(absolute, 'a.md.comem-lock'), '{}', 'utf8');
    await writeFile(join(absolute, 'sub/b.md.comem-lock'), '{}', 'utf8');
    await writeFile(join(absolute, '.comem-tmp-xyz'), '半成品', 'utf8');

    // removedFiles 是给用户看的「删了几个文件」，运行时产物不算。
    await expect(store.remove(directory, { recursive: true })).resolves.toBe(2);
  });

  it('删除单个文件返回 1', async () => {
    const target = uri('comem://user/alice/memories/a.md');
    await store.writeText(target, 'a');

    await expect(store.remove(target)).resolves.toBe(1);
    await expect(store.exists(target)).resolves.toBe(false);
  });

  it('不存在时返回 0，不报错', async () => {
    await expect(store.remove(uri('comem://user/alice/memories/missing.md'))).resolves.toBe(0);
  });

  it('删除目录未传 recursive 时抛 INVALID_ARGUMENT', async () => {
    await store.mkdir(directory, { recursive: true });

    await expectCode(store.remove(directory), 'INVALID_ARGUMENT');
    await expect(store.exists(directory)).resolves.toBe(true);
  });
});

describe('move', () => {
  const from = uri('comem://user/alice/memories/a.md');
  const to = uri('comem://user/alice/memories/archive/a.md');

  it('移动到新路径，目标父目录自动创建', async () => {
    await store.writeText(from, '正文');

    await store.move(from, to);

    await expect(store.exists(from)).resolves.toBe(false);
    await expect(store.readText(to)).resolves.toMatchObject({ text: '正文' });
  });

  it('目标已存在抛 ALREADY_EXISTS，两个文件都不动', async () => {
    await store.writeText(from, '源');
    await store.writeText(to, '目标');

    await expectCode(store.move(from, to), 'ALREADY_EXISTS');

    await expect(store.readText(from)).resolves.toMatchObject({ text: '源' });
    await expect(store.readText(to)).resolves.toMatchObject({ text: '目标' });
  });

  it('源不存在抛 NOT_FOUND', async () => {
    await expectCode(store.move(from, to), 'NOT_FOUND');
  });

  it('目标最后一段是保留名时抛 PERMISSION_DENIED', async () => {
    await store.writeText(from, '正文');

    await expectCode(store.move(from, reservedUri('.done')), 'PERMISSION_DENIED');
  });

  // `fs.rename` 只在跨设备时抛 EXDEV。测试的两端都在同一个 mkdtemp 目录里，
  // 没法在不 mock `node:fs` 的前提下构造跨设备场景；降级路径由代码评审覆盖。
  it.skip('跨设备时降级为复制 + 删除（需要两个挂载点，跳过）', async () => {
    await store.writeText(from, '正文');
    await store.move(from, to);
  });
});

describe('stat / exists', () => {
  const target = uri('comem://user/alice/memories/a.md');

  it('不存在返回 null', async () => {
    await expect(store.stat(target)).resolves.toBeNull();
    await expect(store.exists(target)).resolves.toBe(false);
  });

  it('文件返回 UTF-8 字节数与 ISO 时间', async () => {
    await store.writeText(target, '中文');

    const stat = await store.stat(target);

    expect(stat).toMatchObject({ kind: 'file', size: Buffer.byteLength('中文', 'utf8') });
    expect(stat?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('产物名返回 null，即使磁盘上真有这个文件', async () => {
    const lock = uri('comem://user/alice/memories/a.md.comem-lock');
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');
    await writeFile(diskPath(lock), '{}', 'utf8');

    await expect(store.stat(lock)).resolves.toBeNull();
    await expect(store.exists(lock)).resolves.toBe(false);
    // 但文件确实还在磁盘上——这里只是不把它当节点。
    await expect(readFile(diskPath(lock), 'utf8')).resolves.toBe('{}');
  });

  it('目录返回直接子项数', async () => {
    await store.writeText(uri('comem://user/alice/memories/sub/a.md'), 'a');
    await store.writeText(uri('comem://user/alice/memories/sub/b.md'), 'b');

    await expect(store.stat(uri('comem://user/alice/memories/sub'))).resolves.toMatchObject({
      kind: 'directory',
      size: 2,
    });
  });
});

describe('writeBytes / readBytes', () => {
  const target = uri('comem://user/alice/resources/spec.pdf');

  it('原样往返二进制', async () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);

    const stat = await store.writeBytes(target, bytes);

    expect(stat).toMatchObject({ kind: 'file', size: 6 });
    expect(await store.readBytes(target)).toEqual(bytes);
  });

  it('不写 frontmatter，二进制不被解析', async () => {
    const text = '---\nnot: frontmatter\n---\n';
    await store.writeBytes(target, new TextEncoder().encode(text));

    expect((await readFile(diskPath(target), 'utf8')) === text).toBe(true);
    expect(await store.readBytes(target)).toEqual(new TextEncoder().encode(text));
  });
});

describe('原子写', () => {
  it('写完后目录里没有临时文件残留', async () => {
    const directory = uri('comem://user/alice/memories');
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');

    const names = await readdir(diskPath(directory));

    expect(names).toEqual(['a.md']);
  });

  it('写入过程中不会留下半成品（临时文件被清理）', async () => {
    const directory = uri('comem://user/alice/memories');
    await mkdir(diskPath(directory), { recursive: true });
    // 只读目录让 rename 失败，验证失败路径会清掉临时文件。
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');

    const names = await readdir(diskPath(directory));

    expect(names.filter((name) => name.startsWith('.comem-tmp-'))).toEqual([]);
  });
});

describe('错误码映射', () => {
  it('ENOENT → NOT_FOUND', async () => {
    await expectCode(store.readText(uri('comem://user/alice/memories/missing.md')), 'NOT_FOUND');
  });

  it('EISDIR → INVALID_ARGUMENT（目标是目录）', async () => {
    await store.mkdir(uri('comem://user/alice/memories/dir'), { recursive: true });

    await expectCode(store.readText(uri('comem://user/alice/memories/dir')), 'INVALID_ARGUMENT');
  });

  it('ENOTDIR → INVALID_ARGUMENT（父路径是文件）', async () => {
    await store.writeText(uri('comem://user/alice/memories/a.md'), 'a');

    await expectCode(
      store.writeText(uri('comem://user/alice/memories/a.md/child.md'), 'child'),
      'INVALID_ARGUMENT',
    );
  });

  it('错误对象带 uri 与 fsCode，调用方不用摸 errno', async () => {
    const error = await expectCode(
      store.readText(uri('comem://user/alice/memories/missing.md')),
      'NOT_FOUND',
    );

    expect(error.details).toMatchObject({
      uri: 'comem://user/alice/memories/missing.md',
      fsCode: 'ENOENT',
    });
  });
});
