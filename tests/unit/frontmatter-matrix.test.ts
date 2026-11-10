/**
 * 记忆 frontmatter 的解析矩阵：同一批输入跑遍所有投影，断言结论一致。
 *
 * 记忆文件的 frontmatter 有三个消费方，服务的场景不同：
 *
 * | 投影 | 入口 | 用途 |
 * |---|---|---|
 * | 记忆文档 | `services/memory/document.ts` `parseMemoryDocument` | `read` / 抽取预取 |
 * | 观察者字段 | `services/memory/frontmatter.ts` `parseFrontmatterFields` | 写路径索引（`node.status` / `valid_*`） |
 * | 重建记录 | `commands/reindex/records.ts` `buildRecords` | 从磁盘重建索引行 |
 * | 通用记录 | `adapters/fs/frontmatter.ts` `parseDocument` | 非记忆文件；记忆文件只用来取正文与 `summary` |
 *
 * 前三个是**记忆投影**，必须对同一份文件给出同样的 `status` 与有效期；否则
 * `read` 说「不可解析」、索引却把它当成 `pending`，复核闸门（§11.6）就失效了。
 * 第四个是通用 YAML，比记忆格式宽松；它在前三处只提供正文，矩阵只拿它校验
 * 「服务写出的文件」这一档，宽松输入（单引号、内联注释、块标量）在下面的
 * 「已知差异」里单独钉住。
 *
 * 期望表写死每个输入的正确结论：只对拍「三处一致」不够——三处一起错也能通过。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContentStore } from '../../src/adapters/fs/content-store.js';
import { parseDocument } from '../../src/adapters/fs/frontmatter.js';
import { MetadataFileStore } from '../../src/adapters/fs/metadata-file.js';
import { buildRecords } from '../../src/commands/reindex/records.js';
import { parseStatusField, type NodeStatus, type StatusField } from '../../src/domain/node.js';
import type { IndexRecord } from '../../src/domain/retrieval.js';
import { Uri } from '../../src/domain/uri.js';
import { parseMemoryDocument } from '../../src/services/memory/document.js';
import {
  parseFrontmatterFields,
  type FrontmatterFields,
} from '../../src/services/memory/frontmatter.js';

import { NullLogger } from '../helpers/null-logger.js';

/** 记忆投影的期望值；`null` 表示「不是可解析的记忆」。 */
interface ExpectedMemory {
  readonly memoryType: string;
  readonly status: NodeStatus;
  readonly content: string;
  readonly sources: readonly string[];
  readonly supersedes: string | null;
}

interface MatrixCase {
  readonly name: string;
  /** frontmatter 行（不含首尾 `---`）；`null` = 没有 frontmatter 块 */
  readonly frontmatter: readonly string[] | null;
  /** 正文 */
  readonly body: string;
  readonly lineBreak?: '\n' | '\r\n';
  /** 文件开头写一个 UTF-8 BOM */
  readonly bom?: boolean;
  /** 只有开分隔符、没有闭合（半截 frontmatter） */
  readonly unclosed?: boolean;
  /** 观察者 / reindex 的四个字段 */
  readonly fields: FrontmatterFields;
  readonly memory: ExpectedMemory | null;
}

const ARCHIVE_1 = 'comem://user/alice/sessions/archive_001';
const ARCHIVE_2 = 'comem://user/alice/sessions/archive_002';
const SNAPSHOT = 'comem://user/alice/memories/preferences/.history/legal@2026-10-01T00:00:00.000Z.md';
const CONTENT_BODY = '## content\n\n正文。';

const ACTIVE: StatusField = { kind: 'value', value: 'active' };
const PENDING: StatusField = { kind: 'value', value: 'pending' };
const INVALID: StatusField = { kind: 'invalid' };

