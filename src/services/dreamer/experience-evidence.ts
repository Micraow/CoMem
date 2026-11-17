import { ComemError } from '../../domain/errors.js';
import type { SessionMessage } from '../../domain/session.js';

import { experiencePromptMessages } from './archive-prompt.js';

interface CitedExperience {
  readonly topic: string;
  readonly evidence: readonly {
    readonly messageId: string;
    readonly role: 'user' | 'assistant';
    readonly quote: string;
  }[];
}

/**
 * 只核验“引用确实来自输入”，不评价结论是否由引用支持。
 *
 * 语义正确性不能靠关键词或相似度冒充；这里能确定的只有 ID 存在、角色一致，
 * 以及 quote 是该消息正文的一段逐字连续子串。整批先验，避免部分经验先落盘。
 */
export function validateExperienceEvidence(
  experiences: readonly CitedExperience[],
  messages: readonly SessionMessage[],
): void {
  const sources = new Map(
    experiencePromptMessages(messages).map((message) => [message.id, message]),
  );
  for (const experience of experiences) {
    for (const evidence of experience.evidence) {
      const source = sources.get(evidence.messageId);
      const reason = source === undefined
        ? 'message_not_in_input'
        : source.role !== evidence.role
          ? 'role_mismatch'
          : !source.content.includes(evidence.quote)
            ? 'quote_not_exact'
            : null;
      if (reason !== null) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `经验证据引用无效：${experience.topic}/${evidence.messageId} (${reason})。`,
          {
            reason,
            topic: experience.topic,
            messageId: evidence.messageId,
            role: evidence.role,
          },
        );
      }
    }
  }
}
