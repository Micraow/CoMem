import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { FakeLlmProvider } from '../../helpers/fake-llm-provider.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType, NodeKind } from '../../../src/domain/node.js';
import { stableDigest } from '../../../src/domain/node.js';
import {
  ABSTRACT_MAX_CHARS,
  OVERVIEW_MAX_CHARS,
  type DirectorySummary,
  type SummaryGenerator,
  type SummaryInput,
} from '../../../src/domain/summary.js';
import { segmentCjk } from '../../../src/domain/text.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { LlmService } from '../../../src/services/llm.js';
import {
  LlmSummarizer,
  RuleSummarizer,
  SummaryService,
  type SummaryServiceConfig,
} from '../../../src/services/summary.js';

const SCOPE_ROOT = 'comem://user/alice';
const MEMORIES = `${SCOPE_ROOT}/memories`;
const PREFERENCES = `${MEMORIES}/preferences`;
const TEAM = `${PREFERENCES}/team`;
const CONVENTIONS = `${TEAM}/conventions.md`;
const STYLE = `${PREFERENCES}/code-style.md`;

const UPDATED_AT = '2026-11-08T00:00:00.000Z';

/** 生成器返回的固定 L0，用于「L0 没变」的断言。 */
const STABLE_ABSTRACT = '固定摘要';

let dataDir: string;
let db: DatabaseSync;
let store: ContentStore;
let metadata: MetadataFileStore;
let nodes: NodeRepository;
let index: SqliteFtsIndex;
let locks: PathLockManager;
let acl: AclService;
let logger: Logger;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-summary-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  nodes = new NodeRepository({ db, logger });
  index = new SqliteFtsIndex({ db, logger });
  locks = createPathLockManager({ dataDir, logger });
  // 真实 `AclService`：`#summarize` 写索引之后要物化权限，桩会让这条链路在测试里断掉。
  acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions: new PermissionRepository({ db, logger }),
    nodes,
    logger,
    locks,
  });
});

afterEach(async () => {
  db.close();
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

interface ServiceOptions {
  readonly generator?: SummaryGenerator;
  readonly config?: Partial<SummaryServiceConfig>;
}

function createService(options: ServiceOptions = {}): SummaryService {
  const config: Partial<SummaryServiceConfig> = options.config ?? {};
  return new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    logger,
    locks,
    generator: options.generator ?? new RuleSummarizer(),
    config: {
      abstractMaxChars: config.abstractMaxChars ?? ABSTRACT_MAX_CHARS,
      overviewMaxChars: config.overviewMaxChars ?? OVERVIEW_MAX_CHARS,
      freshness: config.freshness,
    },
  });
}

/** 在磁盘上建目录（含全部祖先）。 */
async function makeDirectory(uri: string): Promise<void> {
  await store.mkdir(Uri.parse(uri), { recursive: true });
}

async function writeText(uri: string, text: string): Promise<void> {
  await store.writeText(Uri.parse(uri), text);
}

interface SeedOptions {
  readonly kind?: NodeKind;
  readonly abstract?: string | null;
  readonly bodyDigest?: string;
  readonly contextType?: ContextType;
  readonly baseline?: string | null;
  readonly pending?: number;
  readonly entries?: number;
}

/** 写入一行索引，并顺带设置新鲜度三列（它们不在 `NodeRow` 上）。 */
async function seedRow(uri: string, options: SeedOptions = {}): Promise<void> {
  const parsed = Uri.parse(uri);
  await index.upsert([
    {
      uri,
      parentUri: parsed.parent()?.toString() ?? '',
      scope: parsed.scope,
      kind: options.kind ?? 'document',
      contextType: options.contextType ?? 'memory',
      memoryType: null,
      level: 'L0',
      abstract: options.abstract ?? null,
      bodyDigest: options.bodyDigest ?? 'seed-digest',
      size: 0,
      updatedAt: UPDATED_AT,
      status: 'active',
      content: '',
    },
  ]);
  db.prepare(
    'UPDATE node SET summary_baseline = ?, summary_pending = ?, summary_entries = ? WHERE uri = ?',
  ).run(options.baseline ?? null, options.pending ?? 0, options.entries ?? 0, uri);
}

