import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import type { AssembledItem, AssemblyCandidate } from '../../../src/domain/assembly.js';
import type { Logger } from '../../../src/domain/log.js';
import { estimateTokens } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
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

function createAssembler(authorizer: Authorizer = new AllowAllAuthorizer()): ContextAssembler {
  return new ContextAssembler({ store, metadata, authorizer, logger });
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

/**
 * 组装层是 IO 降级链：概览 / 原文读不到就退到更粗的一层。这里不直接调私有读方法
 * （那需要为测试保留一个公开端口），而是走 `assemble`，检查条目实际落到的层级与
 * 正文——这才是调用方看到的结果。
 */

/** 概览层的候选：`events` 从概览起投，`skill` 的天花板也是概览，升级轮次因此跳过。 */
function overviewOnly(uri: string): AssemblyCandidate {
  return candidate(uri, { contextType: 'skill', memoryType: 'events' });
}

/** 只投一个候选，返回它落到的条目（预算足够时就是该层级本身）。 */
async function assembleItem(
  assembler: ContextAssembler,
  entry: AssemblyCandidate,
): Promise<AssembledItem | undefined> {
  const result = await assembler.assemble(
    [entry],
    { maxTokens: 10_000, quotaPreset: 'chat' },
    AUTH_PRINCIPALS,
  );
  return result.items[0];
}

describe('概览读取', () => {
  it('目录候选读自己的 .overview.md', async () => {
    await writeBody(BODY, '原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const item = await assembleItem(createAssembler(), overviewOnly(DIRECTORY.toString()));
    expect(item?.detail).toBe('overview');
    expect(item?.text).toBe('L1 概览正文');
  });

  it('文件候选拿不到目录的 L1，降级成自己的骨架', async () => {
    // 摘要文件是目录级的。文件没有 `.overview.md`，若去读父目录就会让同一目录下
    // 所有文件拿到同一段 L1 正文，§8.6 的去重会把它们判成重复、只留一条。
    await writeBody(BODY, '# 标题\n\n原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const item = await assembleItem(createAssembler(), overviewOnly(BODY));
    expect(item?.detail).toBe('overview');
    expect(item?.text).toBe('标题\n\n原文正文');
  });

  it('L1 缺失时用「标题树 + 首段」降级', async () => {
    await writeBody(BODY, ['# 标题', '', '首段。', '', '## 子标题', '', '其余。'].join('\n'));

    const item = await assembleItem(createAssembler(), overviewOnly(BODY));
    expect(item?.text).toBe('标题\n  子标题\n\n首段。');
  });

  it('摘要文件存在但正文为空时同样降级', async () => {
    await writeBody(BODY, '首段。');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', '');

    const item = await assembleItem(createAssembler(), overviewOnly(BODY));
    expect(item?.text).toBe('首段。');
  });

  it('摘要与正文都没有时只剩 URI', async () => {
    const item = await assembleItem(createAssembler(), overviewOnly(BODY));
    expect(item?.detail).toBeNull();
    expect(item?.text).toBe('');
  });

  it('正文只有标题时返回标题树', async () => {
    await writeBody(BODY, '# 只有标题');

    const item = await assembleItem(createAssembler(), overviewOnly(BODY));
    expect(item?.text).toBe('只有标题');
  });

  it('无权限时不读文件，条目只剩 URI', async () => {
    await writeBody(BODY, '原文正文');
    const spy = vi.spyOn(store, 'readText');

    const item = await assembleItem(
      createAssembler(new DenyAllAuthorizer()),
      overviewOnly(BODY),
    );
    expect(item?.detail).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('读之前先求权（check 被调用）', async () => {
    const authorizer: Authorizer = new AllowAllAuthorizer();
    const check = vi.spyOn(authorizer, 'check');

    await assembleItem(createAssembler(authorizer), overviewOnly(BODY));
    expect(check).toHaveBeenCalledTimes(1);
    expect((check.mock.calls[0]?.[0] as Uri).toString()).toBe(BODY);
  });

  it('URI 无法解析时按缺失处理', async () => {
    const item = await assembleItem(createAssembler(), overviewOnly('not-a-uri'));
    expect(item?.detail).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('检索候选的 URI 无法解析，概览按缺失处理', {
      uri: 'not-a-uri',
    });
  });
});

describe('原文读取', () => {
  it('返回原文正文（不含 frontmatter）', async () => {
    await store.writeText(Uri.parse(BODY), '正文', {
      frontmatter: { summary: '摘要' },
    });

    const item = await assembleItem(createAssembler(), candidate(BODY, { abstract: '摘要' }));
    expect(item?.detail).toBe('full');
    expect(item?.text).toBe('正文');
  });

  it('读不到原文时停在摘要层，不抛错', async () => {
    const item = await assembleItem(createAssembler(), candidate(BODY, { abstract: '摘要' }));
    expect(item?.detail).toBe('abstract');
    expect(item?.text).toBe('摘要');
  });

  it('目标是目录时停在摘要层', async () => {
    await writeBody(BODY, '正文');

    const item = await assembleItem(
      createAssembler(),
      candidate(DIRECTORY.toString(), { abstract: '摘要' }),
    );
    expect(item?.detail).toBe('abstract');
  });

  it('无权限时停在摘要层', async () => {
    await writeBody(BODY, '正文');

    const item = await assembleItem(
      createAssembler(new DenyAllAuthorizer()),
      candidate(BODY, { abstract: '摘要' }),
    );
    expect(item?.detail).toBe('abstract');
  });
});

describe('装配参数', () => {
  it('token 成本与自动提交阈值共用 domain 的实现（CJK 1 码点/token）', async () => {
    await writeBody(BODY, '中文正文');
    const result = await createAssembler().assemble(
      [candidate(BODY, { abstract: '摘要' })],
      { maxTokens: 10_000, quotaPreset: 'chat' },
      AUTH_PRINCIPALS,
    );

    expect(result.items).toHaveLength(1);
    // 单条目时 `rendered` 就是这条的渲染结果。装配层不再自己估算，用的是
    // `domain/session.ts` 的 `estimateTokens`——同一段文本在装配预算与自动提交
    // 阈值里必须是同一个数。
    expect(result.items[0]?.tokens).toBe(estimateTokens(result.rendered));
  });
});

describe('assemble', () => {
  it('把候选组装成可注入模型的文本', async () => {
    await writeBody(BODY, '原文正文');
    await metadata.writeSummary(DIRECTORY, '一句话摘要', 'L1 概览正文');

    const assembler = createAssembler();
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

    const assembler = createAssembler();
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

  it('并发读的峰值不超过固定上限 8', async () => {
    // `READ_CONCURRENCY` 是 fd 压力界，不注入也不配置。9 条候选才能把上限顶满：
    // 8 个并发 + 1 个等许可。
    const uris = Array.from({ length: 9 }, (_, index) => `${BODY}-${index}`);
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

    await createAssembler().assemble(
      uris.map((uri) => candidate(uri)),
      { maxTokens: 100_000, quotaPreset: 'chat' },
      AUTH_PRINCIPALS,
    );

    expect(peak).toBe(8);
  });

  it('无权限的候选拿不到正文，按只剩 URI 投放', async () => {
    await writeBody(BODY, '原文正文');

    const assembler = createAssembler(new DenyAllAuthorizer());
    const result = await assembler.assemble([candidate(BODY, { abstract: null })], {
      maxTokens: 10_000,
      quotaPreset: 'chat',
    }, AUTH_PRINCIPALS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.detail).toBeNull();
    expect(result.items[0]?.text).toBe('');
  });
});
