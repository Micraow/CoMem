import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import type { ArchiveMeta } from '../../../src/domain/archive.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import type { Logger } from '../../../src/domain/log.js';
import type { MemoryTypeSchema } from '../../../src/domain/memory-type.js';
import { casesMemoryType } from '../../../src/domain/memory-types/cases.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { StepContext } from '../../../src/services/commit/pipeline.js';
import {
  experienceContext,
  explicitPreferenceContext,
  type ExperiencePorts,
} from '../../../src/services/dreamer/experience.js';
import { DreamerService } from '../../../src/services/dreamer/service.js';
import type { MemoryRecord, MemoryWriteResult } from '../../../src/services/memory.js';

const SCOPE = Uri.parse('comem://user/alice');
const ARCHIVE = Uri.parse(`${SCOPE}/sessions/sess_1/history/archive_001`);
const CASE_A = `${SCOPE}/memories/cases/mips-add3.md`;
const CASE_B = `${SCOPE}/memories/cases/mips-sll.md`;

function record(
  path: string,
  memoryType: string,
  topic: string,
  content: string,
  category?: string,
): MemoryRecord {
  const fields: Record<string, unknown> = { topic, content };
  if (category !== undefined) fields['category'] = category;
  return {
    uri: Uri.parse(`${SCOPE}/${path}`),
    memoryType,
    fields,
    status: 'active',
    updatedAt: '2026-11-17T00:00:00.000Z',
    sources: [],
    validFrom: null,
    validUntil: null,
    supersedes: null,
  };
}