interface FreshnessView {
  readonly baseline: string | null;
  readonly pending: number;
  readonly entries: number;
}

function freshness(uri: string): FreshnessView {
  const row = db
    .prepare('SELECT summary_baseline, summary_pending, summary_entries FROM node WHERE uri = ?')
    .get(uri);
  return {
    baseline: typeof row?.['summary_baseline'] === 'string' ? row['summary_baseline'] : null,
    pending: Number(row?.['summary_pending'] ?? 0),
    entries: Number(row?.['summary_entries'] ?? 0),
  };
}

async function summaryFiles(uri: string): Promise<DirectorySummary> {
  const content = await metadata.readSummary(Uri.parse(uri));
  return { abstract: content.abstract, overview: content.overview, degraded: false };
}

function indexRow(uri: string) {
  return nodes.get(uri);
}

/** 记录输入与顺序的生成器；`abstract` 可以按调用序变化。 */
function spyGenerator(
  render: (input: SummaryInput, call: number) => string,
): { readonly generator: SummaryGenerator; readonly inputs: SummaryInput[] } {
  const inputs: SummaryInput[] = [];
  const generator: SummaryGenerator = {
    async generate(input: SummaryInput): Promise<DirectorySummary> {
      inputs.push(input);
      const abstract = render(input, inputs.length);
      return { abstract, overview: `# ${input.uri.name || 'root'}\n\n${abstract}`, degraded: false };
    },
  };
  return { generator, inputs };
}

