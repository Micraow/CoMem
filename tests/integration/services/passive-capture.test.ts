/**
 * 「被动捕获」的端到端复现（README 的「🎣 被动捕获，零负担」）。
 *
 * 用户报告：**显式让模型「用 comem 记住」有效**（`remember` 工具，最终写进
 * `user/{uid}/memories/profile.md`），**开新对话框什么都不提就记不下来**。
 *
 * 这份用例把两条路并排放：
 *
 * 1. 被动：一段普通的 Codex 会话（没有任何「记住 / remember / comem」意图）走
 *    `IngestService.run()` 的完整链路——发现会话、落消息、`commitPhase1` 归档、
 *    阶段二五个步骤、写盘。
 * 2. 对照：同样的会话内容，最后一句是「用 comem 记住这件事」，走 MCP `remember`
 *    工具，再驱动阶段二。
 *
 * ## 为什么用真实容器、只替换模型
 *
 * `AGENTS.md` §9：六条核心链路不受「探索期」豁免。会话归档、记忆抽取、补丁合并、
 * 摘要失效、ACL 过滤在这里都是**真实实现**：`fs.mkdtemp()` + 真实 SQLite 文件 +
 * 真实 `CommitRunner`。唯一替身是 `LlmProvider`——测试里没有可用模型，也不该让
 * 用例依赖外网。假模型走生产同一条 HTTP 路径（`tests/helpers/fake-llm-http.ts`），
 * 不在服务层塞假 provider。
 *
 * ## 假模型不是「跳过中间环节」
 *
 * 假模型返回的抽取结果，是按本机真实网关（`config.yaml` 的 `127.0.0.1:3425`）
 * 对同一段会话的实际输出抄下来的：一条 `events`（决策）+ 一条 `experiences`
 * （经验归纳）。这样断言的是**生产接线**，不是「假模型想让它写什么」。
 *
 * ## 测试环境触发不了的那一步
 *
 * 真正的「开新对话框」在生产里由宿主 Hook（`integrations/servers/stop.mjs` 的
 * `Stop`）在每轮结束时调 `POST /sessions/{id}/commit` 触发。测试里没有宿主进程，
 * 无法触发 Hook；最后一份用例改用 `SessionService` + `Scheduler.tick()` 直接调
 * 调度器，验证「没有 Hook 时，默认阈值下短会话根本不会被提交」。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toDiskPath } from '../../../src/adapters/fs/path.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import { rememberTool } from '../../../src/api/mcp/tools/remember.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { runIngest } from '../../../src/commands/ingest.js';
import type { IngestReport } from '../../../src/services/ingest.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';
import { NullLogger } from '../../helpers/null-logger.js';

const SCOPE = 'comem://user/local';
const SUBJECT = 'user:local';
const PRINCIPALS: readonly string[] = [SUBJECT, 'user:*'];

/** 会话里的普通项目讨论。没有任何「记住 / remember / comem」这类显式意图。 */
const CONVERSATION: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[] = [
  { role: 'user', text: '我们在重构支付模块，决定把重试放到网关层。' },
  {
    role: 'assistant',
    text: '明白。网关层统一重试，业务层不再各自实现重试。',
  },
  { role: 'user', text: '对，另外超时设成 3 秒，重试两次。' },
  {
    role: 'assistant',
    text: '好的，网关层超时 3 秒、重试 2 次，幂等键由业务层透传。',
  },
];

/** 显式意图：同一段会话 + 最后一句「用 comem 记住这件事」。 */
const EXPLICIT_TAIL = { role: 'user' as const, text: '用 comem 记住这件事。' };

