import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import { eventsMemoryType } from '../../../src/domain/memory-types/events.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { profileMemoryType } from '../../../src/domain/memory-types/profile.js';
import { rulesMemoryType } from '../../../src/domain/memory-types/rules.js';
import type { MemoryTypeSchema } from '../../../src/domain/memory-type.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  MemoryService,
  type MemoryServicePorts,
  type MemoryWriteResult,
} from '../../../src/services/memory.js';

const SCOPE = 'comem://user/alice';
const PROFILE = `${SCOPE}/memories/profile.md`;
const CODE_STYLE = `${SCOPE}/memories/preferences/code-style.md`;

let dataDir: string;
let store: ContentStore;
let logger: Logger;
let search: FakeSearch;
let memory: MemoryService;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-memory-'));
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  search = new FakeSearch();
  memory = new MemoryService({
    filesystem: createRawFilesystem(store),
    locks: createPathLockManager({ dataDir, logger }),
    search,
    logger,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/**
 * 记忆文件的端口语义是「原样文档」（含 frontmatter）。
 *
 * `ContentStore.writeText` 会把文本当成**正文**、再用自己的 frontmatter 机制重新
 * 序列化，读写记忆时会吃掉 frontmatter 或者写出两段；`writeBytes` / `readBytes`
 * 才是原样字节。这个差异就是 W5b 报告里的装配缺口。
 */
function createRawFilesystem(target: ContentStore): MemoryServicePorts['filesystem'] {
  return {
    read: async (uri) => ({ text: Buffer.from(await target.readBytes(uri)).toString('utf8') }),
    write: (uri, text) => target.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8'))),
    stat: (uri) => target.stat(uri),
    remove: (uri) => target.remove(uri),
    list: (uri) => target.list(uri),
  };
}

class FakeSearch {
  readonly calls: { query: string; options: unknown }[] = [];
  hits: readonly { uri: string; abstract: string | null; score: number }[] = [];

  async find(
    query: string,
    options: unknown,
  ): Promise<readonly { uri: string; abstract: string | null; score: number }[]> {
    this.calls.push({ query, options });
    return this.hits;
  }
}

/** 一个不在内置表里的类型：用来测 `string[]` / number / boolean 的序列化。 */
const tagMemoryType = {
  type: 'tags',
  description: '测试用的标签类型',
  directory: 'memories/tags',
  filename: '{name}.md',
  operationMode: 'upsert',
  fields: [
    { name: 'name', type: 'string', identity: true, required: true, description: '标识' },
    { name: 'labels', type: 'string[]', description: '标签' },
    { name: 'count', type: 'number', description: '计数' },
    { name: 'enabled', type: 'boolean', description: '是否启用' },
    { name: 'content', type: 'string', merge: 'patch', description: '正文' },
    { name: 'updatedAt', type: 'string', merge: 'replace', description: '最后更新时间' },
  ],
} satisfies MemoryTypeSchema;

describe('upsertMemory / read', () => {
  it('写盘是 §6.6 的 Markdown + frontmatter，且 read 得到同样的字段', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '用户偏好 TypeScript 严格模式。',
    });

    expect(result.uri.toString()).toBe(CODE_STYLE);
    expect(result.created).toBe(true);
    expect(result.before).toBeNull();
    expect(result.after).toBe('## content\n\n用户偏好 TypeScript 严格模式。');

    const raw = await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('memory_type: preferences');
    expect(raw).toContain('topic: code-style');
    expect(raw).toContain('status: active');
    expect(raw).toContain(`uri: ${CODE_STYLE}`);
    expect(raw).toContain('## content\n\n用户偏好 TypeScript 严格模式。');

    const record = await memory.read(Uri.parse(CODE_STYLE));
    expect(record).not.toBeNull();
    expect(record?.memoryType).toBe('preferences');
    expect(record?.status).toBe('active');
    expect(record?.fields['topic']).toBe('code-style');
    expect(record?.fields['content']).toBe('用户偏好 TypeScript 严格模式。');
    // `updatedAt` 字段与 frontmatter 的 `updated_at` 是同一个值（§6.6 的写法）。
    expect(record?.updatedAt).toBe(record?.fields['updatedAt']);
  });

  it('更新时 before 是旧正文、created 为 false，且不重复写 frontmatter', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '旧正文',
    });
    const second = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '新正文',
    });

    expect(second.created).toBe(false);
    expect(second.before).toBe('## content\n\n旧正文');
    expect(second.after).toBe('## content\n\n新正文');

    const raw = await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8');
    // 只有一段 frontmatter：两段说明写入路径把文档当正文又序列化了一次。
    expect(raw.split('---\n').length - 1).toBe(2);
  });

  it('不存在的记忆返回 null', async () => {
    expect(await memory.read(Uri.parse(PROFILE))).toBeNull();
  });

  it('字段类型与 schema 不符时拒绝写入', async () => {
    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        topic: 'code-style',
        content: 42,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('identity 缺失时拒绝写入', async () => {
    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, { content: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('identity 含斜杠时拒绝写入（会把记忆写到目录外）', async () => {
    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        topic: '../escape',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('转换函数返回 null 时不落盘，written 为 false', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: 'x',
    });
    const before = await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8');

    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      uri: Uri.parse(CODE_STYLE),
      update: () => null,
    });

    expect(result.written).toBe(false);
    expect(result.created).toBe(false);
    // 逐字节不变：白写一次会推后 `updated_at`，把已复核的记忆打回 `pending`。
    expect(await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8')).toBe(before);
  });

  it('转换函数改掉 identity 时拒绝写入（不做隐式 move）', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: 'x',
    });

    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        uri: Uri.parse(CODE_STYLE),
        update: (current) => ({ ...current, topic: 'other' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 目标文件没变，也没有在另一个路径下多出一条记忆。
    expect((await memory.read(Uri.parse(CODE_STYLE)))?.fields['content']).toBe('x');
    expect(await memory.read(Uri.parse(`${SCOPE}/memories/preferences/other.md`))).toBeNull();
  });
});

