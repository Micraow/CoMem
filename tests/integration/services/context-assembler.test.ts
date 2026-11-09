import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import type { AssemblyCandidate } from '../../../src/domain/assembly.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  AllowAllAuthorizer,
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';

const AUTH_PRINCIPALS: readonly string[] = [];

let dataDir: string;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: Logger;

const DIRECTORY = Uri.parse('comem://user/alice/memories');
const BODY = 'comem://user/alice/memories/m1';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-assembler-'));
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function createAssembler(options: {
  readonly authorizer?: Authorizer;
  readonly readConcurrency?: number;
  readonly estimateTokens?: (text: string) => number;
} = {}): ContextAssembler {
  return new ContextAssembler({
    store,
    metadata,
    authorizer: options.authorizer ?? new AllowAllAuthorizer(),
    logger,
    readConcurrency: options.readConcurrency,
    estimateTokens: options.estimateTokens,
  });
}

function candidate(uri: string, overrides: Partial<AssemblyCandidate> = {}): AssemblyCandidate {
  return {
    uri,
    contextType: 'memory',
    memoryType: null,
    level: 'L0',
    score: 1,
    abstract: null,
    ...overrides,
  };
}

async function writeBody(uri: string, text: string): Promise<void> {
  await store.writeText(Uri.parse(uri), text);
}

/** 统计某个 URI 被 `readText` 读了几次。 */
function readCount(uri: string): number {
  return vi
    .mocked(store.readText)
    .mock.calls.filter((call) => (call[0] as Uri).toString() === uri).length;
}

class DenyAllAuthorizer implements Authorizer {
  async check(): Promise<boolean> {
    return false;
  }

  async filterReadable(): Promise<ReadonlySet<string>> {
    return new Set();
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    throw permissionDenied(uri, action);
  }
}