/** 本机真实网关对上面这段会话的抽取结果（`memory_operations.json` 的原文）。 */
const EXTRACTED_EVENT = {
  kind: 'upsert',
  pageId: 100,
  type: 'events',
  identity: { event: '2026-11-10-payment-gateway-retry-decision' },
  operations: [
    {
      kind: 'replace',
      field: 'event',
      value: '2026-11-10-payment-gateway-retry-decision',
    },
    { kind: 'immutable', field: 'occurredAt', value: '2026-11-10' },
    {
      kind: 'immutable',
      field: 'content',
      value: '支付模块重构决定：重试统一放到网关层，业务层不再各自实现重试；网关超时 3 秒、重试 2 次，幂等键由业务层透传。',
    },
    { kind: 'replace', field: 'updatedAt', value: '2026-11-10' },
  ],
} as const;

/** 本机真实网关的经验归纳结果。`experiences` 默认 `reviewRequired`，写入即 pending。 */
const DISTILLED_EXPERIENCE = {
  topic: 'payment-gateway-retry-design',
  content:
    '支付模块重构中确定的重试方案：重试统一放在网关层实现，业务层不再各自实现重试逻辑。\n\n' +
    '- 网关层超时时间：3 秒\n- 重试次数：2 次\n- 幂等键：由业务层生成并透传，网关重试时复用同一个幂等键。',
} as const;

/** 对照用例的抽取结果：显式「记住」时期望落到画像。 */
const EXTRACTED_PROFILE = {
  kind: 'upsert',
  pageId: 100,
  type: 'profile',
  identity: { name: 'local' },
  operations: [
    { kind: 'replace', field: 'name', value: 'local' },
    {
      kind: 'replace',
      field: 'content',
      value: '- 支付模块重构负责人，决定重试放到网关层 (as of 2026-11-10)',
    },
  ],
} as const;

const EVENT_URI = `${SCOPE}/memories/events/2026-11-10-payment-gateway-retry-decision.md`;
const EXPERIENCE_URI = `${SCOPE}/memories/experiences/payment-gateway-retry-design.md`;
const PROFILE_URI = `${SCOPE}/memories/profile.md`;

let dataDir: string;
let codexDir: string;
let llm: FakeLlmHttp | undefined;
let container: Container | undefined;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** 写一份 Codex 的 rollout JSONL：格式与 `src/ingest/sources/codex.ts` 一致。 */
async function writeCodexSession(
  messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[],
): Promise<void> {
  const sessionId = '01a036e1-6764-77e0-b613-54e99ba2a762';
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    join(codexDir, `rollout-2026-11-10T10-00-00-${sessionId}.jsonl`),
    [
      line({
        timestamp: '2026-11-10T02:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: sessionId, cwd: '/work/payments' },
      }),
      ...messages.map((message, index) =>
        line({
          timestamp: `2026-11-10T02:00:${String(index + 1).padStart(2, '0')}.000Z`,
          type: 'response_item',
          payload: {
            type: 'message',
            role: message.role,
            content: [
              {
                type: message.role === 'user' ? 'input_text' : 'output_text',
                text: message.text,
              },
            ],
          },
        }),
      ),
    ].join(''),
    'utf8',
  );
}

/**
 * 假模型：按系统提示词区分两个 `generateJson` 调用点。
 *
 * 抽取（`记忆抽取器`）返回 `extraction`，经验归纳（`经验归纳器`）返回
 * `experiences`。摘要走 `summary.generator: rule`，不调模型。
 */
async function startModel(options: {
  readonly extraction: unknown;
  readonly experiences?: unknown;
}): Promise<FakeLlmHttp> {
  return startFakeLlmHttp((body) =>
    body.includes('经验归纳器')
      ? JSON.stringify(options.experiences ?? { experiences: [] })
      : JSON.stringify(options.extraction),
  );
}

