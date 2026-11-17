import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import type { ArchiveMeta } from '../../../src/domain/archive.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import type { Logger } from '../../../src/domain/log.js';
import { casesMemoryType } from '../../../src/domain/memory-types/cases.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { StepContext } from '../../../src/services/commit/pipeline.js';
import { DreamerService } from '../../../src/services/dreamer/service.js';
import type { MemoryRecord } from '../../../src/services/memory.js';

const SCOPE = Uri.parse('comem://user/alice');
const ARCHIVE = Uri.parse(`${SCOPE}/sessions/sess_1/history/archive_001`);
const CASE = `${SCOPE}/memories/cases/mips-sll-datapath.md`;

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function memoryRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    uri: Uri.parse(CASE),
    memoryType: casesMemoryType.type,
    fields: {
      case: 'mips-sll-datapath',
      task: '为单周期 MIPS 数据通路添加 sll。',
      outcome: 'success',
      content: '首行结论\n\n## 尝试\n\n复用 ALU 左移。\n\n## 结果\n\n仿真通过。',
    },
    status: 'active',
    updatedAt: '2026-11-17T00:00:00.000Z',
    sources: [],
    validFrom: null,
    validUntil: null,
    supersedes: null,
    ...overrides,
  };
}

function stepContext(): StepContext {
  const messages: readonly SessionMessage[] = [{
    id: 'm1',
    role: 'user',
    parts: [{ kind: 'text', text: '为单周期 MIPS 添加 sll，并复用了 ALU 左移。' }],
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

describe('Dreamer 的案例上下文与安全边界', () => {
  it('经验归纳看到相关 cases，但案例本身仍独立保存', async () => {
    const caseRecord = memoryRecord();
    const prompts: LlmPrompt[] = [];
    const service = new DreamerService({
      memory: {
        read: async () => null,
        upsertMemory: async () => {
          throw new Error('空输出不应写记忆。');
        },
        remove: async () => undefined,
      },
      stat: { stat: async () => null },
      search: { glob: async () => [] },
      llm: {
        generateJson: async <T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T> => {
          prompts.push(prompt);
          return schema.parse({ experiences: [] });
        },
      },
      logger: logger(),
      archive: {
        listCurrent: async (_scope, schema) =>
          schema.type === casesMemoryType.type ? [caseRecord] : [],
        memory: {
          read: async () => null,
          prefetch: async (_scope, schema) =>
            schema.type === casesMemoryType.type ? [caseRecord] : [],
          upsertMemory: async () => {
            throw new Error('空输出不应写记忆。');
          },
        },
        links: { addLinks: async () => ({ inserted: 0, merged: 0 }) },
        logger: logger(),
        canUse: async () => true,
        evidence: async () => [],
      },
    });

    await service.fromArchive(stepContext());

    const rendered = prompts[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(rendered).toContain('## 相关具体案例');
    expect(rendered).toContain(CASE);
    expect(rendered).toContain('复用 ALU 左移');
    expect(rendered).toContain('由 cases 保存');
  });

  it('未读取 cases 正文本时不接受更新或删除', async () => {
    const caseRecord = memoryRecord();
    const upsertMemory = vi.fn();
    const remove = vi.fn();
    const prompts: LlmPrompt[] = [];
    const service = new DreamerService({
      memory: {
        read: async (uri) => uri.equals(caseRecord.uri) ? caseRecord : null,
        upsertMemory,
        remove,
      },
      stat: { stat: async () => null },
      search: { glob: async () => [caseRecord.uri.toString()] },
      llm: {
        generateJson: async <T>(prompt: LlmPrompt, schema: ZodType<T>): Promise<T> => {
          prompts.push(prompt);
          return schema.parse({
            action: 'finish',
            operations: [{
              kind: 'update',
              uri: caseRecord.uri.toString(),
              content: '未读取正文就覆盖。',
              reason: '测试安全边界',
            }],
          });
        },
      },
      logger: logger(),
    });

    await expect(service.run(SCOPE, {
      dryRun: false,
      subject: 'user:alice',
      principals: ['user:alice', 'user:*'],
    })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { unreadCases: [CASE] },
    });

    expect(prompts[0]?.messages[0]?.content).toContain(`类型：${casesMemoryType.type}`);
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