describe('readOverview', () => {
  it('目录候选读自己的 .overview.md', async () => {
    await writeBody(BODY, '原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(DIRECTORY.toString(), AUTH_PRINCIPALS)).resolves.toBe('L1 概览正文');
  });

  it('文件候选拿不到目录的 L1，降级成自己的骨架', async () => {
    // 摘要文件是目录级的。文件没有 `.overview.md`，若去读父目录就会让同一目录下
    // 所有文件拿到同一段 L1 正文，§8.6 的去重会把它们判成重复、只留一条。
    await writeBody(BODY, '# 标题\n\n原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBe('标题\n\n原文正文');
  });

  it('L1 缺失时用「标题树 + 首段」降级', async () => {
    await writeBody(BODY, ['# 标题', '', '首段。', '', '## 子标题', '', '其余。'].join('\n'));

    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBe('标题\n  子标题\n\n首段。');
  });

  it('摘要文件存在但正文为空时同样降级', async () => {
    await writeBody(BODY, '首段。');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', '');

    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBe('首段。');
  });

  it('摘要与正文都没有时返回 null', async () => {
    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBeNull();
  });

  it('正文只有标题时返回标题树', async () => {
    await writeBody(BODY, '# 只有标题');

    const assembler = createAssembler();
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBe('只有标题');
  });

  it('无权限时返回 null，且不读文件', async () => {
    await writeBody(BODY, '原文正文');
    const spy = vi.spyOn(store, 'readText');

    const assembler = createAssembler({ authorizer: new DenyAllAuthorizer() });
    await expect(assembler.ports.readOverview(BODY, AUTH_PRINCIPALS)).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('读之前先求权（check 被调用）', async () => {
    const authorizer: Authorizer = new AllowAllAuthorizer();
    const check = vi.spyOn(authorizer, 'check');

    const assembler = createAssembler({ authorizer });
    await assembler.ports.readOverview(BODY, AUTH_PRINCIPALS);
    expect(check).toHaveBeenCalledTimes(1);
    expect((check.mock.calls[0]?.[0] as Uri).toString()).toBe(BODY);
  });

  it('URI 无法解析时返回 null', async () => {
    const assembler = createAssembler();
    await expect(assembler.ports.readOverview('not-a-uri', AUTH_PRINCIPALS)).resolves.toBeNull();
  });
});

describe('readBody', () => {
  it('返回原文正文（不含 frontmatter）', async () => {
    await store.writeText(Uri.parse(BODY), '正文', {
      frontmatter: { summary: '摘要' },
    });

    const assembler = createAssembler();
    await expect(assembler.ports.readBody(BODY, AUTH_PRINCIPALS)).resolves.toBe('正文');
  });

  it('读不到原文返回 null，不抛错', async () => {
    const assembler = createAssembler();
    await expect(assembler.ports.readBody(BODY, AUTH_PRINCIPALS)).resolves.toBeNull();
  });

  it('目标是目录时返回 null', async () => {
    await writeBody(BODY, '正文');
    const assembler = createAssembler();

    await expect(assembler.ports.readBody(DIRECTORY.toString(), AUTH_PRINCIPALS)).resolves.toBeNull();
  });

  it('无权限时返回 null', async () => {
    await writeBody(BODY, '正文');
    const assembler = createAssembler({ authorizer: new DenyAllAuthorizer() });

    await expect(assembler.ports.readBody(BODY, AUTH_PRINCIPALS)).resolves.toBeNull();
  });
});

describe('ports', () => {
  it('暴露注入的 logger 与 token 估算器', () => {
    const assembler = createAssembler({ estimateTokens: (text) => text.length });

    expect(assembler.ports.logger).toBe(logger);
    expect(assembler.ports.estimateTokens('abcd')).toBe(4);
  });

  it('默认估算按 4 字符/token', () => {
    const assembler = createAssembler();
    expect(assembler.ports.estimateTokens('abcd')).toBe(1);
    expect(assembler.ports.estimateTokens('abcde')).toBe(2);
    expect(assembler.ports.estimateTokens('')).toBe(0);
  });

  it('并发上限必须是正整数', () => {
    expect(() => createAssembler({ readConcurrency: 0 })).toThrow(ComemError);
    expect(() => createAssembler({ readConcurrency: 1.5 })).toThrow(ComemError);
  });
});

describe('assemble', () => {
  it('把候选组装成可注入模型的文本', async () => {
    await writeBody(BODY, '原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const assembler = createAssembler({ estimateTokens: (text) => text.length });
    const result = await assembler.assemble([candidate(BODY, { abstract: '一句话摘要' })], {
      maxTokens: 10_000,
      quotaPreset: 'chat',
    }, AUTH_PRINCIPALS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.detail).toBe('full');
    expect(result.items[0]?.text).toBe('原文正文');
    expect(result.rendered).toContain('<memory');
  });

  it('同一个 URI 的概览与原文各只读一次', async () => {
    await writeBody(BODY, ['# 标题', '', '首段。'].join('\n'));
    const spy = vi.spyOn(store, 'readText');

    const assembler = createAssembler({ estimateTokens: (text) => text.length });
    const result = await assembler.assemble(
      [
        candidate(BODY, { level: 'L0', abstract: '一句话摘要' }),
        candidate(BODY, { level: 'L2', score: 0.5, abstract: '一句话摘要' }),
      ],
      { maxTokens: 10_000, quotaPreset: 'chat' }, AUTH_PRINCIPALS,
    );

    // 概览一次（骨架要读原文），全文一次；两个候选不产生额外 IO。
    expect(result.items.length).toBeGreaterThan(0);
    expect(readCount(BODY)).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('并发峰值不超过 readConcurrency', async () => {
    const uris = Array.from({ length: 6 }, (_, index) => `${BODY}-${index}`);
    await Promise.all(uris.map((uri) => writeBody(uri, `正文 ${uri}`)));

    const original = store.readText.bind(store);
    let active = 0;
    let peak = 0;
    vi.spyOn(store, 'readText').mockImplementation(async (uri) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return await original(uri);
      } finally {
        active -= 1;
      }
    });

    const assembler = createAssembler({ readConcurrency: 2 });
    await assembler.assemble(
      uris.map((uri) => candidate(uri)),
      { maxTokens: 100_000, quotaPreset: 'chat' }, AUTH_PRINCIPALS,
    );

    expect(peak).toBe(2);
  });

  it('并发上限为 1 时串行读', async () => {
    const uris = Array.from({ length: 4 }, (_, index) => `${BODY}-serial-${index}`);
    await Promise.all(uris.map((uri) => writeBody(uri, `正文 ${uri}`)));

    const original = store.readText.bind(store);
    let active = 0;
    let peak = 0;
    vi.spyOn(store, 'readText').mockImplementation(async (uri) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await original(uri);
      } finally {
        active -= 1;
      }
    });

    const assembler = createAssembler({ readConcurrency: 1 });
    await assembler.assemble(
      uris.map((uri) => candidate(uri)),
      { maxTokens: 100_000, quotaPreset: 'chat' }, AUTH_PRINCIPALS,
    );

    expect(peak).toBe(1);
  });

  it('无权限的候选拿不到正文，按只剩 URI 投放', async () => {
    await writeBody(BODY, '原文正文');

    const assembler = createAssembler({
      authorizer: new DenyAllAuthorizer(),
      estimateTokens: (text) => text.length,
    });
    const result = await assembler.assemble([candidate(BODY, { abstract: null })], {
      maxTokens: 10_000,
      quotaPreset: 'chat',
    }, AUTH_PRINCIPALS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.detail).toBeNull();
    expect(result.items[0]?.text).toBe('');
  });
});