describe('addOnly 类型（events）', () => {
  it('首次写入成功，第二次抛 ALREADY_EXISTS', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), eventsMemoryType, {
      event: '2026-11-05-architecture-decision',
      content: '决定采用单包 + 四层分层。',
    });

    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), eventsMemoryType, {
        event: '2026-11-05-architecture-decision',
        content: '改写历史。',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

    const record = await memory.read(
      Uri.parse(`${SCOPE}/memories/events/2026-11-05-architecture-decision.md`),
    );
    expect(record?.fields['content']).toBe('决定采用单包 + 四层分层。');
  });
});

describe('复核闸门（§11.6）', () => {
  it('experiences 写入是 pending，listPending 能看到，approve 后变 active', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '从 monorepo 迁到单包。',
    });

    const pending = await memory.read(result.uri);
    expect(pending?.status).toBe('pending');

    const listed = await memory.listPending(Uri.parse(SCOPE));
    expect(listed.map((record) => record.uri.toString())).toEqual([result.uri.toString()]);

    await memory.approve(result.uri);
    expect((await memory.read(result.uri))?.status).toBe('active');
    expect(await memory.listPending(Uri.parse(SCOPE))).toEqual([]);
  });

  it('非复核类型直接 active，不进 listPending', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '偏好严格模式。',
    });

    expect((await memory.read(result.uri))?.status).toBe('active');
    expect(await memory.listPending(Uri.parse(SCOPE))).toEqual([]);
  });

  it('reject 删除文件并记录原因', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '结论不成立。',
    });

    await memory.reject(result.uri, '证据不足');

    expect(await memory.read(result.uri)).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '记忆复核拒绝，已删除',
      expect.objectContaining({ reason: '证据不足' }),
    );
  });

  it('listPending 遵守 limit', async () => {
    for (const topic of ['a', 'b']) {
      await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, { topic, content: topic });
    }

    expect(await memory.listPending(Uri.parse(SCOPE), { limit: 1 })).toHaveLength(1);
    expect(await memory.listPending(Uri.parse(SCOPE), { limit: 0 })).toEqual([]);
  });

  it('scope 下没有 memories 目录时返回空列表', async () => {
    expect(await memory.listPending(Uri.parse('comem://user/nobody'))).toEqual([]);
  });
});