async function writeConfig(
  baseUrl: string,
  extra: readonly string[] = [],
): Promise<string> {
  const configPath = join(dataDir, 'config.yaml');
  await writeFile(
    configPath,
    [
      `dataDir: ${dataDir}`,
      'providers:',
      '  llm:',
      '    default:',
      '      type: openai-compatible',
      `      baseUrl: ${baseUrl}`,
      '      model: fake',
      '      apiKey: test',
      '      maxTokens: 4096',
      '      timeoutSeconds: 30',
      'summary:',
      '  generator: rule',
      'retrieval:',
      '  engine: fts5',
      ...extra,
      'ingest:',
      '  enabled: true',
      '  extractionBatchSize: 20',
      '  paths:',
      '    codex:',
      `      - ${codexDir}`,
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

/** 读归档目录里的 JSON 文件。 */
async function readArchiveJson(archiveUri: string, file: string): Promise<unknown> {
  const path = join(toDiskPath(dataDir, Uri.parse(archiveUri)), file);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function requireReportExtraction(report: IngestReport): {
  readonly skipped: false;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly memoriesExtracted: number;
  readonly memoriesPendingReview: number;
} {
  const extraction = report.extraction;
  if (extraction === null || extraction.skipped) {
    throw new Error(`预期阶段二真的跑了，实际是 ${JSON.stringify(extraction)}`);
  }
  return extraction;
}

/** 本次导入的会话归档 URI：`dataDir/user/local/sessions/sess_xxx/history/archive_001`。 */
async function archiveUriOfSession(): Promise<string> {
  const sessions = await readdir(join(dataDir, 'user', 'local', 'sessions'));
  const session = sessions.find((name) => name.startsWith('sess_'));
  if (session === undefined) {
    throw new Error('导入之后没有会话目录');
  }
  return `${SCOPE}/sessions/${session}/history/archive_001`;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-passive-data-'));
  codexDir = await mkdtemp(join(tmpdir(), 'comem-passive-codex-'));
  llm = undefined;
  container = undefined;
});

afterEach(async () => {
  await container?.close();
  container = undefined;
  await llm?.close();
  llm = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(codexDir, { recursive: true, force: true });
});

describe('被动捕获：普通 Codex 会话 → 记忆（真实容器 + 假模型）', () => {
  it('没有任何「记住」意图，ingest 归档后磁盘上出现一条可检索的 events 记忆', async () => {
    await writeCodexSession(CONVERSATION);
    llm = await startModel({ extraction: { operations: [EXTRACTED_EVENT] } });
    const configPath = await writeConfig(llm.baseUrl);

    const report = await runIngest({ configPath, dataDir, source: 'codex' });

    // ── 1. 会话文件被读到了 ──
    expect(report.harnesses.map((source) => source.discovered)).toEqual([1]);
    expect(report.harnesses[0]?.imported).toBe(1);
    expect(report.harnesses[0]?.messages).toBe(CONVERSATION.length);

    // ── 2. 阶段二跑了，没有被跳过 ──
    const extraction = requireReportExtraction(report);
    expect(extraction.skipped).toBe(false);
    expect(extraction.tasksCompleted).toBe(1);
    expect(extraction.tasksFailed).toBe(0);
    expect(extraction.memoriesExtracted).toBeGreaterThanOrEqual(1);

    // ── 3. 归档产物齐全，五个步骤都记在 stepsDone 里 ──
    const archiveUri = await archiveUriOfSession();
    const meta = await readArchiveJson(archiveUri, '.meta.json');
    expect(meta).toMatchObject({
      stepsDone: [
        'archive_summary',
        'memory_extract',
        'memory_merge',
        'summary_invalidate',
        'experience_distill',
      ],
      skippedSteps: [],
    });
    const operations = (await readArchiveJson(archiveUri, 'memory_operations.json')) as {
      readonly operations: readonly unknown[];
    };
    expect(operations.operations.length).toBeGreaterThan(0);
    const diff = (await readArchiveJson(archiveUri, 'memory_diff.json')) as {
      readonly operations: { readonly adds: readonly { readonly uri: string }[] };
    };
    expect(diff.operations.adds.map((entry) => entry.uri)).toContain(EVENT_URI);
    await expect(stat(join(toDiskPath(dataDir, Uri.parse(archiveUri)), '.done'))).resolves.toBeDefined();

    // ── 4. 磁盘上真的有一条记忆，且状态是 active ──
    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });
    const event = await container.services.memory.read(Uri.parse(EVENT_URI));
    expect(event?.status).toBe('active');
    expect(event?.fields['content']).toContain('重试统一放到网关层');

    // ── 5. 它出现在检索结果里（单关键词；多词查询是另一个已知缺口）──
    const hits = await container.services.search.find('幂等键', {
      scopes: [`${SCOPE}/memories`],
      subject: SUBJECT,
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toContain(EVENT_URI);
  });

  it('experience_distill 写的 experiences 是 pending：不点「复核」就检索不到', async () => {
    await writeCodexSession(CONVERSATION);
    llm = await startModel({
      extraction: { operations: [EXTRACTED_EVENT] },
      experiences: { experiences: [DISTILLED_EXPERIENCE] },
    });
    const configPath = await writeConfig(llm.baseUrl);

    await runIngest({ configPath, dataDir, source: 'codex' });

    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });

    // 经验记忆确实落盘了，但状态是 pending（`memory.reviewRequired` 含 experiences）。
    const experience = await container.services.memory.read(Uri.parse(EXPERIENCE_URI));
    expect(experience?.status).toBe('pending');

    // 复核闸门：pending 不进检索结果。
    const hits = await container.services.search.find('幂等键', {
      scopes: [`${SCOPE}/memories`],
      subject: SUBJECT,
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).not.toContain(EXPERIENCE_URI);

    // 它在待复核列表里，只能通过 `approve` 才会出现在检索面。
    const pending = await container.services.memory.listPending(Uri.parse(SCOPE));
    expect(pending.map((record) => record.uri.toString())).toContain(EXPERIENCE_URI);
  });

  /**
   * 报告字段与磁盘状态必须一致。
   *
   * `ExtractionRunnerImpl`（`src/commands/ingest.ts`）只从 `memory_diff.json` 的
   * `adds` / `updates` 统计待复核记忆，而 `experience_distill` 的产物**不写**
   * `memory_diff.json`——它的产物是磁盘上的经验文件。结果是：报告说
   * `memoriesPendingReview: 0`，磁盘上却有一份 `status: pending` 的经验。
   *
   * 用户看到「0 条待复核」就不会去复核，这条经验永远停在待复核里。这条用例断言
   * 的是报告与磁盘一致；当前实现下它会失败，失败本身就是结论。
   */
  it('报告里的 memoriesPendingReview 必须等于磁盘上待复核的记忆条数', async () => {
    await writeCodexSession(CONVERSATION);
    llm = await startModel({
      extraction: { operations: [EXTRACTED_EVENT] },
      experiences: { experiences: [DISTILLED_EXPERIENCE] },
    });
    const configPath = await writeConfig(llm.baseUrl);

    const report = await runIngest({ configPath, dataDir, source: 'codex' });
    const extraction = requireReportExtraction(report);

    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });
    const pending = await container.services.memory.listPending(Uri.parse(SCOPE));

    // 磁盘真相：1 条 active（events，来自 `memory_extract` + `memory_merge`）
    // + 1 条 pending（experiences，来自 `experience_distill`）。
    expect(pending.map((record) => record.uri.toString())).toEqual([EXPERIENCE_URI]);

    // 报告必须与磁盘一致。当前实现下是 0 / 1——两个计数都只看得见
    // `memory_diff.json` 里的那一条 events。
    expect(extraction.memoriesPendingReview).toBe(pending.length);
    expect(extraction.memoriesExtracted).toBe(pending.length + 1);
  });
});