const CASES: readonly MatrixCase[] = [
  {
    name: 'legal',
    frontmatter: [
      'memory_type: preferences',
      'status: pending',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-02T00:00:00.000Z',
      'uri: comem://user/alice/memories/preferences/legal',
      'valid_from: 2026-11-01T00:00:00.000Z',
      'valid_until: 2026-12-01T00:00:00.000Z',
      `supersedes: ${SNAPSHOT}`,
      'sources:',
      `  - ${ARCHIVE_1}`,
      `  - ${ARCHIVE_2}`,
      'summary: 偏好',
      'topic: legal',
    ],
    body: CONTENT_BODY,
    fields: {
      memoryType: 'preferences',
      status: PENDING,
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: '2026-12-01T00:00:00.000Z',
    },
    memory: {
      memoryType: 'preferences',
      status: 'pending',
      content: '正文。',
      sources: [ARCHIVE_1, ARCHIVE_2],
      supersedes: SNAPSHOT,
    },
  },
  {
    name: 'missing-validity-and-sources',
    frontmatter: [
      'memory_type: preferences',
      'status: active',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-01T00:00:00.000Z',
    ],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'invalid-status-case',
    frontmatter: ['memory_type: preferences', 'status: Archived'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: INVALID, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    // YAML 的空值：服务子集读成 `[]`、通用 YAML 读成 `null`，两边都必须落 invalid。
    name: 'invalid-status-empty',
    frontmatter: ['memory_type: preferences', 'status:'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: INVALID, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    name: 'invalid-status-number',
    frontmatter: ['memory_type: preferences', 'status: 1'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: INVALID, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    name: 'invalid-status-null',
    frontmatter: ['memory_type: preferences', 'status: null'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: INVALID, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    name: 'invalid-dates',
    frontmatter: ['memory_type: preferences', 'status: active', 'valid_from: not-a-date', 'valid_until: 2026-13-45'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    // 手改成数字：`2026` 在 V8 里能 `Date.parse` 成 2026-01-01，三处都必须读作无界。
    name: 'numeric-dates',
    frontmatter: ['memory_type: preferences', 'status: active', 'valid_from: 2026', 'valid_until: 123'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    // 带时区偏移：归一化成 UTC，索引列与过滤边界按 TEXT 比较。
    name: 'offset-date',
    frontmatter: ['memory_type: preferences', 'status: active', 'valid_from: 2026-11-10T09:00:00+08:00'],
    body: CONTENT_BODY,
    fields: {
      memoryType: 'preferences',
      status: ACTIVE,
      validFrom: '2026-11-10T01:00:00.000Z',
      validUntil: null,
    },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'empty-sources-flow',
    frontmatter: ['memory_type: preferences', 'status: active', 'sources: []'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'empty-sources-block',
    frontmatter: ['memory_type: preferences', 'status: active', 'sources:'],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'unknown-fields',
    frontmatter: [
      'memory_type: preferences',
      'status: active',
      'generated_by: summary.service',
      'summary_state: stale',
    ],
    body: CONTENT_BODY,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'double-quoted',
    frontmatter: [
      'memory_type: "preferences"',
      'status: "pending"',
      'valid_from: "2026-11-01T00:00:00.000Z"',
    ],
    body: CONTENT_BODY,
    fields: {
      memoryType: 'preferences',
      status: PENDING,
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: null,
    },
    memory: {
      memoryType: 'preferences',
      status: 'pending',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'crlf',
    frontmatter: ['memory_type: preferences', 'status: pending'],
    body: '## content\r\n\r\n正文。',
    lineBreak: '\r\n',
    fields: { memoryType: 'preferences', status: PENDING, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'pending',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'bom',
    frontmatter: ['memory_type: preferences', 'status: active'],
    body: CONTENT_BODY,
    bom: true,
    fields: { memoryType: 'preferences', status: ACTIVE, validFrom: null, validUntil: null },
    memory: {
      memoryType: 'preferences',
      status: 'active',
      content: '正文。',
      sources: [],
      supersedes: null,
    },
  },
  {
    name: 'no-frontmatter',
    frontmatter: null,
    body: '# 标题\n\n正文。\n',
    fields: { memoryType: null, status: { kind: 'absent' }, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    name: 'unclosed',
    frontmatter: ['memory_type: preferences', 'status: pending'],
    body: CONTENT_BODY,
    unclosed: true,
    fields: { memoryType: null, status: { kind: 'absent' }, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    name: 'not-a-memory',
    frontmatter: ['status: pending', 'summary: 普通文档'],
    body: '# 标题\n',
    fields: { memoryType: null, status: PENDING, validFrom: null, validUntil: null },
    memory: null,
  },
  {
    // 空串不是记忆类型：`MemoryDocument` 以前会返回一条 `memoryType = ''` 的记忆，
    // 观察者与 `reindex` 却读作「不是记忆」——三处现在统一按「没有类型」处理。
    name: 'empty-memory-type',
    frontmatter: ['memory_type: ""', 'status: pending'],
    body: CONTENT_BODY,
    fields: { memoryType: null, status: PENDING, validFrom: null, validUntil: null },
    memory: null,
  },
];

function documentOf(entry: MatrixCase): string {
  const lineBreak = entry.lineBreak ?? '\n';
  const text =
    entry.frontmatter === null
      ? entry.body
      : ['---', ...entry.frontmatter, '---', '', entry.body].join(lineBreak);
  const withClosing = entry.unclosed === true ? ['---', ...(entry.frontmatter ?? [])].join(lineBreak) : text;
  return (entry.bom === true ? '\uFEFF' : '') + withClosing;
}

let dataDir: string;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: NullLogger;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-frontmatter-matrix-'));
  logger = new NullLogger();
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** 链路三：从磁盘重建出来的那行索引。 */
async function reindexRecord(name: string, raw: string): Promise<IndexRecord> {
  const uri = Uri.parse(`comem://user/alice/memories/preferences/${name}.md`);
  await store.writeBytes(uri, Uint8Array.from(Buffer.from(raw, 'utf8')));
  const records = await buildRecords(
    store,
    metadata,
    logger,
    { uri, kind: 'file' },
    null,
    parseDocument(raw),
    raw,
  );
  const record = records[0];
  if (record === undefined) {
    throw new Error(`没有为 ${name} 生成索引行`);
  }
  return record;
}

describe('记忆 frontmatter 解析矩阵', () => {
  it.each(CASES)('$name：三个记忆投影对同一输入给出一致的 status / 有效期', async (entry) => {
    const raw = documentOf(entry);

    // 1) 观察者字段：期望表写死。
    const fields = parseFrontmatterFields(raw);
    expect(fields).toEqual(entry.fields);

    // 2) 记忆文档：不是可解析记忆时返回 null；否则字段与观察者同一份。
    const memory = parseMemoryDocument(raw);
    if (entry.memory === null) {
      expect(memory).toBeNull();
    } else {
      expect(memory).not.toBeNull();
      expect(memory?.memoryType).toBe(entry.memory.memoryType);
      expect(memory?.status).toBe(entry.memory.status);
      expect(memory?.sources).toEqual(entry.memory.sources);
      expect(memory?.supersedes).toBe(entry.memory.supersedes);
      expect(memory?.fields['content']).toBe(entry.memory.content);
      // 有效期与观察者是同一列（索引按 TEXT 比较，两处必须同一个归一化形态）。
      expect(memory?.validFrom).toBe(fields.validFrom);
      expect(memory?.validUntil).toBe(fields.validUntil);
    }

    // 3) 重建记录：`status` / 有效期 / `memoryType` 都由上面四个字段推出。
    const record = await reindexRecord(entry.name, raw);
    const invalidStatus = fields.status.kind === 'invalid';
    expect(record.status).toBe(fields.status.kind === 'value' ? fields.status.value : 'active');
    expect(record.memoryType).toBe(invalidStatus ? null : (fields.memoryType ?? null));
    expect(record.validFrom).toBe(fields.validFrom);
    expect(record.validUntil).toBe(fields.validUntil);
    // 正文与摘要来自通用记录（记忆投影不负责这两列）。
    expect(record.content).toBe(parseDocument(raw).body);
  });

  it.each(CASES)('$name：通用 YAML 记录与记忆投影在服务写出的形态上一致', (entry) => {
    // 宽松输入（单引号 / 内联注释 / 块标量）不在这一档，见下面的「已知差异」。
    const raw = documentOf(entry);
    const generic = parseDocument(raw);
    expect(generic.hasFrontmatter).toBe(entry.frontmatter !== null && entry.unclosed !== true);

    const genericStatus = parseStatusField(generic.data['status']);
    expect(genericStatus).toEqual(entry.fields.status);
    expect(typeof generic.data['memory_type'] === 'string' && generic.data['memory_type'] !== '').toBe(
      entry.fields.memoryType !== null,
    );
    expect(parseFrontmatterFields(raw).validFrom).toBe(entry.fields.validFrom);
    expect(parseFrontmatterFields(raw).validUntil).toBe(entry.fields.validUntil);
  });
});

describe('已知差异：通用 YAML 比记忆子集宽松', () => {
  /**
   * 记忆文件由 `serializeMemoryDocument` 写出：字符串一律双引号 + JSON 转义，
   * 数组用块序列。单引号、内联注释、块标量是**手改**输入，不在服务写出的形态里。
   * 三个记忆投影对它们统一按「键存在但值不可用」处理（`invalid`）——这样手误
   * 不会绕过复核闸门；通用 YAML 会把它读成合法值，但通用记录只用来取正文与
   * `summary`，不参与 `status` 判定。
   */
  it.each([
    {
      name: '单引号',
      document: '---\nmemory_type: preferences\nstatus: \'pending\'\n---\n',
    },
    {
      name: '内联注释',
      document: '---\nmemory_type: preferences\nstatus: pending # 手改\n---\n',
    },
  ])('$name：记忆三投影读作 invalid，通用 YAML 读作合法值', async ({ name, document: raw }) => {
    expect(parseFrontmatterFields(raw).status).toEqual(INVALID);
    expect(parseMemoryDocument(raw)).toBeNull();
    const record = await reindexRecord(name, raw);
    expect(record.status).toBe('active');
    expect(record.memoryType).toBeNull();

    // 差异本身钉住：通用 YAML 认得出这是一个合法状态。
    expect(parseStatusField(parseDocument(raw).data['status'])).toEqual(PENDING);
  });

  it('块标量：记忆子集不支持，按不可解析处理；通用 YAML 能读', () => {
    const raw = '---\nmemory_type: preferences\nstatus: active\nsummary: |\n  第一行\n  第二行\n---\n正文';

    expect(parseDocument(raw).data['summary']).toBe('第一行\n第二行\n');
    expect(() => parseFrontmatterFields(raw)).toThrow();
    expect(() => parseMemoryDocument(raw)).toThrow();
  });
});
