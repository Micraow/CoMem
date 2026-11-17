import { describe, expect, it } from 'vitest';

import { casesMemoryType } from '../../../src/domain/memory-types/cases.js';
import { Uri } from '../../../src/domain/uri.js';
import { experienceSources } from '../../../src/services/dreamer/experience-sources.js';
import type { MemoryRecord } from '../../../src/services/memory.js';

const CURRENT_ARCHIVE = Uri.parse('comem://user/alice/sessions/sess_2/history/archive_001');
const CASE_URI = Uri.parse('comem://user/alice/memories/cases/retry.md');
const OLD_ARCHIVE = 'comem://user/alice/sessions/sess_1/history/archive_001';

const CASE: MemoryRecord = {
  uri: CASE_URI,
  memoryType: casesMemoryType.type,
  fields: { case: 'retry', content: '网关重试三次。' },
  status: 'active',
  updatedAt: '2026-11-17T00:00:00.000Z',
  sources: [OLD_ARCHIVE],
  validFrom: null,
  validUntil: null,
  supersedes: null,
};

describe('经验来源', () => {
  it('消息证据没有 case 时仍保存产生经验的当前归档', () => {
    expect(experienceSources([], CURRENT_ARCHIVE).map(String)).toEqual([
      CURRENT_ARCHIVE.toString(),
    ]);
  });

  it('追加实际引用的 case 与 case 自己的归档来源', () => {
    expect(experienceSources([CASE], CURRENT_ARCHIVE).map(String)).toEqual([
      CURRENT_ARCHIVE.toString(),
      CASE_URI.toString(),
      OLD_ARCHIVE,
    ]);
  });
});
