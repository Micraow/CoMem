/**
 * 记忆合并的集成测试（架构文档 §11.8）。
 *
 * 用真实容器：真实文件系统（`fs.mkdtemp`）、真实 SQLite 索引、真实 `MemoryService`
 * 与文件锁。唯一的替身是模型——`LlmProvider` 换成一个按轮次返回预设 JSON 的脚本，
 * 否则「第 10 轮还没 finish」这种用例没法稳定复现。
 */

import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZodType } from 'zod';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { profileMemoryType } from '../../../src/domain/memory-types/profile.js';
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
const PROFILE = `${SCOPE}/memories/profile.md`;

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
let contentStore: ContentStore;

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
  // 生产装配注入的是 `ContentStore`（`container.ts` 的 `stat: store`）：文件系统
  // 层面的存在性 / 类型，不解析 frontmatter。测试用同一个真实适配器，不手写替身。
  contentStore = new ContentStore({ dataDir, logger: container.logger });
});

afterEach(async () => {
  await container.close();
  await rm(dataDir, { recursive: true, force: true });
});

function createService(llm: ConsolidationServiceDeps['llm']): ConsolidationService {
  return new ConsolidationService({
    memory: container.services.memory,
    stat: contentStore,
    search: container.services.search,
    llm,
    logger: container.logger,
  });
}

async function writePreference(topic: string, content: string): Promise<void> {
  await container.services.memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
    topic,
    content,
  });
}

/** 写一条带溯源（`sources`）的偏好：合并要把这些归档 URI 继承下去。 */
async function writePreferenceWithSources(
  topic: string,
  content: string,
  sources: readonly string[],
): Promise<void> {
  await container.services.memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
    uri: Uri.parse(`${SCOPE}/memories/preferences/${topic}.md`),
    update: (current) => ({ ...current, topic, content }),
    provenance: { sources: sources.map((source) => Uri.parse(source)) },
  });
}

/** 写一条画像：固定文件名，identity `name` 不出现在路径里。 */
async function writeProfile(): Promise<void> {
  await container.services.memory.upsertMemory(Uri.parse(SCOPE), profileMemoryType, {
    name: 'Alice',
    role: '后端工程师',
    content: '先给结论。',
  });
}

/** 直接改磁盘上的记忆文件：模拟手工改坏的 frontmatter。 */
async function editFrontmatter(uri: string, pattern: RegExp, replacement: string): Promise<void> {
  const path = toDiskPath(dataDir, Uri.parse(uri));
  const raw = await readFile(path, 'utf8');
  await writeFile(path, raw.replace(pattern, replacement), 'utf8');
}

/** 跑一次真实写盘的合并，把整批失败的错误取出来（成功时返回 `null`）。 */
async function consolidateCapturingFailure(
  llm: ConsolidationServiceDeps['llm'],
): Promise<unknown> {
  return createService(llm)
    .consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : '';
}

async function seedThree(): Promise<void> {
  await writePreference('code-style', '缩进用 2 个空格。');
  await writePreference('code-style-legacy', '缩进用 4 个空格，且不要用 prettier。');
  await writePreference('editor', '默认编辑器是 vim。');
}

/**
 * 磁盘上的全部 `.md`（路径面）：`tree` 按磁盘枚举，包含 `.history/` 下的版本快照。
 *
 * 不用 `search.glob`：`glob` / `grep` 是检索面，索引 SQL 已经按路径段排除整个
 * `.history` 子树（架构文档 §8.4）。
 */
async function listMemoryFiles(): Promise<readonly string[]> {
  const { entries } = await container.services.filesystem.tree(
    Uri.parse(`${SCOPE}/memories`),
    PRINCIPALS,
    { depth: 5, limit: 1000 },
  );
  return entries
    .filter((entry) => entry.kind === 'file' && entry.uri.name.endsWith('.md'))
    .map((entry) => entry.uri.toString())
    .sort();
}

async function listMemories(): Promise<readonly string[]> {
  // `.history` 里是记忆的版本快照（W98），「剩下几条记忆」问的是 identity，
  // 不是历史版本。判据按路径段：文件名是 `.history.md` 的普通记忆照常算一条。
  return (await listMemoryFiles()).filter((uri) => !uri.includes('/.history/'));
}