describe('regenerate', () => {
  it('自底向上：叶子目录 → 父目录 → 根', async () => {
    await makeDirectory(PREFERENCES);
    await makeDirectory(TEAM);
    await writeText(CONVENTIONS, '# 约定\n\n团队约定正文。\n');
    await seedRow(TEAM, { abstract: '团队约定。' });

    const { generator, inputs } = spyGenerator((input) => `${input.uri.name} 摘要`);
    const service = createService({ generator });

    const recomputed = await service.regenerate(Uri.parse(MEMORIES));

    expect(inputs.map((input) => input.uri.toString())).toEqual([TEAM, PREFERENCES, MEMORIES]);
    expect(recomputed).toEqual([TEAM, PREFERENCES, MEMORIES]);
  });

  it('L1 的输入是直接子文件的摘要 + 直接子目录的 L0 正文', async () => {
    await makeDirectory(PREFERENCES);
    await makeDirectory(TEAM);
    await writeText(CONVENTIONS, '# 约定\n\n团队约定正文。\n');
    await writeText(STYLE, '# 风格\n\n代码风格正文。\n');
    // 文件摘要来自索引（§9.1）；目录摘要来自它自己的 .abstract.md。
    await seedRow(TEAM, { kind: 'directory', abstract: '团队约定。' });
    await seedRow(CONVENTIONS, { abstract: '约定摘要。' });
    await seedRow(STYLE, { abstract: '代码风格摘要。' });

    const { generator, inputs } = spyGenerator((input) => `${input.uri.name} 摘要`);
    await createService({ generator }).regenerate(Uri.parse(PREFERENCES));

    // 最后一次调用是 preferences 自己：子文件 code-style.md 的摘要（来自索引）
    // + 子目录 team 的 L0 正文（来自磁盘，且已经是这次刚生成的）。
    const rootInput = inputs.at(-1);
    expect(rootInput?.uri.toString()).toBe(PREFERENCES);
    expect(rootInput?.children.map((child) => [child.name, child.kind, child.abstract])).toEqual([
      ['code-style.md', 'document', '代码风格摘要。'],
      ['team', 'directory', 'team 摘要'],
    ]);
  });

  it('L0 从 L1 提取：模型给的 abstract 被忽略，取 H1 之后的第一段', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');
    await seedRow(STYLE, { abstract: '代码风格摘要。' });

    const generator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        return {
          // 生成器自己给的 abstract 故意是错的：L0 必须从 L1 正文提取（§9.1）。
          abstract: '模型自己编的 L0',
          overview: '# preferences\n\n这个目录放代码风格偏好。\n\n## 快速导航\n\n- `code-style.md`',
          degraded: false,
        };
      },
    };

    await createService({ generator }).regenerate(Uri.parse(PREFERENCES));

    expect((await summaryFiles(PREFERENCES)).abstract).toBe('这个目录放代码风格偏好。');
  });

  it('L1 超过 overviewMaxChars 时截断，L0 不超过 abstractMaxChars', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');

    const generator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        return { abstract: '', overview: `# 标题\n\n${'x'.repeat(100)}`, degraded: false };
      },
    };
    await createService({ generator, config: { abstractMaxChars: 5, overviewMaxChars: 20 } })
      .regenerate(Uri.parse(PREFERENCES));

    const summary = await summaryFiles(PREFERENCES);
    expect(summary.overview).toHaveLength(20);
    expect(summary.abstract).toBe('xxxxx');
  });

  it('目录行的 abstract 与 body_digest 与摘要文件一致', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');

    const generator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        return { abstract: '', overview: '# preferences\n\n一段摘要。', degraded: false };
      },
    };
    await createService({ generator }).regenerate(Uri.parse(PREFERENCES));

    const row = indexRow(PREFERENCES);
    expect(row?.kind).toBe('directory');
    expect(row?.abstract).toBe('一段摘要。');
    expect(row?.bodyDigest).toBe(stableDigest('一段摘要。'));
    expect(row?.level).toBe('L0');
  });

  it('生成期间到达的改动保留：pending 从 5 变 8，消费后是 3', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');
    await seedRow(PREFERENCES, { kind: 'directory', baseline: null, pending: 5, entries: 100 });

    const generator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        // 模拟生成期间又来了三次写：消费时减而不是清零（§9.3）。
        db.prepare('UPDATE node SET summary_pending = 8 WHERE uri = ?').run(PREFERENCES);
        return { abstract: '', overview: '# preferences\n\n摘要。', degraded: false };
      },
    };

    await createService({ generator }).regenerate(Uri.parse(PREFERENCES));

    expect(freshness(PREFERENCES).pending).toBe(3);
    expect(freshness(PREFERENCES).entries).toBe(1);
    expect(freshness(PREFERENCES).baseline).toBe(stableDigest('摘要。'));
  });
});

describe('degraded', () => {
  it('RuleSummarizer 不调模型，结果带 degraded: true', async () => {
    const summarizer = new RuleSummarizer();
    const summary = await summarizer.generate({
      uri: Uri.parse(PREFERENCES),
      children: [
        { uri: Uri.parse(STYLE), name: 'code-style.md', kind: 'document', abstract: '代码风格。第二句。' },
      ],
    });

    expect(summary.degraded).toBe(true);
    expect(summary.overview).toContain('# preferences');
    expect(summary.overview).toContain('- code-style.md：代码风格。');
    // L0 从 L1 正文提取（§9.1），不是另生成一份。
    expect(summary.abstract).toBe('- code-style.md：代码风格。');
  });

  it('LlmSummarizer 调模型，结果带 degraded: false', async () => {
    const provider = new FakeLlmProvider([
      { text: '# preferences\n\n模型摘要。\n\n## 快速导航\n\n- `a.md`' },
      { text: '# preferences\n\n第二次摘要。' },
    ]);
    const summarizer = new LlmSummarizer(new LlmService({ provider, logger }));

    const first = await summarizer.generate({ uri: Uri.parse(PREFERENCES), children: [] });
    expect(first.degraded).toBe(false);
    expect(first.abstract).toBe('模型摘要。');
    expect(provider.calls).toHaveLength(1);

    const second = await summarizer.generate({ uri: Uri.parse(PREFERENCES), children: [] });
    expect(second.abstract).toBe('第二次摘要。');
  });

  it('降级标记写进摘要文件的 frontmatter', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');
    await seedRow(STYLE, { abstract: '代码风格。' });

    const service = createService({ generator: new RuleSummarizer() });
    await service.regenerate(Uri.parse(PREFERENCES));

    // degraded 由 `MetadataFileStore.writeSummary` 写进 frontmatter，控制台的
    // 「监控」页与 `health` 工具读它（§9.2）。
    const raw = await readFile(
      join(dataDir, 'user', 'alice', 'memories', 'preferences', '.abstract.md'),
      'utf8',
    );
    expect(raw).toContain('degraded: true');
    expect((await summaryFiles(PREFERENCES)).abstract).toContain('code-style.md');
    // 落盘不算数，`read` 要把它回填上来：调用方（`GET /content/abstract`）读的是
    // `read` 的返回值，恒为 false 就等于静默降级（§17.9）。
    expect((await service.read(Uri.parse(PREFERENCES)))?.degraded).toBe(true);
  });
});

