/**
 * 记忆合并的集成测试（架构文档 §11.8）。
 *
 * 用真实容器：真实文件系统（`fs.mkdtemp`）、真实 SQLite 索引、真实 `MemoryService`
 * 与文件锁。唯一的替身是模型——`LlmProvider` 换成一个按轮次返回预设 JSON 的脚本，
 * 否则「第 10 轮还没 finish」这种用例没法稳定复现。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZodType } from 'zod';

import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  ConsolidationService,
  type ConsolidationServiceDeps,
} from '../../../src/services/consolidation.js';

const SUBJECT = 'user:alice';
const PRINCIPALS = [SUBJECT, 'user:*'];
const SCOPE = 'comem://user/alice';
const CODE_STYLE = `${SCOPE}/memories/preferences/code-style.md`;
const CODE_STYLE_LEGACY = `${SCOPE}/memories/preferences/code-style-legacy.md`;
const EDITOR = `${SCOPE}/memories/preferences/editor.md`;

/** 按轮次返回预设 JSON 的模型替身。 */
class ScriptedLlm {
  readonly prompts: LlmPrompt[] = [];
  readonly #responses: readonly unknown[];

  constructor(responses: readonly unknown[]) {
    this.#responses = responses;
  }

  async generateJson<T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T> {
    this.prompts.push(prompt);
    const response = this.#responses[this.prompts.length - 1];
    if (response === undefined) {
      throw new Error(`第 ${this.prompts.length} 轮没有预设响应。`);
    }
    return schema.parse(response);
  }

  /** 全部轮次的 prompt 文本，用于断言「清单里有什么 / 正文有没有进上下文」。 */
  get text(): string {
    return this.prompts
      .flatMap((prompt) => prompt.messages.map((message) => message.content))
      .join('\n');
  }
}

let dataDir: string;
let container: Container;
let locks: ReturnType<typeof createPathLockManager>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-consolidation-'));
  container = await createContainer({
    // 配置从临时目录读：仓库根的 `config.yaml` 可能指向真实网关。
    configPath: join(dataDir, 'config.yaml'),
    subject: SUBJECT,
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
  locks = createPathLockManager({ dataDir, logger: container.logger });
});

afterEach(async () => {
  await container.close();
  await rm(dataDir, { recursive: true, force: true });
});

function createService(llm: ConsolidationServiceDeps['llm']): ConsolidationService {
  return new ConsolidationService({
    memory: container.services.memory,
    search: container.services.search,
    llm,
    locks,
    logger: container.logger,
  });
}

async function writePreference(topic: string, content: string): Promise<void> {
  await container.services.memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
    topic,
    content,
  });
}

async function seedThree(): Promise<void> {
  await writePreference('code-style', '缩进用 2 个空格。');
  await writePreference('code-style-legacy', '缩进用 4 个空格，且不要用 prettier。');
  await writePreference('editor', '默认编辑器是 vim。');
}

async function listMemories(): Promise<readonly string[]> {
  const uris = await container.services.search.glob('**/*.md', {
    scopes: [`${SCOPE}/memories`],
    subject: SUBJECT,
    principals: PRINCIPALS,
    limit: 50,
  });
  return [...uris].sort();
}