describe('prefetch（§11.3）', () => {
  it('单文件类型直接读该文件，不检索', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), profileMemoryType, {
      name: 'alice',
      content: '后端工程师。',
    });

    const records = await memory.prefetch(Uri.parse(SCOPE), profileMemoryType, '随便一个查询', 5);

    expect(records).toHaveLength(1);
    expect(records[0]?.uri.toString()).toBe(PROFILE);
    expect(search.calls).toHaveLength(0);
  });

  it('单文件类型不存在时返回空数组', async () => {
    expect(await memory.prefetch(Uri.parse(SCOPE), profileMemoryType, 'q', 5)).toEqual([]);
  });

  it('多文件类型走检索，limit 取 max(5, topN)', async () => {
    search.hits = [{ uri: CODE_STYLE, abstract: '代码风格', score: 1 }];
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '偏好严格模式。',
    });

    const records = await memory.prefetch(Uri.parse(SCOPE), preferencesMemoryType, '代码风格', 2);

    expect(search.calls).toHaveLength(1);
    expect(search.calls[0]?.query).toBe('代码风格');
    expect(search.calls[0]?.options).toMatchObject({
      scopes: [`${SCOPE}/memories/preferences`],
      limit: 5,
    });
    expect(records.map((record) => record.uri.toString())).toEqual([CODE_STYLE]);
  });

  it('pending 记录不进预取结果（复核闸门）', async () => {
    const pendingUri = `${SCOPE}/memories/experiences/monorepo-migration.md`;
    search.hits = [{ uri: pendingUri, abstract: null, score: 1 }];
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '待复核。',
    });

    expect(await memory.prefetch(Uri.parse(SCOPE), experiencesMemoryType, 'q', 5)).toEqual([]);
  });
});