describe('markStale', () => {
  beforeEach(async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n\n代码风格正文。\n');
  });

  it('索引刚更新过也照常重算——这是批量写入的回归', async () => {
    // 复现 `add_resource` 的顺序：写文件 → 批量 index.upsert → 标脏。
    // `invalidate` 在这一步会比较「正文 digest」与「索引里的 body_digest」，
    // 两者相等就提前返回——文件写了、目录摘要永远不重算，而且不报错。
    const service = createService();
    const writeSummary = vi.spyOn(metadata, 'writeSummary');

    const result = await service.markStale(Uri.parse(PREFERENCES));

    // 自底向上：目录自己先重算，然后逐级向上到 scope 根。
    expect(result.recomputed).toContain(PREFERENCES);
    expect(result.recomputed[0]).toBe(PREFERENCES);
    expect(writeSummary).toHaveBeenCalled();
  });

  it('invalidate 在同样的场景下确实提前返回（对照组）', async () => {
    // 这条钉住两者的差异：不是「markStale 和 invalidate 一样」，而是
    // 「invalidate 在这里什么都不做，所以批量路径必须换入口」。
    const service = createService();
    await index.upsert([
      {
        uri: STYLE,
        parentUri: PREFERENCES,
        scope: 'user',
        kind: 'document',
        contextType: 'memory',
        memoryType: 'preferences',
        level: 'L2',
        abstract: null,
        content: '代码风格正文。',
        bodyDigest: stableDigest('# 风格\n\n代码风格正文。\n'),
        size: 20,
        updatedAt: new Date().toISOString(),
        status: 'active',
      },
    ]);

    const result = await service.invalidate(Uri.parse(STYLE));

    expect(result.recomputed).toEqual([]);
    expect(result.markedStale).toEqual([]);
  });

  it('正文没变不传播：digest 与索引一致时 recomputed 与 markedStale 都为空', async () => {
    const content = await store.readText(Uri.parse(STYLE));
    await seedRow(PREFERENCES, { kind: 'directory', baseline: stableDigest(STABLE_ABSTRACT), entries: 100 });
    await seedRow(STYLE, { bodyDigest: stableDigest(content.text) });

    const service = createService({ generator: new RuleSummarizer() });

    const first = await service.invalidate(Uri.parse(STYLE));
    const second = await service.invalidate(Uri.parse(STYLE));

    for (const result of [first, second]) {
      expect(result.recomputed).toEqual([]);
      expect(result.markedStale).toEqual([]);
      expect(result.stoppedAt).toBe(STYLE);
    }
  });

  it('无基线 → 立刻重算', async () => {
    await seedRow(PREFERENCES, {
      kind: 'directory',
      baseline: null,
      entries: 100,
      bodyDigest: stableDigest(STABLE_ABSTRACT),
    });
    await seedRow(STYLE);

    const { generator } = spyGenerator(() => STABLE_ABSTRACT);
    const result = await createService({ generator }).invalidate(Uri.parse(STYLE));

    expect(result.recomputed).toEqual([PREFERENCES]);
    expect(result.markedStale).toEqual([]);
    expect(result.stoppedAt).toBe(PREFERENCES);
  });

  it('entries <= 32 → 立刻重算', async () => {
    await seedRow(PREFERENCES, {
      kind: 'directory',
      baseline: 'old-baseline',
      entries: 32,
      bodyDigest: stableDigest(STABLE_ABSTRACT),
    });
    await seedRow(STYLE);

    const { generator } = spyGenerator(() => STABLE_ABSTRACT);
    const result = await createService({ generator }).invalidate(Uri.parse(STYLE));

    expect(result.recomputed).toEqual([PREFERENCES]);
    expect(freshness(PREFERENCES).baseline).toBe(stableDigest(STABLE_ABSTRACT));
  });

  it('pending / entries >= 0.10 → 立刻重算', async () => {
    await seedRow(PREFERENCES, {
      kind: 'directory',
      baseline: 'old-baseline',
      entries: 10,
      bodyDigest: stableDigest(STABLE_ABSTRACT),
    });
    await seedRow(STYLE);

    const { generator } = spyGenerator(() => STABLE_ABSTRACT);
    const result = await createService({ generator }).invalidate(Uri.parse(STYLE));

    expect(result.recomputed).toEqual([PREFERENCES]);
    expect(freshness(PREFERENCES).baseline).toBe(stableDigest(STABLE_ABSTRACT));
  });

  it('否则只记脏：recomputed 为空，markedStale 含 P', async () => {
    await seedRow(PREFERENCES, {
      kind: 'directory',
      baseline: 'old-baseline',
      entries: 40,
      bodyDigest: stableDigest(STABLE_ABSTRACT),
    });
    await seedRow(STYLE);

    const { generator, inputs } = spyGenerator(() => STABLE_ABSTRACT);
    const result = await createService({ generator }).invalidate(Uri.parse(STYLE));

    expect(result.recomputed).toEqual([]);
    expect(result.markedStale).toEqual([PREFERENCES]);
    expect(result.stoppedAt).toBe(PREFERENCES);
    expect(inputs).toHaveLength(0);
    expect(freshness(PREFERENCES).pending).toBe(1);
  });

  it('L0 没变就不往上传：祖先不算脏', async () => {
    await makeDirectory(MEMORIES);
    await seedRow(MEMORIES, {
      kind: 'directory',
      baseline: 'root-baseline',
      entries: 5,
      bodyDigest: 'root-digest',
    });
    await seedRow(PREFERENCES, {
      kind: 'directory',
      baseline: 'old-baseline',
      entries: 5,
      bodyDigest: stableDigest(STABLE_ABSTRACT),
    });
    await seedRow(STYLE);

    const { generator, inputs } = spyGenerator(() => STABLE_ABSTRACT);
    const result = await createService({ generator }).invalidate(Uri.parse(STYLE));

    // preferences 重算了（entries <= 32），但 L0 与旧值相同，传播到此为止。
    expect(result.recomputed).toEqual([PREFERENCES]);
    expect(result.markedStale).toEqual([]);
    expect(result.stoppedAt).toBe(PREFERENCES);
    expect(inputs).toHaveLength(1);
    expect(freshness(MEMORIES).pending).toBe(0);
    expect(freshness(MEMORIES).baseline).toBe('root-baseline');
  });

  it('到达 scope 根停止', async () => {
    await makeDirectory(TEAM);
    await writeText(CONVENTIONS, '# 约定\n\n团队约定正文。\n');

    await seedRow(SCOPE_ROOT, { kind: 'directory', baseline: 'root', entries: 5 });
    await seedRow(MEMORIES, { kind: 'directory', baseline: 'memories', entries: 5 });
    await seedRow(PREFERENCES, { kind: 'directory', baseline: 'preferences', entries: 0 });
    await seedRow(TEAM, { kind: 'directory', baseline: 'team', entries: 0 });
    await seedRow(CONVENTIONS);

    // 每次重算都给不同的 L0，保证 L0 一直在变、传播走到底。
    const { generator } = spyGenerator((_input, call) => `第 ${call} 次摘要`);
    const result = await createService({ generator }).invalidate(Uri.parse(CONVENTIONS));

    expect(result.recomputed).toEqual([TEAM, PREFERENCES, MEMORIES, SCOPE_ROOT]);
    expect(result.markedStale).toEqual([]);
    expect(result.stoppedAt).toBe(SCOPE_ROOT);
  });
});

