/**
 * `find`：单条查询的语义检索（架构文档 §8.4、§13.2）。
 *
 * 这是「不知道内容在哪个目录」时的入口。已经知道路径的调用方应该用 `read`——多走
 * 一次检索只会更慢，而且 `read` 的报错更直接。
 */

import { asRecord, formatHits, textResult, type McpToolDefinition } from '../registry.js';

import {
  RETRIEVAL_FILTER_PROPERTIES,
  collectRetrievalArgs,
  singleOrUndefined,
  withDegradations,
} from './retrieval-args.js';

export const findTool: McpToolDefinition = {
  name: 'find',
  kind: 'read',
  description:
    '语义召回：按相关度降序返回摘要列表。不知道内容在哪、或要按「意思」找时用；已知路径用 read，正则匹配用 grep，要规则的完整正文用 rule_search。targetUri 传目录收窄范围，传文件只会命中它自己。返回不带分数：FTS5 / 向量 / 融合 / 重排四种引擎的分数量纲互不相同，跨引擎比数字没有意义，只有顺序可用。',
  inputSchema: {
    type: 'object',
    properties: RETRIEVAL_FILTER_PROPERTIES,
    required: ['query'],
  },
  async execute(input, context) {
    const args = await collectRetrievalArgs(asRecord(input, 'find'), 'find', context);

    // 本地索引 / ACL 阶段：超时归因要说得出「卡在本地」，不能笼统写「工具超时」。
    context.deadline?.mark('index');
    const result = await context.search.findWithDiagnostics(args.query, {
      scopes: args.scopes,
      subject: context.subject,
      principals: context.principals,
      limit: args.limit,
      levels: singleOrUndefined(args.level),
      contextTypes: singleOrUndefined(args.contextType),
      memoryTypes: args.memoryTypes,
      updatedAfter: args.updatedAfter,
      updatedBefore: args.updatedBefore,
      deadlineAt: context.deadline?.deadlineAt,
      onUpstream: (upstream) => context.deadline?.mark(upstream),
    });
    return textResult(
      withDegradations(context.config.retrieval.engine, result, formatHits(result.hits)),
    );
  },
};