describe('YAML 转义（formatScalar）', () => {
  it('特殊字符加引号后能原样读回', async () => {
    const content = 'a: b # c [d] {e} "f"';
    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'quoting',
      content,
    });

    const raw = await readFile(toDiskPath(dataDir, result.uri), 'utf8');
    // `content` 在正文里，不参与 frontmatter 转义；用其它字段验证。
    expect(raw).toContain('# content');

    const record = await memory.read(result.uri);
    expect(record?.fields['content']).toBe(content);
  });

  it('frontmatter 里的字符串字段按需加引号', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), tagMemoryType, {
      name: 'quoted',
      labels: ['plain', 'a: b', '#hash', '[bracket]', 'line1\nline2', '1.5', 'true'],
      count: 1.5,
      enabled: true,
      content: '正文',
    });

    const raw = await readFile(toDiskPath(dataDir, result.uri), 'utf8');
    expect(raw).toContain('name: quoted');
    expect(raw).toContain('  - plain');
    expect(raw).toContain('"a: b"');
    expect(raw).toContain('"#hash"');
    expect(raw).toContain('"[bracket]"');
    expect(raw).toContain('"line1\\nline2"');
    expect(raw).toContain('"1.5"');
    expect(raw).toContain('"true"');
    expect(raw).toContain('count: 1.5');
    expect(raw).toContain('enabled: true');

    const record = await memory.read(result.uri);
    expect(record?.fields['labels']).toEqual([
      'plain',
      'a: b',
      '#hash',
      '[bracket]',
      'line1\nline2',
      '1.5',
      'true',
    ]);
    expect(record?.fields['count']).toBe(1.5);
    expect(record?.fields['enabled']).toBe(true);
  });

  it('多行正文原样读回', async () => {
    const content = '第一行\n第二行\n\n第四行';
    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'multiline',
      content,
    });

    expect((await memory.read(result.uri))?.fields['content']).toBe(content);
  });

  it('NaN 拒绝写入', async () => {
    await expect(
      memory.upsertMemory(Uri.parse(SCOPE), tagMemoryType, {
        name: 'nan',
        count: Number.NaN,
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

describe('sources 溯源（W97）', () => {
  /** 一次归档的 URI；与真实归档目录同形（`archive_NNN`）。 */
  function archive(index: number): string {
    return `${SCOPE}/sessions/s1/archive_${String(index).padStart(3, '0')}`;
  }

  function archives(...indexes: readonly number[]): Uri[] {
    return indexes.map((index) => Uri.parse(archive(index)));
  }

  /**
   * 以 `{ uri, update, provenance }` 形态写一条记忆。
   *
   * 这就是 `memory_merge` 的写法：归档 URI 由写入点给出，不是记忆字段。
   */
  async function writeWithSources(
    topic: string,
    content: string,
    indexes: readonly number[],
  ): Promise<MemoryWriteResult> {
    return memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      uri: Uri.parse(`${SCOPE}/memories/preferences/${topic}.md`),
      update: (current) => ({ ...current, topic, content }),
      provenance: { sources: archives(...indexes) },
    });
  }

  it('写入时把归档 URI 追加进 frontmatter 的 sources，且不进 fields', async () => {
    await writeWithSources('code-style', '用户偏好 TypeScript 严格模式。', [1]);

    const raw = await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8');
    // 块序列，与 string[] 字段同一写法。
    expect(raw).toContain(`sources:\n  - ${archive(1)}\n`);

    const record = await memory.read(Uri.parse(CODE_STYLE));
    expect(record?.sources).toEqual([archive(1)]);
    // 保留键：它不是记忆字段，`read` 出来的 `fields` 里不该多一列。
    expect(Object.keys(record?.fields ?? {})).not.toContain('sources');
  });

  it('两次归档更新同一条记忆：追加而不是覆盖，重复的归档不重复记', async () => {
    const uri = Uri.parse(CODE_STYLE);
    for (const index of [1, 2, 1]) {
      await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        uri,
        update: (current) => ({
          ...current,
          topic: 'code-style',
          content: `第 ${index} 次归档的结论。`,
        }),
        provenance: { sources: archives(index) },
      });
    }

    // 顺序 = 最旧在前；第三次是重放（同一个归档）→ 去重后不动位置。
    expect((await memory.read(uri))?.sources).toEqual([archive(1), archive(2)]);
  });

  it('重写正文不丢 sources（完整重写会丢掉不在保留键里的键）', async () => {
    const uri = Uri.parse(CODE_STYLE);
    await writeWithSources('code-style', '旧正文', [1, 2]);

    // 再走一次补丁写：`upsertMemory` 整份重写文件，`sources` 只能靠保留键活下来。
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      uri,
      update: (current) => ({ ...current, content: '新正文' }),
    });

    const record = await memory.read(uri);
    expect(record?.fields['content']).toBe('新正文');
    expect(record?.sources).toEqual([archive(1), archive(2)]);

    const raw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(raw).toContain(`  - ${archive(1)}`);
    expect(raw).toContain(`  - ${archive(2)}`);
  });

  it('复核通过（approve 整份重写）不丢 sources', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      uri: Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`),
      update: () => ({ topic: 'monorepo-migration', content: '从 monorepo 迁到单包。' }),
      provenance: { sources: archives(7) },
    });
    expect((await memory.read(result.uri))?.status).toBe('pending');

    await memory.approve(result.uri);

    const approved = await memory.read(result.uri);
    expect(approved?.status).toBe('active');
    expect(approved?.sources).toEqual([archive(7)]);
  });

  it('没有归档信息的写入不产生 sources 键（旧数据与旧输出都不变）', async () => {
    const result = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '没有溯源的记忆。',
    });

    const raw = await readFile(toDiskPath(dataDir, result.uri), 'utf8');
    expect(raw).not.toContain('sources');
    expect((await memory.read(result.uri))?.sources).toEqual([]);
  });

  it('合并两条各有 sources 的记忆：并集去重', async () => {
    const kept = await writeWithSources('code-style', '主记忆。', [1]);
    const merged = await writeWithSources('other', '被合并掉的记忆。', [2, 1]);

    // `ConsolidationService` 的写回是同一形态：把被合并记录的 sources 并进保留者。
    const mergedSources = (await memory.read(merged.uri))?.sources ?? [];
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      uri: kept.uri,
      update: (current) => ({ ...current, content: '主记忆 + 被合并的一条。' }),
      provenance: { sources: mergedSources.map((source) => Uri.parse(source)) },
    });

    expect((await memory.read(kept.uri))?.sources).toEqual([archive(1), archive(2)]);
  });

  it('超过 20 条只保留最近 20 条（最早的先丢）', async () => {
    const uri = Uri.parse(CODE_STYLE);
    await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '基线。',
    });

    for (let index = 1; index <= 21; index += 1) {
      await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        uri,
        update: (current) => ({ ...current }),
        provenance: { sources: archives(index) },
      });
    }

    const sources = (await memory.read(uri))?.sources ?? [];
    expect(sources).toHaveLength(20);
    expect(sources[0]).toBe(archive(2));
    expect(sources.at(-1)).toBe(archive(21));

    const raw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(raw.match(/^ {2}- comem:\/\//gm)).toHaveLength(20);
  });
});

/**
 * 有效区间与版本快照（W98）。
 *
 * 一条记忆一次覆盖写不再销毁旧值：旧文档变成 `.history` 下的版本文件，规范文件
 * 写新的 `valid_from`，两者靠 `valid_until` / `supersedes` 串起来。时间用 fake
 * Date 固定：文件名里的 stamp 是断言的一部分，真实时钟会让「留下来的五份是哪五份」
 * 变成一次碰运气。
 */
describe('有效区间与版本快照（W98）', () => {
  /** 规范文件与版本文件共用的时间基点。 */
  const T0 = '2026-11-10T02:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function at(seconds: number): void {
    vi.setSystemTime(new Date(Date.parse(T0) + seconds * 1000));
  }

  /** 版本目录（相对 scope 根，如 `memories/preferences/.history`）的绝对路径。 */
  function historyDiskPath(relative: string): string {
    return join(dataDir, 'user/alice', relative);
  }

  async function historyNames(relative: string): Promise<string[]> {
    try {
      return (await readdir(historyDiskPath(relative))).sort();
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  function versionUri(memoryTypeDirectory: string, name: string): Uri {
    return Uri.parse(`${SCOPE}/memories/${memoryTypeDirectory}/.history/${name}`);
  }

  /** 规范文件 frontmatter 里的 `valid_from` / `valid_until` / `supersedes` 行。 */
  function frontmatterLine(raw: string, key: string): string | null {
    const line = raw.split('\n').find((candidate) => candidate.startsWith(`${key}:`));
    return line === undefined ? null : line.slice(key.length + 1).trim();
  }

  it('同 topic 写两次：旧值成为版本文件，规范文件的有效期只有起点', async () => {
    const first = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '第一版正文。',
    });
    const created = await memory.read(first.uri);
    // 首条写入没有旧值可快照，`valid_from` 就是创建时刻。
    expect(created?.validFrom).toBe(T0);
    expect(created?.validUntil).toBeNull();
    expect(await historyNames('memories/preferences/.history')).toEqual([]);

    at(3600);
    const second = await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '第二版正文。',
    });

    const canonical = await memory.read(second.uri);
    expect(canonical?.validFrom).toBe('2026-11-10T03:00:00.000Z');
    expect(canonical?.validUntil).toBeNull();
    expect(canonical?.fields['content']).toBe('第二版正文。');

    const names = await historyNames('memories/preferences/.history');
    // 文件名里的 stamp 是**快照时刻**（第二次写入的时间），不是旧值的起点。
    expect(names).toEqual(['code-style.md--20261110T030000000Z.md']);
    const version = await memory.read(versionUri('preferences', names[0] ?? ''));
    expect(version?.validFrom).toBe(T0);
    expect(version?.validUntil).toBe('2026-11-10T03:00:00.000Z');
    expect(version?.fields['content']).toBe('第一版正文。');

    // 版本文件不是「另一个 identity」：它的 memory_type / topic 与规范文件相同。
    expect(version?.memoryType).toBe('preferences');
    expect(version?.fields['topic']).toBe('code-style');

    const raw = await readFile(toDiskPath(dataDir, second.uri), 'utf8');
    expect(raw).toContain('valid_from: "2026-11-10T03:00:00.000Z"');
    expect(raw).not.toContain('valid_until');
    // 新文档指回被它顶替的版本：`reject` 靠这条线回到写入前。
    expect(raw).toContain(`supersedes: ${versionUri('preferences', names[0] ?? '').toString()}`);
  });

  it('有效期从元数据写、不从 fields 读（模型改不了自己的有效期）', async () => {
    await memory.upsertMemory(Uri.parse(SCOPE), tagMemoryType, {
      name: 'forged',
      content: '正文。',
      // 这两个键不是 schema 字段：直接写入时会被序列化器忽略，不会进 frontmatter。
      valid_from: '2000-01-01T00:00:00.000Z',
      valid_until: '2000-01-02T00:00:00.000Z',
    });

    const uri = Uri.parse(`${SCOPE}/memories/tags/forged.md`);
    const raw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(raw.match(/^valid_from:/gm)).toHaveLength(1);
    expect(frontmatterLine(raw, 'valid_from')).toBe(`"${T0}"`);
    expect(raw).not.toContain('valid_until');

    const record = await memory.read(uri);
    expect(record?.validFrom).toBe(T0);
    expect(record?.validUntil).toBeNull();
    // 保留键：有效期不是记忆字段，`read` 出来的 `fields` 里不该多一列。
    expect(Object.keys(record?.fields ?? {})).not.toContain('valid_from');
  });

  it('连写 7 次：版本收敛到 5 份，被删的是最旧的（按 stamp 升序）', async () => {
    const uri = Uri.parse(CODE_STYLE);
    for (let index = 1; index <= 7; index += 1) {
      at(index);
      await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        uri,
        update: (current) => ({
          ...current,
          topic: 'code-style',
          content: `第 ${index} 版正文。`,
        }),
      });
    }

    const names = await historyNames('memories/preferences/.history');
    // 第 1 次写入没有旧值；第 2–7 次各快照上一版，共 6 份 → 截断到最新 5 份。
    // 留下的是第 2–6 次写入时产生的版本（stamp 03..07 秒）。
    expect(names).toEqual([
      'code-style.md--20261110T020003000Z.md',
      'code-style.md--20261110T020004000Z.md',
      'code-style.md--20261110T020005000Z.md',
      'code-style.md--20261110T020006000Z.md',
      'code-style.md--20261110T020007000Z.md',
    ]);

    // 留下来的确实是最新的 5 份正文（第 2–6 版），最旧的那份（第 1 版）没了。
    const contents: (string | undefined)[] = [];
    for (const name of names) {
      contents.push((await memory.read(versionUri('preferences', name)))?.fields['content'] as
        | string
        | undefined);
    }
    expect(contents).toEqual([
      '第 2 版正文。',
      '第 3 版正文。',
      '第 4 版正文。',
      '第 5 版正文。',
      '第 6 版正文。',
    ]);
    expect(await memory.read(versionUri('preferences', 'code-style.md--20261110T020002000Z.md'))).toBeNull();

    // 规范文件仍然只有一个、内容是最后一版，检索面的行为不受影响。
    expect((await memory.read(uri))?.fields['content']).toBe('第 7 版正文。');
    expect((await memory.read(uri))?.validFrom).toBe('2026-11-10T02:00:07.000Z');
  });

  it('pending 状态下覆盖：不快照旧值，但继承 supersedes', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第一版。',
    });
    await memory.approve(uri);

    at(60);
    // 已复核的旧值是有效值 → 写新正文时快照它，新文档 pending 且指向版本文件。
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第二版。',
    });
    const afterSecond = await historyNames('memories/experiences/.history');
    expect(afterSecond).toHaveLength(1);
    const snapshot = versionUri('experiences', afterSecond[0] ?? '');
    const secondRaw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(frontmatterLine(secondRaw, 'supersedes')).toBe(snapshot.toString());

    at(120);
    // `existing` 现在是 pending：它不是有效值，不快照；但上一条有效版本的指向必须留着。
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第三版。',
    });

    expect(await historyNames('memories/experiences/.history')).toEqual(afterSecond);
    const thirdRaw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(frontmatterLine(thirdRaw, 'supersedes')).toBe(snapshot.toString());
    expect((await memory.read(uri))?.validFrom).toBe('2026-11-10T02:02:00.000Z');
    expect((await memory.read(uri))?.status).toBe('pending');
    // 版本文件里仍然是第一版：pending 的第二版没有资格成为「正确旧值」。
    expect((await memory.read(snapshot))?.fields['content']).toBe('第一版。');
  });

  it('identity 自带目录时镜像出同名子目录（rules 的 {scenario}/{rule}.md）', async () => {
    const uri = `${SCOPE}/memories/rules/backend/naming.md`;
    await memory.upsertMemory(Uri.parse(SCOPE), rulesMemoryType, {
      scenario: 'backend',
      rule: 'naming',
      content: '接口名用动词短语。',
    });
    // rules 走复核闸门：先通过，旧值才是「有效值」、才有资格被快照。
    await memory.approve(Uri.parse(uri));
    at(60);
    await memory.upsertMemory(Uri.parse(SCOPE), rulesMemoryType, {
      uri: Uri.parse(uri),
      update: (current) => ({ ...current, content: '接口名用动词短语，字段名用名词。' }),
    });

    // `.history` 里镜像 `scenario/` 那一层，版本文件名只替换最后一段。
    expect(await historyNames('memories/rules/.history/backend')).toEqual([
      'naming.md--20261110T020100000Z.md',
    ]);
    const version = await memory.read(
      Uri.parse(`${SCOPE}/memories/rules/.history/backend/naming.md--20261110T020100000Z.md`),
    );
    expect(version?.fields['content']).toBe('接口名用动词短语。');
    expect(version?.validUntil).toBe('2026-11-10T02:01:00.000Z');
  });

  it('同一毫秒内的两次快照：文件名追加 -1，不覆盖前一份', async () => {
    const uri = Uri.parse(CODE_STYLE);
    // 时间不前进：两次覆盖的快照 stamp 相同。
    for (const content of ['第一版。', '第二版。', '第三版。']) {
      await memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
        uri,
        update: (current) => ({ ...current, topic: 'code-style', content }),
      });
    }

    expect(await historyNames('memories/preferences/.history')).toEqual([
      'code-style.md--20261110T020000000Z-1.md',
      'code-style.md--20261110T020000000Z.md',
    ]);
    // 两份版本各自保存了不同的旧正文：撞名没有让第二份覆盖第一份。
    const first = await memory.read(
      versionUri('preferences', 'code-style.md--20261110T020000000Z.md'),
    );
    const second = await memory.read(
      versionUri('preferences', 'code-style.md--20261110T020000000Z-1.md'),
    );
    expect(first?.fields['content']).toBe('第一版。');
    expect(second?.fields['content']).toBe('第二版。');
  });

  it('listPending 跳过 .history：待复核队列只包含规范路径', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第一版。',
    });
    await memory.approve(uri);

    at(60);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第二版。',
    });
    expect(await historyNames('memories/experiences/.history')).toHaveLength(1);

    // 版本文件的 `status` 保留快照时刻的值（active），不会自己进队列；这里再手工
    // 放一份 `status: pending` 的版本，直接钉住「按目录排除」而不是「碰巧不是 pending」。
    const manual = versionUri('experiences', 'manual.md--20261110T030000000Z.md');
    await store.writeBytes(
      manual,
      Uint8Array.from(
        Buffer.from(
          [
            '---',
            'memory_type: experiences',
            'status: pending',
            'created_at: 2026-11-10T03:00:00.000Z',
            'updated_at: 2026-11-10T03:00:00.000Z',
            `uri: ${manual.toString()}`,
            'topic: manual',
            '---',
            '',
            '## content',
            '',
            '手工放进去的 pending 版本。',
          ].join('\n'),
          'utf8',
        ),
      ),
    );

    const listed = await memory.listPending(Uri.parse(SCOPE));
    expect(listed.map((record) => record.uri.toString())).toEqual([uri.toString()]);
  });

  it('approve 之后 valid_from 与 supersedes 仍在', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第一版。',
    });
    await memory.approve(uri);

    at(60);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第二版。',
    });
    const names = await historyNames('memories/experiences/.history');
    const snapshot = versionUri('experiences', names[0] ?? '');

    at(120);
    await memory.approve(uri);

    const approved = await memory.read(uri);
    expect(approved?.status).toBe('active');
    expect(approved?.validFrom).toBe('2026-11-10T02:01:00.000Z');
    expect(approved?.validUntil).toBeNull();
    const raw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(frontmatterLine(raw, 'valid_from')).toBe('"2026-11-10T02:01:00.000Z"');
    expect(frontmatterLine(raw, 'supersedes')).toBe(snapshot.toString());
  });

  it('reject（有 supersedes）：规范文件恢复旧正文、valid_until 清空、pending 内容消失', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '写入前的正确结论。',
    });
    await memory.approve(uri);

    at(60);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '被拒绝的错误结论。',
    });
    expect((await memory.read(uri))?.status).toBe('pending');

    at(120);
    await memory.reject(uri, '证据不足');

    const restored = await memory.read(uri);
    expect(restored?.fields['content']).toBe('写入前的正确结论。');
    expect(restored?.status).toBe('active');
    // 「回到写入前」：起点还是第一次写入的时刻，终点被清掉（它又有效了）。
    expect(restored?.validFrom).toBe(T0);
    expect(restored?.validUntil).toBeNull();
    // 被拒绝的正文不再存在，pending 列表里也没有这条了。
    const raw = await readFile(toDiskPath(dataDir, uri), 'utf8');
    expect(raw).not.toContain('被拒绝的错误结论。');
    expect(await memory.listPending(Uri.parse(SCOPE))).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      '记忆复核拒绝，已恢复到上一个有效版本',
      expect.objectContaining({ reason: '证据不足' }),
    );
    // 版本文件留着（`valid_until` 仍非空，检索看不到它）。
    const names = await historyNames('memories/experiences/.history');
    expect(names).toHaveLength(1);
    expect((await memory.read(versionUri('experiences', names[0] ?? '')))?.validUntil).toBe(
      '2026-11-10T02:01:00.000Z',
    );
  });

  it('reject（没有 supersedes）：维持删除', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '首条写入。',
    });

    await memory.reject(uri, '证据不足');

    expect(await memory.read(uri)).toBeNull();
    expect(await historyNames('memories/experiences/.history')).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      '记忆复核拒绝，已删除',
      expect.objectContaining({ reason: '证据不足' }),
    );
  });

  it('supersedes 指向的版本文件已被截断时，reject 退回删除而不是抛错', async () => {
    const uri = Uri.parse(`${SCOPE}/memories/experiences/monorepo-migration.md`);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第一版。',
    });
    await memory.approve(uri);
    at(60);
    await memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '第二版。',
    });

    // 模拟截断把版本文件物理删掉：指向还在、文件没了。
    const names = await historyNames('memories/experiences/.history');
    await store.remove(versionUri('experiences', names[0] ?? ''));

    await memory.reject(uri, '证据不足');

    expect(await memory.read(uri)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      '记忆的 supersedes 指向的文件不存在，拒绝时按删除处理',
      expect.objectContaining({ supersedes: versionUri('experiences', names[0] ?? '').toString() }),
    );
  });
});