/**
 * 版本快照目录不参与目录摘要（W98）。
 *
 * 每次记忆覆盖写都会新增一份 `.history/...` 版本文件，观察者会对它的父目录投递一次
 * `markStale`。若照常传播，每次覆盖写会多两次摘要生成（`.history` 与它上面的类型
 * 目录），而版本文件从不参与检索。豁免点在 `#invalidateDirectory`：遇到 `.history`
 * 返回 `unchanged`，传播就此止步。
 */
describe('版本快照目录不参与摘要（W98）', () => {
  it('`.history` 直接返回 unchanged：不调生成器、不写摘要文件、不往上传播', async () => {
    await makeDirectory(`${PREFERENCES}/.history`);
    const { generator, inputs } = spyGenerator(() => '不该被生成的摘要');
    const service = createService({ generator });

    const result = await service.markStale(Uri.parse(`${PREFERENCES}/.history`));

    expect(inputs).toEqual([]);
    // 传播走了一步就停：`.history` 自己返回 `unchanged`，类型目录不在结果里。
    expect(result.recomputed).toEqual([`${PREFERENCES}/.history`]);
    expect(result.markedStale).toEqual([]);
    // 类型目录的摘要不会被这次版本写入顺手生成/改写。
    await expect(service.read(Uri.parse(PREFERENCES))).resolves.toBeNull();
  });

  it('`rules` 的镜像子目录（`.history/{scenario}`）同样止步', async () => {
    const rulesHistory = `${SCOPE_ROOT}/memories/rules/.history/backend`;
    await makeDirectory(rulesHistory);
    const { generator, inputs } = spyGenerator(() => '不该被生成的摘要');
    const service = createService({ generator });

    const result = await service.markStale(Uri.parse(rulesHistory));

    expect(inputs).toEqual([]);
    expect(result.recomputed).toEqual([rulesHistory]);
    expect(result.markedStale).toEqual([]);
  });

  it('对照组：同层的普通子目录照常重算', async () => {
    await makeDirectory(TEAM);
    await writeText(CONVENTIONS, '# 约定\n\n目录正文。\n');
    const { generator, inputs } = spyGenerator(() => '普通子目录的摘要');
    const service = createService({ generator });

    const result = await service.markStale(Uri.parse(TEAM));

    expect(inputs.length).toBeGreaterThan(0);
    expect(result.recomputed).toContain(TEAM);
  });
});