describe('对照：显式 remember → 画像', () => {
  it('同样会话 + 最后一句「用 comem 记住这件事」，remember 工具把 profile 写到磁盘', async () => {
    llm = await startModel({
      extraction: { operations: [EXTRACTED_PROFILE] },
    });
    const configPath = await writeConfig(llm.baseUrl, [
      'session:',
      '  autoCommit:',
      '    enabled: false',
    ]);

    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });

    const context: McpToolContext = {
      filesystem: container.services.filesystem,
      search: container.services.search,
      summary: container.services.summary,
      acl: container.services.acl,
      session: container.services.session,
      memory: container.services.memory,
      observability: container.observability,
      resource: container.services.resource,
      skill: container.services.skill,
      tasks: container.services.task,
      index: container.services.index,
      logger: new NullLogger(),
      config: container.config,
      subject: SUBJECT,
      principals: PRINCIPALS,
      requestId: 'passive-capture-control',
    };

    const result = await rememberTool.execute(
      {
        messages: [...CONVERSATION, EXPLICIT_TAIL].map((message) => ({
          role: message.role,
          content: message.text,
          createdAt: '2026-11-10T02:00:00.000Z',
        })),
      },
      context,
    );
    if (result.type !== 'text') {
      throw new Error(`remember 应返回文本结果，实际是 ${result.type}`);
    }
    expect(result.text).toContain('taskId:');

    // `remember` 只做阶段一（归档 + 建任务）。阶段二由 `CommitRunner` 认领，
    // 测试里直接驱动一轮。
    await container.commitRunner.tick();

    const profile = await container.services.memory.read(Uri.parse(PROFILE_URI));
    expect(profile?.status).toBe('active');
    expect(profile?.fields['content']).toContain('支付模块重构负责人');

    // 画像不在 `reviewRequired` 里，立刻可检索。
    const hits = await container.services.search.find('支付模块', {
      scopes: [`${SCOPE}/memories`],
      subject: SUBJECT,
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toContain(PROFILE_URI);
  });
});