describe('ConsolidationService.consolidate', () => {
  it('真实容器：3 条相似记忆合并成 2 条，正文是模型给的合并结果', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'update',
            uri: CODE_STYLE,
            content: '缩进用 2 个空格，统一用 prettier 格式化。',
            reason: 'code-style-legacy 的结论已被 code-style 取代，合并成一条',
          },
          {
            kind: 'delete',
            uri: CODE_STYLE_LEGACY,
            content: null,
            reason: '内容（4 空格 / 不要 prettier）已被 code-style 的结论推翻',
          },
        ],
      },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.adds).toEqual([]);
    expect(result.updates).toEqual([CODE_STYLE]);
    expect(result.deletes).toEqual([CODE_STYLE_LEGACY]);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.action).toBe('finish');
    // 理由必须能被翻出来（「为什么它做了这个决定」）。
    expect(result.trace[0]?.summary).toContain('已被 code-style 取代');

    // 最终条数：3 → 2，且被删的那条真的不在了。
    expect(await listMemories()).toEqual([CODE_STYLE, EDITOR].sort());
    const merged = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(merged?.fields['content']).toBe('缩进用 2 个空格，统一用 prettier 格式化。');
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).toBeNull();
  });

  it('add 落到记忆类型目录下，并出现在最终清单里', async () => {
    await seedThree();
    const newTopic = `${SCOPE}/memories/preferences/spacing.md`;
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'add',
            uri: newTopic,
            content: '缩进一律 2 个空格，禁止 tab。',
            reason: '三条记忆都提到缩进，拆出一条更明确的偏好',
          },
        ],
      },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.adds).toEqual([newTopic]);
    expect(await listMemories()).toEqual([CODE_STYLE, CODE_STYLE_LEGACY, EDITOR, newTopic].sort());
  });

  it('dryRun 默认 true：不写任何东西', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: CODE_STYLE, content: '合并后的正文', reason: '重复' },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被取代' },
        ],
      },
    ]);
    const upsert = vi.spyOn(container.services.memory, 'upsertMemory');
    const remove = vi.spyOn(container.services.memory, 'remove');

    // 不传 dryRun：默认只预览。
    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.updates).toEqual([CODE_STYLE]);
    expect(result.deletes).toEqual([CODE_STYLE_LEGACY]);
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await listMemories()).toEqual([CODE_STYLE, CODE_STYLE_LEGACY, EDITOR].sort());
    const untouched = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(untouched?.fields['content']).toBe('缩进用 2 个空格。');
  });

  it('10 轮还没 finish 抛 RESOURCE_EXHAUSTED，不做部分应用', async () => {
    await seedThree();
    const llm = new ScriptedLlm(
      Array.from({ length: 10 }, () => ({ action: 'read', uris: [CODE_STYLE] })),
    );
    const upsert = vi.spyOn(container.services.memory, 'upsertMemory');
    const remove = vi.spyOn(container.services.memory, 'remove');

    await expect(
      createService(llm).consolidate(Uri.parse(SCOPE), {
        dryRun: false,
        subject: SUBJECT,
        principals: PRINCIPALS,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });

    expect(llm.prompts).toHaveLength(10);
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await listMemories()).toEqual([CODE_STYLE, CODE_STYLE_LEGACY, EDITOR].sort());
  });

  it('read 轮把正文塞进下一轮上下文', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      { action: 'read', uris: [CODE_STYLE] },
      { action: 'finish', operations: [] },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.trace.map((entry) => entry.action)).toEqual(['read', 'finish']);
    expect(result.trace[0]?.readUris).toEqual([CODE_STYLE]);
    expect(llm.text).toContain('缩进用 2 个空格。');
  });

  it('模型幻觉出不存在的 URI：整批拒绝，一个操作都不执行', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: CODE_STYLE, content: '合并后的正文', reason: '合法' },
          {
            kind: 'delete',
            uri: `${SCOPE}/memories/preferences/ghost.md`,
            content: null,
            reason: '幻觉',
          },
        ],
      },
    ]);
    const upsert = vi.spyOn(container.services.memory, 'upsertMemory');
    const remove = vi.spyOn(container.services.memory, 'remove');

    await expect(
      createService(llm).consolidate(Uri.parse(SCOPE), {
        dryRun: false,
        subject: SUBJECT,
        principals: PRINCIPALS,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 合法的那条也没有执行：要么全做，要么全不做。
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await listMemories()).toEqual([CODE_STYLE, CODE_STYLE_LEGACY, EDITOR].sort());
  });

  it('read 请求 scope 外的路径时拒绝（隔离）', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      {
        action: 'read',
        uris: ['comem://user/bob/memories/preferences/code-style.md'],
      },
    ]);

    await expect(
      createService(llm).consolidate(Uri.parse(SCOPE), {
        dryRun: false,
        subject: SUBJECT,
        principals: PRINCIPALS,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('pending 记忆不是合并候选（§11.6 的复核闸门）', async () => {
    await container.services.memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '迁移时先并行跑两套构建。',
    });
    const llm = new ScriptedLlm([]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result).toEqual({ adds: [], updates: [], deletes: [], trace: [] });
    // 清单是空的，连模型调用都不该发生。
    expect(llm.prompts).toHaveLength(0);
  });

  it('不能 add 一条已存在的 pending 记忆（会覆盖它，等于绕过复核闸门）', async () => {
    await seedThree();
    const pendingUri = `${SCOPE}/memories/experiences/monorepo-migration.md`;
    await container.services.memory.upsertMemory(Uri.parse(SCOPE), experiencesMemoryType, {
      topic: 'monorepo-migration',
      content: '迁移时先并行跑两套构建。',
    });
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'add', uri: pendingUri, content: '覆盖待复核记录', reason: '想新增' },
        ],
      },
    ]);
    const upsert = vi.spyOn(container.services.memory, 'upsertMemory');

    await expect(
      createService(llm).consolidate(Uri.parse(SCOPE), {
        dryRun: false,
        subject: SUBJECT,
        principals: PRINCIPALS,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(upsert).not.toHaveBeenCalled();
    const pending = await container.services.memory.read(Uri.parse(pendingUri));
    expect(pending?.status).toBe('pending');
    expect(pending?.fields['content']).toBe('迁移时先并行跑两套构建。');
  });

  it('add 到固定文件名的类型（soul）时整批拒绝：identity 不能由路径推出', async () => {
    await seedThree();
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'add',
            uri: `${SCOPE}/memories/soul.md`,
            content: '先证明再优化。',
            reason: '新增一条核心原则',
          },
        ],
      },
    ]);

    await expect(
      createService(llm).consolidate(Uri.parse(SCOPE), {
        dryRun: false,
        subject: SUBJECT,
        principals: PRINCIPALS,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('HTTP 端点在 memory.consolidation.enabled 为 false 时明确拒绝（不是空结果）', async () => {
    const app = await createHttpServer({
      config: container.config,
      logger: container.logger,
      observability: container.observability,
      routes: container.routes,
      mcp: container.mcp,
      resolveIdentity: container.resolveIdentity,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/consolidate',
        payload: { scope: SCOPE },
      });

      // 默认配置里合并是关的：返回 403 而不是 `{adds: [], ...}`——后者会让
      // 「没开」看起来像「没有可合并的记忆」。
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body) as {
        readonly error: { readonly code: string };
      };
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await app.close();
    }
  });

  it('清单里带 URI 与摘要，不带全文', async () => {
    await seedThree();
    const llm = new ScriptedLlm([{ action: 'finish', operations: [] }]);

    await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    const prompt = llm.text;
    expect(prompt).toContain(CODE_STYLE);
    expect(prompt).toContain(CODE_STYLE_LEGACY);
    expect(prompt).toContain(EDITOR);
    expect(prompt).toContain('缩进用 2 个空格。');
    expect(prompt).toContain('第 1/10 轮');
  });
});
