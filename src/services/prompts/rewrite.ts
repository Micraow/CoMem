/**
 * 查询重写提示词（架构文档 §8.4、§11.1）。
 *
 * `search` 与 `find` 的唯一差别是意图分析：模型读原 query 与最近几轮对话，产出
 * **0–5 条 TypedQuery**，服务层再逐条 `find` 并合并（§8.4）。
 *
 * 提示词的静态骨架在 `prompts/rewrite-system.md` 与 `prompts/rewrite-user.md`，
 * 可以在控制台查看和修改。本文件只负责渲染动态部分（当前查询、最近消息、可检索
 * 范围）并把条数上限注入模板。
 *
 * ## 为什么 `REWRITE_SYSTEM_PROMPT` 是可变的模块级绑定
 *
 * 它在 `services/search.ts` 里是一个**值**（`system: REWRITE_SYSTEM_PROMPT`），
 * 不是函数调用；而 `search.ts` 不在本 wave 的文件所有权里（另一个 wave 在改）。
 * 数据库覆盖要进这条提示词，只能通过模块级绑定 + 变更通知，推导写在
 * `registry.ts`。**这是为「不改别人的文件」付的代价**，下一个 wave 把
 * `PromptService` 注入 `SearchServiceDeps` 之后应当删掉。
 *
 * ## 为什么 schema 带 transform
 *
 * 模型产出的是「候选」不是「合法值」：置信度越界、intent 拼错、同一条查询写两遍
 * 都发生过。收敛放在 schema 里而不是服务层，是因为 `generateJson` 的返回值是
 * 唯一入口——校验与规范化各写一份，早晚会不一致。规则本身在
 * `domain/retrieval.ts` 的 `normalizeTypedQueries`（纯函数，可穷举测试）。
 */

import { z } from 'zod';

import {
  MAX_TYPED_QUERIES,
  normalizeTypedQueries,
  TYPED_QUERY_INTENTS,
  type TypedQuery,
} from '../../domain/retrieval.js';

import { onPromptRendererChange, promptRenderer } from './registry.js';

/**
 * 一条查询的 schema。
 *
 * - `intent` 用 `catch('other')`：拼错的 intent 不该让整次意图分析失败，落兜底值
 *   即可——服务层只按 intent 做解释，不按它做分支。
 * - `confidence` 用 `coerce` 再 `catch`：供应商常把数字写成字符串，`NaN` 与缺省
 *   落 0；越界由 `normalizeTypedQueries` clamp。
 * - `derivedFrom` 可缺省：少一个键是常态。
 */
const typedQuerySchema = z.object({
  text: z.string(),
  /**
   * 取值来自 `domain/retrieval.ts` 的 `TYPED_QUERY_INTENTS`（唯一来源）。
   *
   * 手抄一份数组时，领域层加一个 intent 不会让这里编译失败——schema 继续只接受
   * 旧的六个，模型永远产不出新值。
   */
  intent: z.enum(TYPED_QUERY_INTENTS).catch('other'),
  confidence: z.coerce.number().catch(0),
  derivedFrom: z.string().nullish(),
});

/**
 * `generateJson` 用的 schema。输出的 `queries` 已经过 `normalizeTypedQueries`：
 * 去空、去重（保留置信度最高的）、`confidence` clamp 到 `[0, 1]`、最多 5 条。
 */
export const REWRITE_SCHEMA = z
  .object({ queries: z.array(typedQuerySchema) })
  .transform((value): { readonly queries: readonly TypedQuery[] } => ({
    queries: normalizeTypedQueries(value.queries, MAX_TYPED_QUERIES),
  }));

/** schema 的输出形状，服务层用。 */
export type RewriteOutput = z.infer<typeof REWRITE_SCHEMA>;

/** 一条历史消息。只取 user / assistant，工具输出在服务层就过滤掉了（§10.1）。 */
export interface RewriteMessage {
  readonly role: string;
  readonly text: string;
}

export interface RewritePromptInput {
  readonly query: string;
  /** 最近几轮对话，越靠后越新。空数组表示没有历史。 */
  readonly recentMessages: readonly RewriteMessage[];
  /** 调用方可见的路径范围（`FindOptions.scopes`），让模型知道「这里有什么」。 */
  readonly knownScopes: readonly string[];
}

function renderSystemPrompt(): string {
  return promptRenderer().render('rewrite-system', {
    maxTypedQueries: String(MAX_TYPED_QUERIES),
  });
}

/**
 * 当前生效的查询重写系统提示词。
 *
 * 六条规则对应 §8.4 与 §8.8 的三个失败方向：**该返回空数组时返回空数组**
 * （检索错比检索不到更浪费上下文）、**该拆时拆**、**不该拆时不拆**。第三条最
 * 容易写反：模型的默认行为是把复合词拆成关键词，而中文的「代码风格约定」是一
 * 个词，拆开之后三条查询各自召回一堆无关记忆。
 */
export let REWRITE_SYSTEM_PROMPT: string = renderSystemPrompt();

onPromptRendererChange(() => {
  REWRITE_SYSTEM_PROMPT = renderSystemPrompt();
});

/** 最近消息。空列表时明确说「没有」，避免模型编造指代对象。 */
function renderRecentMessages(messages: readonly RewriteMessage[]): string {
  if (messages.length === 0) {
    return '（这次没有历史消息。）';
  }
  return messages.map((message) => `### ${message.role}\n${message.text}`).join('\n\n');
}

function renderScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) {
    return '（没有指定范围。）';
  }
  return scopes.map((scope) => `- ${scope}`).join('\n');
}

/**
 * 用户消息：当前查询 + 最近几轮对话 + 可检索范围。
 *
 * 范围要给模型看：同一个词在 `user/{uid}` 与 `group/{gid}` 下是两件事，
 * 「我们组的部署约定」与「我的部署习惯」不该重写成同一条查询。
 */
export function buildRewriteUserPrompt(input: RewritePromptInput): string {
  return promptRenderer().render('rewrite-user', {
    query: input.query,
    recentMessages: renderRecentMessages(input.recentMessages),
    knownScopes: renderScopes(input.knownScopes),
  });
}