describe('实时会话：没有宿主 Hook 时的自动提交', () => {
  /**
   * 「开新对话框什么都不提」在生产里靠宿主 `Stop` Hook 每轮提交；没有 Hook 时
   * 只剩服务端调度器的 `shouldAutoCommit`。默认阈值是 150000 token / 100 条消息，
   * `idleTimeoutSeconds` 为 0（关）——一段四句话的新会话一条都不满足。
   *
   * 这一份不是 `IngestService`：Hook 进程在测试里不可触发（见文件头），所以直接调
   * `SessionService` + `Scheduler.tick()`，断言「会话没被提交，因此也没有记忆」。
   */
  it('默认 autoCommit 下，4 条消息的新会话不会被自动提交，阶段二不会发生', async () => {
    llm = await startModel({ extraction: { operations: [EXTRACTED_EVENT] } });
    const configPath = await writeConfig(llm.baseUrl);

    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });

    const session = container.services.session;
    const sessionUri = await session.create(Uri.parse(SCOPE), PRINCIPALS);
    for (const [index, message] of CONVERSATION.entries()) {
      await session.addMessage(sessionUri, {
        id: `m${String(index)}`,
        role: message.role,
        parts: [{ kind: 'text', text: message.text }],
        createdAt: `2026-11-10T02:00:0${String(index)}.000Z`,
      });
    }

    // 前提：pending 内容远低于默认阈值。
    const before = await session.load(sessionUri);
    expect(before.messageCount).toBe(CONVERSATION.length);
    expect(before.pendingTokens).toBeLessThan(150000);

    const result = await container.scheduler.tick();
    expect(result.committed).toBe(0);

    // 没有归档、没有任务、没有记忆：被动捕获停在了「提交」这一步之前。
    expect(await session.listArchives(sessionUri)).toEqual([]);
    expect(container.services.task.claimable()).toEqual([]);
    await expect(
      container.services.memory.read(Uri.parse(EVENT_URI)),
    ).resolves.toBeNull();
  });
});
