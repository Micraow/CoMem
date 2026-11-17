import { describe, expect, it } from 'vitest';

import { casesMemoryType } from '../../../src/domain/memory-types/cases.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { validateExperienceEvidence } from '../../../src/services/dreamer/experience-evidence.js';
import { renderExperienceContent } from '../../../src/services/dreamer/experience-render.js';
import { assertManualOutput, consolidationOutputSchema } from '../../../src/services/dreamer/output.js';
import type { MemoryRecord } from '../../../src/services/memory.js';

const CASE_URI = Uri.parse('comem://user/alice/memories/cases/retry.md');
const MESSAGES: readonly SessionMessage[] = [{
  id: 'm1',
  role: 'user',
  parts: [{ kind: 'text', text: '重试必须使用同一个幂等键。' }],
  createdAt: '2026-11-17T00:00:00.000Z',
  turn: 1,
}];

function caseRecord(): MemoryRecord {
  return {
    uri: CASE_URI,
    memoryType: casesMemoryType.type,
    fields: {
      case: 'retry',
      content: '网关重试三次。\n\n## 结果\n\n同一幂等键由业务层透传。',
    },
    status: 'active',
    updatedAt: '2026-11-17T00:00:00.000Z',
    sources: ['comem://user/alice/sessions/sess_1/history/archive_001'],
    validFrom: null,
    validUntil: null,
    supersedes: null,
  };
}

describe('经验证据', () => {
  it('当前会话消息可以独立支持经验，不要求 case 数量', () => {
    const result = validateExperienceEvidence([{
      topic: 'idempotent-retry',
      evidence: [{
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        quote: '重试必须使用同一个幂等键。',
      }],
    }], MESSAGES, []);

    expect(result.get('idempotent-retry')).toEqual([]);
  });

  it('一个 case 即可作为证据，并返回实际引用的来源', () => {
    const result = validateExperienceEvidence([{
      topic: 'idempotent-retry',
      evidence: [{ kind: 'case', caseUri: CASE_URI.toString(), quote: '网关重试三次。' }],
    }], [], [caseRecord()]);

    expect(result.get('idempotent-retry')?.map((record) => record.uri.toString())).toEqual([
      CASE_URI.toString(),
    ]);
  });

  it('案例不在已读取集合或 quote 不精确时拒绝', () => {
    const evidence = {
      kind: 'case' as const,
      caseUri: CASE_URI.toString(),
      quote: '网关重试三次。',
    };
    const base = {
      topic: 'idempotent-retry',
      evidence: [evidence],
    };

    expect(() => validateExperienceEvidence([base], [], [])).toThrowError(/case_not_in_input/u);
    expect(() => validateExperienceEvidence([
      { ...base, evidence: [{ ...evidence, quote: '网关重试两次。' }] },
    ], [], [caseRecord()])).toThrowError(/case_quote_not_exact/u);
  });

  it('新消息证据附当前归档 URI，历史证据行原样保留', () => {
    const historical = '- message `old-1` (user)，archive `comem://user/alice/sessions/old/history/archive_001`：旧证据';
    const content = renderExperienceContent({
      claim: '重试使用稳定幂等键。',
      situation: ['网关执行自动重试。'],
      approach: ['业务层传入幂等键。'],
      reflection: ['本次请求成功。'],
      evidence: [{
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        quote: '重试必须使用同一个幂等键。',
      }],
    }, [historical], 'comem://user/alice/sessions/new/history/archive_001');

    expect(content).toContain(
      'message `m1` (user)，archive `comem://user/alice/sessions/new/history/archive_001`',
    );
    expect(content).toContain(historical);
  });
});

describe('Dreamer 输出契约', () => {
  const valid = {
    category: 'workflow',
    topic: 'idempotent-retry',
    claim: '重试使用稳定幂等键。',
    situation: ['网关执行自动重试。'],
    approach: ['业务层传入幂等键。'],
    reflection: ['本次请求成功。'],
    evidence: [{
      kind: 'message' as const,
      messageId: 'm1',
      role: 'user' as const,
      quote: '重试必须使用同一个幂等键。',
    }],
  };

  it('拒绝 schema 未知字段与手动整理生成经验', () => {
    expect(consolidationOutputSchema.safeParse({
      action: 'finish',
      operations: [],
      unexpected: true,
    }).success).toBe(false);
    expect(consolidationOutputSchema.safeParse({
      action: 'finish',
      operations: [{ kind: 'delete', uri: 'comem://user/alice/memories/x.md', content: null, reason: '重复', unexpected: true }],
    }).success).toBe(false);
    expect(() => assertManualOutput({ action: 'finish', operations: [], experiences: [valid] }))
      .toThrowError(/手动整理请使用 operations 提交/u);
    expect(() => assertManualOutput({
      action: 'finish',
      operations: [{
        kind: 'add',
        uri: 'comem://user/alice/memories/experiences/idempotent-retry.md',
        content: '通过 operations 新增经验。',
        reason: '手工确认的新增',
      }],
    })).not.toThrow();
  });
});
