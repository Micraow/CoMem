import type { ContentStore } from '../../adapters/fs/content-store.js';
import {
  conversationTextMessages,
  type ConversationTextMessage,
} from '../../domain/conversation.js';
import type { Uri } from '../../domain/uri.js';
import { readMessages } from '../session/messages.js';
import { ARCHIVE_DIRECTORY_PATTERN, messagesUri } from '../session/storage.js';

export interface ArchiveConversation {
  readonly sourceText: string;
  readonly dialogue: readonly ConversationTextMessage[];
}

export function isArchiveRoot(uri: Uri): boolean {
  return uri.segments.length === 4 &&
    uri.segments[0] === 'sessions' &&
    ARCHIVE_DIRECTORY_PATTERN.test(uri.segments[3] ?? '');
}

/** 归档根从自己的受控 JSONL 读取对话；普通目录返回 `undefined`。 */
export async function readArchiveConversation(
  store: ContentStore,
  directoryUri: Uri,
  maxChars: number,
): Promise<ArchiveConversation | undefined> {
  if (!isArchiveRoot(directoryUri)) {
    return undefined;
  }
  const archiveMessagesUri = messagesUri(directoryUri);
  if (await store.stat(archiveMessagesUri) === null) {
    return undefined;
  }
  const messages = await readMessages(store, archiveMessagesUri);
  const dialogue = conversationTextMessages(messages);
  const sourceText = boundedConversationText(dialogue, maxChars);
  return sourceText === undefined ? undefined : { sourceText, dialogue };
}

function renderConversationBlock(message: ConversationTextMessage): string {
  return `### ${message.role}\n${message.content}`;
}

/**
 * 头尾各留一半，保留开头意图与最终纠正；中间明确省略。
 *
 * 正常 4000 字预算下，尾部从最后一条消息的标题开始，避免只留下半句助手答复。
 * 配置小于省略标记时只能严格截取开头，不能再写一个超出预算的标记。
 */
function boundedConversationText(
  messages: readonly ConversationTextMessage[],
  maxChars: number,
): string | undefined {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || messages.length === 0) {
    return undefined;
  }
  const blocks = messages.map(renderConversationBlock);
  const text = blocks.join('\n\n');
  const chars = Array.from(text);
  if (chars.length <= limit) {
    return text;
  }

  const marker = '\n\n[中间省略]\n\n';
  const markerLength = Array.from(marker).length;
  if (limit <= markerLength) {
    return chars.slice(0, limit).join('');
  }

  const contentBudget = limit - markerLength;
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = contentBudget - headLength;
  const headParts = conversationBlocksFromStart(blocks, messages, headLength);
  const tailParts = conversationBlocksFromEnd(blocks, messages, tailLength);
  return [
    headParts.join('\n\n'),
    marker,
    tailParts.join('\n\n'),
  ].join('');
}

function conversationBlocksFromStart(
  blocks: readonly string[],
  messages: readonly ConversationTextMessage[],
  budget: number,
): readonly string[] {
  const selected: string[] = [];
  let used = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? '';
    const separatorLength = selected.length === 0 ? 0 : 2;
    const remaining = budget - used;
    if (remaining <= 0) {
      break;
    }
    const blockLength = Array.from(block).length;
    if (separatorLength + blockLength <= remaining) {
      selected.push(block);
      used += separatorLength + blockLength;
      continue;
    }
    const partialBudget = remaining - separatorLength;
    if (partialBudget > 0) {
      selected.push(conversationExcerpt(block, messages[index], partialBudget, 'head'));
    }
    break;
  }
  return selected;
}

function conversationBlocksFromEnd(
  blocks: readonly string[],
  messages: readonly ConversationTextMessage[],
  budget: number,
): readonly string[] {
  const selected: string[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] ?? '';
    const separatorLength = selected.length === 0 ? 0 : 2;
    const remaining = budget - used;
    if (remaining <= 0) {
      break;
    }
    const blockLength = Array.from(block).length;
    if (separatorLength + blockLength <= remaining) {
      selected.unshift(block);
      used += separatorLength + blockLength;
      continue;
    }
    const partialBudget = remaining - separatorLength;
    if (partialBudget > 0) {
      selected.unshift(conversationExcerpt(block, messages[index], partialBudget, 'tail'));
    }
    break;
  }
  return selected;
}

function conversationExcerpt(
  block: string,
  message: ConversationTextMessage | undefined,
  budget: number,
  side: 'head' | 'tail',
): string {
  if (message === undefined || budget <= 0) {
    return '';
  }
  const blockChars = Array.from(block);
  if (blockChars.length <= budget) {
    return block;
  }
  const heading = Array.from(`### ${message.role}\n`);
  const content = Array.from(message.content);
  if (budget <= heading.length) {
    return side === 'head'
      ? blockChars.slice(0, budget).join('')
      : content.slice(-budget).join('');
  }
  const excerpt = side === 'head'
    ? content.slice(0, budget - heading.length)
    : content.slice(-(budget - heading.length));
  return [...heading, ...excerpt].join('');
}
