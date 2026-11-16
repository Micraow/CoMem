/**
 * 一轮合并提示词的拼装（架构文档 §11.8「循环」）：scope、清单、已读正文与轮次。
 *
 * 清单条目只带 URI、类型、摘要与更新时间，**不带正文**——正文必须由模型显式 `read`。
 */

import type { LlmPrompt } from '../../domain/llm.js';
import { promptRenderer } from '../prompts/registry.js';

import type { ConsolidationPromptInput, InventoryEntry } from './types.js';

function renderEntry(entry: InventoryEntry): string {
  return [
    `- ${entry.uri}`,
    `  类型：${entry.memoryType}，更新于 ${entry.updatedAt}`,
    `  摘要：${entry.summary}`,
  ].join('\n');
}

function renderInventory(input: ConsolidationPromptInput): string {
  return input.inventory.length === 0
    ? '（这个 scope 下没有生效中的记忆。）'
    : input.inventory.map(renderEntry).join('\n');
}

function renderReads(input: ConsolidationPromptInput): string {
  return input.reads.size === 0
    ? '（还没有读过正文。）'
    : [...input.reads].map(([uri, content]) => `### ${uri}\n${content}`).join('\n\n');
}

function buildUserContent(input: ConsolidationPromptInput): string {
  return promptRenderer().render('consolidation-user', {
    scope: input.scope,
    inventoryCount: String(input.inventory.length),
    inventory: renderInventory(input),
    readCount: String(input.reads.size),
    reads: renderReads(input),
    iteration: String(input.iteration),
    maxIterations: String(input.maxIterations),
  });
}

export function buildConsolidationPrompt(input: ConsolidationPromptInput): LlmPrompt {
  return {
    system: promptRenderer().render('consolidation-system', {
      maxIterations: String(input.maxIterations),
    }),
    messages: [{ role: 'user', content: buildUserContent(input) }],
  };
}