function context(): StepContext {
  const messages: readonly SessionMessage[] = [{
    id: 'm1',
    role: 'user',
    parts: [{ kind: 'text', text: '继续整理 MIPS 数据通路。' }],
    createdAt: '2026-11-17T00:00:00.000Z',
    turn: 1,
  }];
  const meta: ArchiveMeta = {
    archiveId: 'archive_001',
    phase1: {
      status: 'ready',
      messagesSha256: 'hash',
      archivedMessageIds: ['m1'],
      retainedMessageIds: [],
    },
    stepsDone: [],
    skippedSteps: [],
    taskId: null,
  };
  return {
    archiveUri: ARCHIVE,
    scopeUri: SCOPE,
    messages,
    meta,
    latestArchiveOverview: null,
    state: new Map(),
    markStepDone: async () => undefined,
  };
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function experience(topic: string, claim: string) {
  return {
    category: 'computer-architecture',
    topic,
    claim,
    situation: ['分析同类数据通路。'],
    approach: ['逐项检查控制信号和关键路径。'],
    reflection: ['本次分析确认了检查顺序。'],
    evidence: [
      { kind: 'case', caseUri: CASE_A, quote: '新增 add3 时先检查第三个读口。' },
      { kind: 'case', caseUri: CASE_B, quote: '新增 sll 时复用 ALU 左移。' },
    ],
  };
}

function caseRecord(path: string, content: string, source: Uri): MemoryRecord {
  return {
    uri: Uri.parse(path),
    memoryType: casesMemoryType.type,
    fields: { case: Uri.parse(path).name.replace(/\.md$/u, ''), content },
    status: 'active',
    updatedAt: '2026-11-17T00:00:00.000Z',
    sources: [source.toString()],
    validFrom: null,
    validUntil: null,
    supersedes: null,
  };
}

describe('Dreamer 经验上下文', () => {
  it('经验与实体预取用项目 scope，明确偏好仍用个人根', async () => {
    const project = Uri.parse(`${SCOPE}/projects/comem`);
    const calls: string[] = [];
    const port: ExperiencePorts = {
      listCurrent: async (scope, schema) => {
        calls.push(`list:${schema.type}:${scope.toString()}`);
        return [];
      },
      memory: {
        read: async () => null,
        prefetch: async (scope, schema) => {
          calls.push(`prefetch:${schema.type}:${scope.toString()}`);
          return [];
        },
        upsertMemory: async () => {
          throw new Error('本测试不写记忆。');
        },
      },
      links: { addLinks: async () => ({ inserted: 0, merged: 0 }) },
      logger: logger(),
    };
    const step = { ...context(), projectScopeUri: project };

    await experienceContext(port, step, async () => true);
    await explicitPreferenceContext(port, step, async () => true);

    expect(calls).toEqual([
      `list:experiences:${project.toString()}`,
      `prefetch:experiences:${project.toString()}`,
      `prefetch:entities:${project.toString()}`,
      `list:preferences:${SCOPE.toString()}`,
    ]);
  });

  it('完整目录包含全部可见经验，正文候选仍只来自预取，并单独提供已有偏好', async () => {
    const alpha = record(
      'memories/experiences/alpha.md',
      experiencesMemoryType.type,
      'alpha',
      'Alpha 的可执行结论。',
      'workflow',
    );
    const beta = record(
      'memories/experiences/beta.md',
      experiencesMemoryType.type,
      'beta',
      'Beta 只在目录中出现。',
      'computer-architecture',
    );
    const hidden = record(
      'memories/experiences/hidden.md',
      experiencesMemoryType.type,
      'hidden',
      '不可见。',
    );
    const pendingReview = {
      ...record(
        'memories/experiences/pending-review.md',
        experiencesMemoryType.type,
        'pending-review',
        '待复核的重复 topic。',
      ),
      status: 'pending' as const,
    };
    const preference = record(
      'memories/preferences/answer-style.md',
      preferencesMemoryType.type,
      'answer-style',
      '回答先给结论。',
    );
    const inferred = record(
      'memories/preferences/inferred-answer-style.md',
      preferencesMemoryType.type,
      'inferred-answer-style',
      '推断偏好不应进入明确偏好候选。',
    );
    const prefetched: string[] = [];
    const memoryPort: ExperiencePorts['memory'] = {
      read: async (uri) => [alpha, beta, hidden].find((record) => record.uri.equals(uri)) ?? null,
      prefetch: async (_scope, schema) => {
        prefetched.push(schema.type);
        return schema.type === experiencesMemoryType.type ? [alpha] : [];
      },
      upsertMemory: async () => {
        throw new Error('本测试不写记忆。');
      },
    };
    const port: ExperiencePorts = {
      listCurrent: async (_scope, schema: MemoryTypeSchema) => {
        if (schema.type === experiencesMemoryType.type) return [alpha, beta, hidden, pendingReview];
        if (schema.type === preferencesMemoryType.type) return [preference, inferred];
        return [];
      },
      memory: memoryPort,
      links: { addLinks: async () => ({ inserted: 1, merged: 0 }) },
      logger: logger(),
    };
    const canUse = async (uri: Uri) => uri.name !== 'hidden.md';
    const step = context();

    const experience = await experienceContext(port, step, canUse);
    const preferences = await explicitPreferenceContext(port, step, canUse);

    expect(experience.catalog.map(({ topic, status }) => [topic, status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'active'],
      ['pending-review', 'pending'],
    ]);
    expect(experience.existing.map(({ topic }) => topic)).toEqual(['alpha']);
    expect(preferences).toEqual([{ topic: 'answer-style', content: '回答先给结论。' }]);
    expect(prefetched).toEqual([experiencesMemoryType.type, 'entities']);
  });

  it('合并未预取的 pending topic 前会定向读取旧正文，再让模型重试', async () => {
    const pending = {
      ...record(
      'memories/experiences/single-cycle.md',
      experiencesMemoryType.type,
      'single-cycle',
      '旧结论：先检查控制单元与取指是否共享资源。',
      'computer-architecture',
      ),
      status: 'pending' as const,
    };
    const prompts: LlmPrompt[] = [];
    const writes: MemoryWriteResult[] = [];
    const outputs: unknown[] = [
      { experiences: [experience('single-cycle', '未阅读旧正文的新结论。')] },
      { experiences: [experience('single-cycle', '结合旧结论修正后的完整结论。')] },
    ];
    const upsertMemory: ExperiencePorts['memory']['upsertMemory'] = async (_scope, _schema, input) => {
      const current = 'update' in input && typeof input.update === 'function' ? input.update({}) : input;
      const write: MemoryWriteResult = {
        uri: pending.uri,
        memoryType: experiencesMemoryType.type,
        created: false,
        written: true,
        before: '旧正文',
        after: String(current['content'] ?? ''),
      };
      writes.push(write);
      return write;
    };
    const archiveMemory: ExperiencePorts['memory'] = {
      read: async (uri) => uri.equals(pending.uri) ? pending : null,
      prefetch: async (_scope, schema) => schema.type === casesMemoryType.type
        ? [
          caseRecord(CASE_A, '新增 add3 时先检查第三个读口。', ARCHIVE),
          caseRecord(CASE_B, '新增 sll 时复用 ALU 左移。', ARCHIVE),
        ]
        : [],
      upsertMemory,
    };
    const log = logger();
    const service = new DreamerService({
      memory: { read: async () => null, upsertMemory, remove: async () => undefined },
      stat: { stat: async () => null },
      search: { glob: async () => [] },
      llm: {
        generateJson: async <T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T> => {
          prompts.push(prompt);
          const output = outputs.shift();
          if (output === undefined) throw new Error('缺少模型响应。');
          return schema.parse(output);
        },
      },
      logger: log,
      archive: {
        listCurrent: async (_scope, schema) => schema.type === experiencesMemoryType.type ? [pending] : [],
        memory: archiveMemory,
        links: { addLinks: async () => ({ inserted: 1, merged: 0 }) },
        logger: log,
        canUse: async () => true,
        evidence: async () => [],
      },
    });

    await service.fromArchive(context());

    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.messages.at(-2)?.content).toContain('未阅读旧正文的新结论');
    expect(prompts[1]?.messages[0]?.content).toContain('旧结论：先检查控制单元与取指是否共享资源。');
    expect(prompts[1]?.messages[0]?.content).toContain('状态：pending');
    expect(writes).toHaveLength(1);
  });

  it('旧正文读取失败时拒绝覆盖未读 topic，并记录可定位告警', async () => {
    const existing = record(
      'memories/experiences/single-cycle.md',
      experiencesMemoryType.type,
      'single-cycle',
      '不可读取但已存在的旧正文。',
      'computer-architecture',
    );
    const upsertMemory = vi.fn<ExperiencePorts['memory']['upsertMemory']>();
    const log = logger();
    const service = new DreamerService({
      memory: { read: async () => null, upsertMemory, remove: async () => undefined },
      stat: { stat: async () => null },
      search: { glob: async () => [] },
      llm: {
        generateJson: async <T>(_prompt: LlmPrompt, schema: ZodType<T>): Promise<T> =>
          schema.parse({ experiences: [experience('single-cycle', '会覆盖旧正文。')] }),
      },
      logger: log,
      archive: {
        listCurrent: async () => [existing],
        memory: {
          read: async () => null,
          prefetch: async (_scope, schema) => schema.type === casesMemoryType.type
            ? [
              caseRecord(CASE_A, '新增 add3 时先检查第三个读口。', ARCHIVE),
              caseRecord(CASE_B, '新增 sll 时复用 ALU 左移。', ARCHIVE),
            ]
            : [],
          upsertMemory,
        },
        links: { addLinks: async () => ({ inserted: 1, merged: 0 }) },
        logger: log,
        canUse: async () => true,
        evidence: async () => [],
      },
    });

    await service.fromArchive(context());

    expect(upsertMemory).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('经验合并缺少已有正文，已拒绝覆盖', {
      archive: ARCHIVE.toString(),
      uri: existing.uri.toString(),
      topic: 'single-cycle',
      status: 'active',
    });
  });
});
