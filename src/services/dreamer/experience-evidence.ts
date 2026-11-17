import { ComemError } from '../../domain/errors.js';
import { memoryContentOf } from '../../domain/memory-type.js';
import type { SessionMessage } from '../../domain/session.js';
import { Uri } from '../../domain/uri.js';
import type { MemoryRecord } from '../memory.js';

import { experiencePromptMessages } from './archive-prompt.js';

interface CitedExperience {
  readonly topic: string;
  readonly evidence: readonly (
    | {
      readonly kind: 'message';
      readonly messageId: string;
      readonly role: 'user' | 'assistant';
      readonly quote: string;
    }
    | {
      readonly kind: 'case';
      readonly caseUri: string;
      readonly quote: string;
    }
  )[];
}

/**
 * 只核验“引用确实来自输入”，不评价结论是否由引用支持。
 *
 * 能确定的是来源存在，以及 quote 是对应正文的一段逐字连续子串。消息和案例都
 * 可以作为证据，不设置数量门槛。整批先验，避免一条坏引用让前面的经验已经落盘。
 */
export function validateExperienceEvidence(
  experiences: readonly CitedExperience[],
  messages: readonly SessionMessage[],
  cases: readonly MemoryRecord[],
): ReadonlyMap<string, readonly MemoryRecord[]> {
  const sources = new Map(
    experiencePromptMessages(messages).map((message) => [message.id, message]),
  );
  const caseSources = new Map(cases.map((record) => [record.uri.toString(), record]));
  const validated = new Map<string, readonly MemoryRecord[]>();

  for (const experience of experiences) {
    const citedCases = new Map<string, MemoryRecord>();
    for (const evidence of experience.evidence) {
      let reason: string | null = null;
      let details: Readonly<Record<string, unknown>> = {};

      if (evidence.kind === 'message') {
        const source = sources.get(evidence.messageId);
        reason = source === undefined
          ? 'message_not_in_input'
          : source.role !== evidence.role
            ? 'role_mismatch'
            : !source.content.includes(evidence.quote)
              ? 'quote_not_exact'
              : null;
        details = {
          messageId: evidence.messageId,
          role: evidence.role,
        };
      } else {
        const caseUri = Uri.tryParse(evidence.caseUri);
        const source = caseUri === null ? undefined : caseSources.get(caseUri.toString());
        reason = source === undefined
          ? 'case_not_in_input'
          : !memoryContentOf(source.fields).includes(evidence.quote)
            ? 'case_quote_not_exact'
            : null;
        details = { caseUri: evidence.caseUri };
        if (source !== undefined) citedCases.set(source.uri.toString(), source);
      }

      if (reason !== null) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `经验证据引用无效：${experience.topic} (${reason})。`,
          {
            reason,
            topic: experience.topic,
            ...details,
          },
        );
      }
    }
    validated.set(experience.topic, [...citedCases.values()]);
  }
  return validated;
}
