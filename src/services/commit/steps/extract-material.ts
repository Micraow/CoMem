import type { LlmPrompt } from '../../../domain/llm.js';
import { environmentObservations } from '../../../domain/environment-observation.js';
import { renderMessageText, type SessionMessage } from '../../../domain/session.js';

export function extractionMaterial(messages: readonly SessionMessage[]): LlmPrompt['messages'] {
  return messages.flatMap((message) => {
    if (message.role === 'system') return [];
    const text = message.role === 'tool' ? '' : renderMessageText({
      ...message, parts: message.parts.filter((part) => part.kind === 'text'),
    });
    const observations = environmentObservations(message);
    if (text.trim() === '' && observations.length === 0) return [];
    const source = message.source === undefined ? '来源未记录，不推定机器归属' : JSON.stringify(message.source);
    return [{
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: `[来源 ${source}; 时间 ${message.createdAt}]\n${text}${observations.length === 0 ? '' : `\n[工具观察：当前执行环境，未证明属于用户主力设备]\n${observations.join('\n')}`}`,
    }];
  });
}
