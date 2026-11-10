/**
 * 一轮合并提示词的拼装（架构文档 §11.8「循环」）：scope、清单、已读正文与轮次。
 *
 * 清单条目只带 URI、类型、摘要与更新时间，**不带正文**——正文必须由模型显式 `read`。
 */

import type { LlmPrompt } from '../../domain/llm.js';

import type { ConsolidationPromptInput, InventoryEntry } from './types.js';

function renderEntry(entry: InventoryEntry): string {
  return [
    `- ${entry.uri}`,
    `  类型：${entry.memoryType}，更新于 ${entry.updatedAt}`,
    `  摘要：${entry.summary}`,
  ].join('\n');
}

function buildUserContent(input: ConsolidationPromptInput): string {
  const reads =
    input.reads.size === 0
      ? '（还没有读过正文。）'
      : [...input.reads].map(([uri, content]) => `### ${uri}\n${content}`).join('\n\n');

  return [
    '## scope',
    input.scope,
    `## 记忆清单（${input.inventory.length} 条）`,
    input.inventory.length === 0
      ? '（这个 scope 下没有生效中的记忆。）'
      : input.inventory.map(renderEntry).join('\n'),
    '## 已读正文',
    reads,
    '## 轮次',
    `第 ${input.iteration}/${input.maxIterations} 轮，已经读过 ${input.reads.size} 条记忆的正文。`,
    '## 任务',
    '按上面的格式输出 JSON。',
  ].join('\n\n');
}

function buildSystemPrompt(input: ConsolidationPromptInput): string {
  return [
    '你是 CoMem 的记忆合并器。一个 scope 下的记忆会越积越多：其中一些是重复的，一些已经被后来的结论取代。',
    '你的任务是把它们收敛成一份没有重复、没有相互矛盾的记忆库。',
    '',
    '## 你拿到的',
    '- 「记忆清单」：这个 scope 下**全部**生效中记忆的 URI、类型、摘要与更新时间。清单之外的路径不存在。',
    '- 「已读正文」：你在之前轮次请求读取过的记忆全文。',
    '',
    '## 你可以产出的操作',
    '- `add`：新增一条记忆。`uri` 是建议路径，必须落在清单里某个记忆类型的目录下，且不能与已有记忆重名。',
    '- `update`：用完整正文替换一条已有记忆。`content` 是操作后的全文。',
    '- `delete`：删除一条已有记忆。`content` 必须是 null。',
    '',
    '## 每轮只输出一个 JSON 对象',
    '- 想先读正文：`{"action": "read", "uris": ["comem://..."]}`',
    '- 想结束：`{"action": "finish", "operations": [{"kind": "update", "uri": "comem://...", "content": "...", "reason": "..."}]}`',
    '',
    '## 规则',
    '- 每条操作必须有 `reason`，说明为什么合并、为什么删除。没有理由的删除不可接受。',
    '- 判断依据是语义：两条记忆讲同一件事，或者一条已经被另一条取代。字面相似度不是依据。',
    '- 不确定时先 `read` 正文，不要凭摘要猜。',
    '- 没有需要改的，输出 `{"action": "finish", "operations": []}`。',
    `- 最多 ${input.maxIterations} 轮。第 ${input.maxIterations} 轮必须结束，否则整次合并失败。`,
  ].join('\n');
}

export function buildConsolidationPrompt(input: ConsolidationPromptInput): LlmPrompt {
  return {
    system: buildSystemPrompt(input),
    messages: [{ role: 'user', content: buildUserContent(input) }],
  };
}
