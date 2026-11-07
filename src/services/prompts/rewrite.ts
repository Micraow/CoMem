/**
 * 查询重写提示词（架构文档 §8.4、§11.1）。
 *
 * `search` 与 `find` 的唯一差别是意图分析：模型读原 query 与最近几轮对话，产出
 * **0–5 条 TypedQuery**，服务层再逐条 `find` 并合并（§8.4）。
 *
 * 纯字符串拼接 + 一个 schema，不读文件、不调模型：提示词是确定的，测试只需要
 * 断言关键片段出现、schema 收敛正确，不用起一个真实的 LLM。
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
  type TypedQuery,
} from '../../domain/retrieval.js';

/** 契约里的六个 intent（`domain/retrieval.ts` 的 `TypedQueryIntent`）。 */
const INTENTS = ['preference', 'fact', 'decision', 'event', 'procedure', 'other'] as const;

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
  intent: z.enum(INTENTS).catch('other'),
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

/**
 * 系统提示词。
 *
 * 六条规则对应 §8.4 与 §8.8 的三个失败方向：**该返回空数组时返回空数组**
 * （检索错比检索不到更浪费上下文）、**该拆时拆**、**不该拆时不拆**。第三条最
 * 容易写反：模型的默认行为是把复合词拆成关键词，而中文的「代码风格约定」是一
 * 个词，拆开之后三条查询各自召回一堆无关记忆。
 */
export const REWRITE_SYSTEM_PROMPT = [
  '你是 CoMem 的查询重写器。CoMem 是一个记忆数据库：它保存用户与 agent 过去的偏好、事实、决定、事件与操作步骤。你的任务是把用户当前这句话改写成 0–5 条适合做全文检索的查询。',
  '',
  '## 什么时候返回空数组',
  '下面这些情况返回 `{"queries": []}`，一条都不要给：',
  '- 这句话是寒暄、客套、无信息量的应答（「你好」「谢谢」「继续」「好的」「嗯」）。',
  '- 这句话是纯指令，不依赖任何历史（「重新跑一遍测试」「把文件删了」）——它的答案在执行结果里，不在记忆里。',
  '- 这句话问的是与用户和历史无关的通用知识（「今天几号」「Python 怎么读文件」），记忆库里没有对应内容。',
  '检索不到比检索错更浪费上下文：一条错误的查询会把无关记忆投进上下文，模型还要为它分心。',
  '',
  '## 什么时候拆成多条',
  '- 这句话里有 2 个以上**互相独立**的意图：「我上次说的那个编码规范和提交信息格式，现在还在用吗」是两条（编码规范、提交信息格式）。',
  '- 这句话在问「之前那个 X 和 Y」：X 与 Y 各自成条，因为它们在记忆里极可能落在不同的节点上。',
  '每条查询只承载一个意图，用 `intent` 标明它是哪一类。',
  '',
  '## 什么时候不要拆',
  '- 同义改写的复合词不要拆。「代码风格约定」是一个词，不要拆成「代码」「风格」「约定」三条。',
  '- 一句话里的修饰成分不要单独成条：「我上周让你改的那个部署脚本」只有「部署脚本」一个检索对象。',
  '判断标准是「这两条查询会不会命中不同的记忆」：不会就合并成一条。',
  '',
  '## 指代与改写',
  '- 历史里出现的指代必须改写成完整查询：「那它呢」「上面那个方案」要看最近几轮对话里它指的是什么，用完整名词重写。',
  '- 重写只能改写措辞（补全省略的主语、把指代换成名词），**不能加入原 query 与历史里都没有的概念**。历史里没提到的东西不要猜。',
  '- 用 `derivedFrom` 填原 query 里对应的片段（**原文片段，不是重写后的文本**），这样调用方能在界面上解释「这条查询是从哪句话来的」。原 query 没有对应片段的，填 `null`。',
  '',
  '## 置信度',
  '`confidence` 是这条查询「值得跑」的把握，取 0–1 的小数：0.9 表示几乎肯定能命中，0.3 表示只是有可能。不要为了凑满 5 条而给低置信度的查询。',
  '',
  '## 输出格式',
  '只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或其它文本。结构：',
  [
    '{',
    '  "queries": [',
    '    {',
    '      "text": "用户的代码风格偏好",',
    '      "intent": "preference",',
    '      "confidence": 0.9,',
    '      "derivedFrom": "编码规范"',
    '    }',
    '  ]',
    '}',
  ].join('\n'),
  `\`queries\` 最多 ${MAX_TYPED_QUERIES} 条，可以为空数组。`,
  '`intent` 只能是：preference（偏好、习惯、风格）/ fact（事实性知识）/ decision（做过的决定与理由）/ event（发生过的事）/ procedure（步骤、流程）/ other（其它）。',
].join('\n');

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
  return [
    '## 当前查询',
    input.query,
    '## 最近消息（越靠后越新）',
    renderRecentMessages(input.recentMessages),
    '## 可检索范围',
    renderScopes(input.knownScopes),
    '## 任务',
    '按上面的规则输出 JSON。',
  ].join('\n\n');
}