describe('锁内不得跨越慢操作（§10.6）', () => {
  it('摘要生成（慢 LLM）期间，另一个写者能拿到子树锁', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n\n代码风格正文。\n');
    await seedRow(STYLE);
    // 目录自己：无基线 → 立刻重算，会走 `#summarize`（慢 LLM）。
    await seedRow(PREFERENCES, { kind: 'directory', baseline: null, entries: 0 });

    let markEntered!: () => void;
    let markFinished!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });

    // 假 summarizer：进入时通知「锁内慢操作开始」，睡 500ms 后返回。
    const slowGenerator: SummaryGenerator = {
      async generate(input: SummaryInput): Promise<DirectorySummary> {
        if (input.uri.toString() === PREFERENCES) {
          markEntered();
          await new Promise((resolve) => setTimeout(resolve, 500));
          markFinished();
        }
        return { abstract: '慢摘要', overview: '# preferences\n\n慢摘要', degraded: false };
      },
    };

    const service = createService({ generator: slowGenerator });
    const invalidation = service.markStale(Uri.parse(PREFERENCES));

    // 等慢生成真正开始（此时若锁覆盖 LLM，EXACT(PREFERENCES) 正被持有）。
    await entered;

    // 另一个写者请求同一子树的 TREE 锁：必须立刻拿到，不能被 500ms 的 LLM 阻塞。
    const t0 = Date.now();
    const release = await locks.acquire(Uri.parse(PREFERENCES), 'tree');
    const waited = Date.now() - t0;
    release();

    // 500ms 的 LLM 若在锁内，这里会等满 ~500ms（或直接 5s 超时抛 CONFLICT）。
    expect(waited).toBeLessThan(250);

    await finished;
    await invalidation;

    // 摘要最终仍然落盘（收敛）。
    expect((await summaryFiles(PREFERENCES)).abstract).toBe('慢摘要');
  });

  it('慢生成期间到达的改动不被吞：pending 归零后再次加回，下一轮再重算', async () => {
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n\n代码风格正文。\n');
    await seedRow(STYLE);
    await seedRow(PREFERENCES, { kind: 'directory', baseline: null, entries: 0 });

    const slowGenerator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { abstract: 'A1', overview: '# preferences\n\nA1', degraded: false };
      },
    };

    const service = createService({ generator: slowGenerator });
    // 生成期间模拟一次并发写把 pending 加回（`markStale` 之外的写者）。
    const inflight = service.markStale(Uri.parse(PREFERENCES));
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare('UPDATE node SET summary_pending = summary_pending + 1 WHERE uri = ?').run(
      PREFERENCES,
    );
    await inflight;

    // 第一段清零 → 慢操作期间的 +1 留下：写回时 consume(快照) 不应把它抹成 0。
    expect(freshness(PREFERENCES).pending).toBe(1);
  });
});

