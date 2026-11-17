import { renderMessageText, type SessionMessage } from './session.js';

/** 对话文本事实：只保留 user / assistant，以及各自的 text parts。 */
export interface ConversationTextMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export function conversationTextMessages(
  messages: readonly SessionMessage[],
): readonly ConversationTextMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    const content = renderMessageText({
      ...message,
      parts: message.parts.filter((part) => part.kind === 'text'),
    });
    return content.trim() === '' ? [] : [{ role: message.role, content }];
  });
}