/** `.history/` 下真实存在的版本快照 URI。用于先钉住「夹具真的产生了版本」。 */
async function versionFiles(): Promise<readonly string[]> {
  return (await listMemoryFiles()).filter((uri) => uri.includes('/.history/'));
}

/**
 * 从提示词里取出「记忆清单」一节列出的 URI。
 *
 * 清单里每条记忆渲染成 `` - comem://... `` 加两行元数据，正文在 `## 已读正文`。
 * 用结构化提取而不是 `toContain`，才能断言「清单里**只有**这几条」。
 */
function inventoryUris(prompt: string): readonly string[] {
  const section = prompt.split('## 记忆清单')[1] ?? '';
  const body = section.split('## 已读正文')[0] ?? '';
  return body
    .split('\n')
    .filter((line) => line.startsWith('- comem://'))
    .map((line) => line.slice('- '.length));
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

  it('被合并掉的记忆，它的 sources 并进保留者（W97）', async () => {
    const archive = (index: number): string =>
      `${SCOPE}/sessions/s1/history/archive_${String(index).padStart(3, '0')}`;
    await writePreferenceWithSources('code-style', '缩进用 2 个空格。', [archive(1), archive(2)]);
    await writePreferenceWithSources('code-style-legacy', '缩进用 4 个空格。', [
      archive(3),
      archive(2),
    ]);
    await writePreference('editor', '默认编辑器是 vim。');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'update',
            uri: CODE_STYLE,
            content: '缩进统一用 2 个空格。',
            reason: 'code-style-legacy 的结论已被取代',
          },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被 code-style 取代' },
        ],
      },
    ]);

    await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    // 保留者自己的在前，被删的按操作顺序追加，重复的归档只留一次。
    const merged = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(merged?.fields['content']).toBe('缩进统一用 2 个空格。');
    expect(merged?.sources).toEqual([archive(1), archive(2), archive(3)]);
    // 被删的那条真的不在了：它的来源只能从保留者身上回溯。
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).toBeNull();
  });

  it('合并一条没有 sources 的记录：不产生 sources 键（空 provenance 不写空数组）', async () => {
    await writePreference('code-style', '缩进用 2 个空格。');
    await writePreference('code-style-legacy', '缩进用 4 个空格。');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: CODE_STYLE, content: '缩进统一用 2 个空格。', reason: '合并' },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被 code-style 取代' },
        ],
      },
    ]);

    await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    // 守的是**输出契约**：没有可继承的来源时，写出的文件里没有 `sources` 键（空数组
    // 也不写），旧文件与改动前的输出逐字节相同。不是守调用点有没有传 `provenance`。
    const merged = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(merged?.fields['content']).toBe('缩进统一用 2 个空格。');
    expect(merged?.sources).toEqual([]);
    const raw = await readFile(toDiskPath(dataDir, Uri.parse(CODE_STYLE)), 'utf8');
    expect(raw).not.toContain('sources');
  });

  it('被删记录的 sources 里有坏值：整批失败，一条记忆都没删（校验在写盘之前）', async () => {
    await writePreference('code-style', '缩进用 2 个空格。');
    await writePreference('code-style-legacy', '缩进用 4 个空格。');
    // 手工改坏 frontmatter：`parseSources` 只挑非空字符串，坏值要到 `Uri.parse` 才暴露。
    const legacyPath = toDiskPath(dataDir, Uri.parse(CODE_STYLE_LEGACY));
    const raw = await readFile(legacyPath, 'utf8');
    await writeFile(legacyPath, raw.replace(/^---\n/u, '---\nsources:\n  - not-a-uri\n'), 'utf8');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: CODE_STYLE, content: '缩进统一用 2 个空格。', reason: '合并' },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被 code-style 取代' },
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

    // 计划阶段失败：两个文件都还在，保留者的正文没被改写。
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).not.toBeNull();
    const kept = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(kept?.fields['content']).toBe('缩进用 2 个空格。');
  });

  it('保留者的字段类型不对：整批失败，被删的记录仍在（校验在写盘之前）', async () => {
    await writeProfile();
    await writePreference('code-style-legacy', '缩进用 4 个空格。');
    // 手工把 frontmatter 的 `role` 改成数字：`parseScalar` 会把 `42` 读成 number，
    // 与 schema 声明的 string 不一致。`#plan` 若不校验字段类型，这个坏值要到
    // `upsertMemory` 锁内才暴露，而那时排在它前面的删除已经应用且不回滚。
    await editFrontmatter(PROFILE, /^role: .*$/gmu, 'role: 42');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: PROFILE, content: '先给结论，再给证据。', reason: '合并画像' },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被合并' },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // 关键断言：不是写盘循环里那句「已应用…没有回滚」，删除一次都没发生。
    expect(failureMessage(failure)).not.toContain('没有回滚');
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).not.toBeNull();
    const kept = await container.services.memory.read(Uri.parse(PROFILE));
    expect(kept?.fields['content']).toBe('先给结论。');
  });

  it('保留者的 identity 缺失：整批失败，一条记录都没删（校验在写盘之前）', async () => {
    await writeProfile();
    await writePreference('code-style-legacy', '缩进用 4 个空格。');
    // `profile` 的文件名固定，identity 推不出路径：删掉 `name` 之后 `renderMemoryUri`
    // 仍能渲染，只有 identity 校验能发现。留到 `upsertMemory` 锁内才报的话，
    // 排在它前面的删除已经应用且不回滚。
    await editFrontmatter(PROFILE, /^name: .*\n?/gmu, '');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'update', uri: PROFILE, content: '先给结论，再给证据。', reason: '合并画像' },
          { kind: 'delete', uri: CODE_STYLE_LEGACY, content: null, reason: '被合并' },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(failureMessage(failure)).not.toContain('没有回滚');
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).not.toBeNull();
    const kept = await container.services.memory.read(Uri.parse(PROFILE));
    expect(kept?.fields['content']).toBe('先给结论。');
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

  it('add 的目标是一份手写普通 Markdown：整批失败，被删的记录仍在，手写文件逐字节未变', async () => {
    await seedThree();
    const handwrittenUri = `${SCOPE}/memories/preferences/handwritten.md`;
    const handwrittenPath = toDiskPath(dataDir, Uri.parse(handwrittenUri));
    const handwritten = '# 手写笔记\n\n这一行必须原样留在磁盘上。\n';
    await writeFile(handwrittenPath, handwritten, 'utf8');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '被新的一条取代' },
          {
            kind: 'add',
            uri: handwrittenUri,
            content: '缩进一律 2 个空格。',
            reason: '把结论写成一条偏好',
          },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    // 计划阶段整批失败：不是写盘循环里那句「已应用…没有回滚」。
    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(failureMessage(failure)).toContain('非记忆文件');
    expect(failureMessage(failure)).not.toContain('没有回滚');
    // 同批的 delete 一次都没生效。
    const kept = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(kept?.fields['content']).toBe('缩进用 2 个空格。');
    // 手写文件逐字节未变，不是「还能读成记忆」这种更弱的判断。
    expect(await readFile(handwrittenPath)).toEqual(Buffer.from(handwritten, 'utf8'));
  });

  it('add 的目标 frontmatter 缺 memory_type：整批失败，文件内容未变', async () => {
    await seedThree();
    const plainUri = `${SCOPE}/memories/preferences/plain.md`;
    const plainPath = toDiskPath(dataDir, Uri.parse(plainUri));
    const plain = '---\nstatus: active\nsummary: 手写的笔记\n---\n\n没有 memory_type 的正文。\n';
    await writeFile(plainPath, plain, 'utf8');
    // 前提：这份文件在记忆语义下读不出来（缺 `memory_type` 按「不是记忆」处理）。
    expect(await container.services.memory.read(Uri.parse(plainUri))).toBeNull();

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'add',
            uri: plainUri,
            content: '覆盖掉这份手写笔记。',
            reason: '模型以为这是一条新记忆',
          },
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '被新的一条取代' },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(failureMessage(failure)).toContain('非记忆文件');
    expect(failureMessage(failure)).not.toContain('没有回滚');
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE))).not.toBeNull();
    expect(await readFile(plainPath)).toEqual(Buffer.from(plain, 'utf8'));
  });

  it('对照：add 的目标不存在时照常创建（新检查不误伤空路径）', async () => {
    await seedThree();
    const freshUri = `${SCOPE}/memories/preferences/fresh.md`;
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'add',
            uri: freshUri,
            content: '缩进一律 2 个空格。',
            reason: '新增一条更明确的偏好',
          },
        ],
      },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.adds).toEqual([freshUri]);
    const created = await container.services.memory.read(Uri.parse(freshUri));
    expect(created?.fields['content']).toBe('缩进一律 2 个空格。');
  });

  it('对照：目标是合法记忆时照常合并，同批的新路径照常创建（新检查不干扰正常合并）', async () => {
    await seedThree();
    const freshUri = `${SCOPE}/memories/preferences/spacing.md`;
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'update',
            uri: CODE_STYLE,
            content: '缩进统一用 2 个空格。',
            reason: '合并 4 空格那条的结论',
          },
          { kind: 'add', uri: freshUri, content: '禁止 tab。', reason: '拆出一条更明确的偏好' },
        ],
      },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    expect(result.updates).toEqual([CODE_STYLE]);
    expect(result.adds).toEqual([freshUri]);
    const merged = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(merged?.fields['content']).toBe('缩进统一用 2 个空格。');
    const created = await container.services.memory.read(Uri.parse(freshUri));
    expect(created?.fields['content']).toBe('禁止 tab。');
  });

  it('add 的目标是指向 scope 外普通文件的符号链接：拦截，链接与目标文件都不动', async () => {
    await seedThree();
    const outsidePath = join(dataDir, 'outside-note.md');
    const outside = '# scope 外的手写笔记\n\n写盘不能碰这里。\n';
    await writeFile(outsidePath, outside, 'utf8');
    const linkUri = `${SCOPE}/memories/preferences/linked.md`;
    const linkPath = toDiskPath(dataDir, Uri.parse(linkUri));
    await symlink(outsidePath, linkPath);
    // 前提：`stat` 跟随符号链接——记忆读不出来，但文件系统层面「存在且是文件」。
    expect((await contentStore.stat(Uri.parse(linkUri)))?.kind).toBe('file');
    expect(await container.services.memory.read(Uri.parse(linkUri))).toBeNull();

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '被新的一条取代' },
          {
            kind: 'add',
            uri: linkUri,
            content: '覆盖掉这个链接。',
            reason: '模型以为这是一条新记忆',
          },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(failureMessage(failure)).toContain('非记忆文件');
    expect(failureMessage(failure)).not.toContain('没有回滚');
    // 写盘会 `rename` 覆盖链接本身，所以链接还在、目标文件内容未变才算没丢数据。
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsidePath)).toEqual(Buffer.from(outside, 'utf8'));
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE))).not.toBeNull();
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

  it('add 的 identity 值含 ..：整批失败，被删的记录仍在（校验在写盘之前）', async () => {
    await writePreference('code-style', '缩进用 2 个空格。');
    // `Uri.normalizeSegment` 只拒绝整段等于 `..`，`z..z` 是合法路径段，能一路通过
    // `Uri.parse` / `resolveMemoryTarget`；只有 `renderPath` 的 identity 校验会拒绝
    // 它。这一步若留在写盘循环里，排在它前面的删除已经应用且不回滚。
    const badTopic = `${SCOPE}/memories/preferences/z..z.md`;
    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '被新的一条取代' },
          { kind: 'add', uri: badTopic, content: '缩进用 4 个空格。', reason: '改写结论' },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // 关键断言：不是写盘循环里那句「已应用…没有回滚」，删除一次都没发生。
    expect(failureMessage(failure)).not.toContain('没有回滚');
    const kept = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(kept?.fields['content']).toBe('缩进用 2 个空格。');
    expect(await container.services.memory.read(Uri.parse(badTopic))).toBeNull();
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

  it('版本快照不进候选清单：提示词里只有规范路径，不含 .history', async () => {
    // 同一个 topic 覆盖写一次：旧值被快照到 `memories/preferences/.history/`（W98）。
    await writePreference('code-style', '缩进用 2 个空格。');
    await writePreference('code-style', '缩进用 4 个空格。');
    // 前提：版本文件真的存在，且路径面看得到它（`tree` 按磁盘枚举，没有 `asOf`）。
    // 这两条不成立时下面的断言会因为「根本没有版本文件」而空转通过。
    const versions = await versionFiles();
    expect(versions).toHaveLength(1);
    const version = versions[0] ?? '';
    expect(version).toContain('/memories/preferences/.history/');
    expect((await container.services.memory.read(Uri.parse(version)))?.status).toBe('active');

    const llm = new ScriptedLlm([{ action: 'finish', operations: [] }]);
    await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    const prompt = llm.text;
    // 版本 URI 与目录名都不进提示词：模型看不到它，也就不会把它当成一条可合并的记忆。
    expect(prompt).not.toContain('.history');
    expect(prompt).not.toContain(version);
    // 候选清单只有规范路径那一条（不是「至少包含它」）。
    expect(prompt).toContain('## 记忆清单（1 条）');
    expect(inventoryUris(prompt)).toEqual([CODE_STYLE]);
  });

  it('模型强行 delete 版本 URI：整批失败，版本文件与同批的规范记忆都不动', async () => {
    await writePreference('code-style', '缩进用 2 个空格。');
    await writePreference('code-style', '缩进用 4 个空格。');
    const versions = await versionFiles();
    expect(versions).toHaveLength(1);
    const version = versions[0] ?? '';
    const versionPath = toDiskPath(dataDir, Uri.parse(version));
    const versionBytes = await readFile(versionPath);

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          { kind: 'delete', uri: version, content: null, reason: '想做一次「清理」' },
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '同批的正常操作' },
        ],
      },
    ]);

    const failure = await consolidateCapturingFailure(llm);

    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // 整批在写盘之前失败：不是写盘循环里那句「已应用…没有回滚」。
    expect(failureMessage(failure)).not.toContain('没有回滚');
    // 版本文件仍在磁盘上，且逐字节未变（删掉一份版本就掐断了 `supersedes` 链）。
    expect(await readFile(versionPath)).toEqual(versionBytes);
    // 同批的另一条 delete 一次都没生效。
    const kept = await container.services.memory.read(Uri.parse(CODE_STYLE));
    expect(kept?.fields['content']).toBe('缩进用 4 个空格。');

    // 只有 `add` 能走到 `#plan` 的版本检查：`delete` / `update` 在 `validateOperations`
    // 就因「不在清单里」整批拒绝。这条补上那一层的证据，也钉住拒绝理由（不是笼统的
    // 「路径不存在」）。
    const addLlm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'add',
            uri: version,
            content: '覆盖掉这份旧值。',
            reason: '模型以为这是一条新记忆',
          },
          { kind: 'delete', uri: CODE_STYLE, content: null, reason: '同批的正常操作' },
        ],
      },
    ]);

    const addFailure = await consolidateCapturingFailure(addLlm);

    expect(addFailure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(failureMessage(addFailure)).toContain('版本文件');
    expect(failureMessage(addFailure)).not.toContain('没有回滚');
    expect(await readFile(versionPath)).toEqual(versionBytes);
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE))).not.toBeNull();
  });

  it('对照：合法 update + delete 照常合并，文件名带 .history 的记忆不会被误滤', async () => {
    // 文件名（不是目录）叫 `.history` 的一条正常记忆：按路径**段**判定时它是候选，
    // 按子串 `includes('.history')` 判定时会被一起滤掉。
    const dotHistory = `${SCOPE}/memories/preferences/.history.md`;
    await writePreference('.history', '不要用 tab。');
    await writePreference('code-style-legacy', '缩进用 4 个空格。');

    const llm = new ScriptedLlm([
      {
        action: 'finish',
        operations: [
          {
            kind: 'update',
            uri: dotHistory,
            content: '缩进用 2 个空格，不用 tab。',
            reason: '把缩进结论并进这条偏好',
          },
          {
            kind: 'delete',
            uri: CODE_STYLE_LEGACY,
            content: null,
            reason: '它的结论已被合并',
          },
        ],
      },
    ]);

    const result = await createService(llm).consolidate(Uri.parse(SCOPE), {
      dryRun: false,
      subject: SUBJECT,
      principals: PRINCIPALS,
    });

    // 两条真候选都在清单里：过滤没有把它们误删。
    expect(inventoryUris(llm.text)).toEqual([dotHistory, CODE_STYLE_LEGACY].sort());
    expect(result.updates).toEqual([dotHistory]);
    expect(result.deletes).toEqual([CODE_STYLE_LEGACY]);
    const merged = await container.services.memory.read(Uri.parse(dotHistory));
    expect(merged?.fields['content']).toBe('缩进用 2 个空格，不用 tab。');
    expect(await container.services.memory.read(Uri.parse(CODE_STYLE_LEGACY))).toBeNull();
    expect(await listMemories()).toEqual([dotHistory]);
  });
});