describe('read', () => {
  it('没有摘要文件时返回 null', async () => {
    await makeDirectory(PREFERENCES);

    await expect(createService().read(Uri.parse(PREFERENCES))).resolves.toBeNull();
  });

  it('返回 L0 与 L1 正文', async () => {
    await makeDirectory(PREFERENCES);
    await metadata.writeSummary(Uri.parse(PREFERENCES), '一句话', '# 概览\n\n正文', {
      generatedBy: 'llm',
    });

    await expect(createService().read(Uri.parse(PREFERENCES))).resolves.toEqual({
      abstract: '一句话',
      overview: '# 概览\n\n正文',
      degraded: false,
    });
  });
});

/**
 * 目录的 L1 概览行（§8.5）。
 *
 * 目录在索引里有两行：L0 行只索引 L0 摘要（一句话），L1 行索引概览正文
 * （`overviewMaxChars`，默认 4000 字）。`levelWeights.l1` 在此之前没有任何行可乘，
 * `SearchQuery.levels: ['L1']` 也恒为空。
 */
describe('目录的 L1 概览行', () => {
  /** `node` 表里这个 URI 的全部层级（升序）。 */
  function levelsOf(uri: string): readonly string[] {
    return db
      .prepare('SELECT level FROM node WHERE uri = ? ORDER BY level ASC')
      .all(uri)
      .map((item) => String(item['level']));
  }

  /** `node_fts` 里某一行（按 level 定位）的切分后文本。 */
  function ftsRow(uri: string, level: string): { abstract: string; content: string } | null {
    const row = db
      .prepare('SELECT abstract, content FROM node_fts WHERE uri = ? AND level = ?')
      .get(uri, level);
    return row === undefined
      ? null
      : { abstract: String(row['abstract']), content: String(row['content']) };
  }

  /** 固定概览：L0 从 H1 之后、第一个 H2 之前提取（§9.1）。 */
  const OVERVIEW = [
    '# preferences',
    '',
    '这个目录放代码风格偏好。',
    '',
    '## 快速导航',
    '',
    '- `code-style.md`：提交前跑完整测试',
  ].join('\n');

  async function regenerateWith(overview: string): Promise<void> {
    const generator: SummaryGenerator = {
      async generate(): Promise<DirectorySummary> {
        return { abstract: '', overview, degraded: false };
      },
    };
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');
    await createService({ generator }).regenerate(Uri.parse(PREFERENCES));
  }

  it('写入摘要后有两行：L0 摘要行与 L1 概览行', async () => {
    await regenerateWith(OVERVIEW);
    const summary = await summaryFiles(PREFERENCES);

    expect(levelsOf(PREFERENCES)).toEqual(['L0', 'L1']);

    // L0 行：一句话摘要进 `abstract` 列，`content` 留空。
    expect(ftsRow(PREFERENCES, 'L0')).toEqual({
      abstract: segmentCjk(summary.abstract),
      content: '',
    });
    // L1 行：`content` 是概览正文的切分文本；`abstract` 留空——概览正文已经包含
    // L0 摘要，同一段文字进两列会让 bm25 把同一处匹配算两遍。
    expect(ftsRow(PREFERENCES, 'L1')).toEqual({
      abstract: '',
      content: segmentCjk(summary.overview),
    });
  });

  it('两行的 abstract 相同：检索结果展示的是 L0 摘要，去重按它比较', async () => {
    await regenerateWith(OVERVIEW);
    const summary = await summaryFiles(PREFERENCES);

    const rows = db
      .prepare('SELECT level, abstract FROM node WHERE uri = ? ORDER BY level ASC')
      .all(PREFERENCES)
      .map((item) => [String(item['level']), String(item['abstract'])]);
    expect(rows).toEqual([
      ['L0', summary.abstract],
      ['L1', summary.abstract],
    ]);
  });

  it('重算摘要后 L1 行的概览正文跟着更新', async () => {
    const { generator } = spyGenerator((_input, call) =>
      call === 1 ? '第一版摘要。' : '第二版摘要。',
    );
    await makeDirectory(PREFERENCES);
    await writeText(STYLE, '# 风格\n');
    const service = createService({ generator });

    await service.regenerate(Uri.parse(PREFERENCES));
    expect(ftsRow(PREFERENCES, 'L1')?.content).toContain(segmentCjk('第一版摘要。'));

    await service.regenerate(Uri.parse(PREFERENCES));
    const updated = ftsRow(PREFERENCES, 'L1');
    expect(updated?.content).toContain(segmentCjk('第二版摘要。'));
    expect(updated?.content).not.toContain(segmentCjk('第一版摘要。'));
  });

  it('概览正文里独有的文本能命中 L1 行（L0 摘要里没有它）', async () => {
    await regenerateWith(OVERVIEW);

    const hits = await index.search({
      text: '提交前跑完整测试',
      scopes: [MEMORIES],
      principals: ['user:alice'],
      levels: ['L1'],
      limit: 10,
    });

    expect(hits.map((hit) => [hit.uri, hit.level])).toEqual([[PREFERENCES, 'L1']]);
  });

  it('目录行被索引重建写成空摘要（观察者路径）时，L1 行不会被抹掉', async () => {
    await regenerateWith(OVERVIEW);
    // 观察者写目录自身那一行时 `abstract` / `content` 都是空的（它不生成摘要），
    // 走的是 `index.upsert`（同时写 `node` 与 `node_fts`）。
    await index.upsert([
      {
        uri: PREFERENCES,
        parentUri: MEMORIES,
        scope: 'user',
        kind: 'directory',
        contextType: 'memory',
        memoryType: null,
        level: 'L0',
        abstract: null,
        content: '',
        bodyDigest: stableDigest(''),
        size: 1,
        updatedAt: UPDATED_AT,
        status: 'active',
      },
    ]);

    expect(levelsOf(PREFERENCES)).toEqual(['L0', 'L1']);
    expect(ftsRow(PREFERENCES, 'L1')?.content).toBe(segmentCjk(OVERVIEW));
    // ...而 L0 行按观察者的写法被清空，等下一次摘要重算恢复。
    expect(ftsRow(PREFERENCES, 'L0')).toEqual({ abstract: '', content: '' });
  });
});
