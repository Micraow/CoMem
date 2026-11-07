import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import { eventsMemoryType } from '../../../src/domain/memory-types/events.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { profileMemoryType } from '../../../src/domain/memory-types/profile.js';
import type { MemoryTypeSchema } from '../../../src/domain/memory-type.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { MemoryService, type MemoryServicePorts } from '../../../src/services/memory.js';

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
  memory = new MemoryService({ filesystem: createRawFilesystem(store), search, logger });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
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
