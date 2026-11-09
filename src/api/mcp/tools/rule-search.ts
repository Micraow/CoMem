/**
 * `rule_search`：按任务上下文取适用规则（架构文档 §11.5、§13.2）。
 *
 * 与 `find` 的差别是返回**完整正文**而不是摘要：规则要被执行，摘要不够。阈值
 * 默认 0.65（§13.2），低于它的规则宁可漏掉也不注入——错误的规则比没有规则更危险。
 *
 * ## 为什么阈值是相对的
 *
 * 三种引擎的分数量纲不同（§18 的 `retrieval.engine`）：`fts5` 是取负的 bm25，
 * `vector` 是余弦，`hybrid` 是 RRF 融合分（`Σ levelWeight / (60 + rank)`，上限
 * 约 `2/61 ≈ 0.033`）。**同一个绝对阈值跨引擎必然不可比**——把 `0.65` 交给
 * `search.find` 的 `scoreThreshold`，`hybrid` 下一条都留不下，工具静默返回 0 条。
 *
 * 规则要回答的是「这条规则和最佳规则差多少」，所以阈值按**本次最高分**的比例
 * 计算：`score >= topScore × threshold`。这个语义与引擎无关（RRF / bm25 / 余弦
 * 都成立），低分规则仍然进不来，默认 0.65 表示「只保留与最佳规则差距不到 35% 的」。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  formatDegradations,
  readScopes,
  requiredString,
  textResult,
  unitInterval,
  type McpToolDefinition,
} from '../registry.js';

/** 规则最多返回几条。经验值：注入超过 5 条规则时模型会开始挑，而不是遵守。 */
const RULE_LIMIT = 5;

/** §13.2 的默认阈值：相对于本次最高分的比例。 */
const DEFAULT_THRESHOLD = 0.65;

export const ruleSearchTool: McpToolDefinition = {
  name: 'rule_search',
  kind: 'read',
  description:
    '取「必须遵守的规则」的完整正文，不是摘要。动手做一件事之前用，taskContext 写「要做什么」而不是关键词；find 命中规则时只给摘要，判断依据得靠这里。threshold 是相对本次最高分的比例（默认 0.65），与检索引擎无关。没有规则时返回 Found 0，不是错误。',
  inputSchema: {
    type: 'object',
    properties: {
      taskContext: {
        type: 'string',
        description: '任务描述：要做什么、涉及哪些对象、有哪些已知约束',
      },
      threshold: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: DEFAULT_THRESHOLD,
        description:
          '相对阈值：只保留分数不低于本次最高分 × threshold 的规则；默认 0.65 表示只保留与最佳规则差距不到 35% 的规则',
      },
    },
    required: ['taskContext'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'rule_search');
    const taskContext = requiredString(args, 'taskContext', 'rule_search');
    const threshold = unitInterval(args, 'threshold', DEFAULT_THRESHOLD, 'rule_search');
    const scopes = await readScopes(context);

    // 先取够候选，**不把阈值下推给 `search.find`**：阈值作用在最终排序分上，
    // `hybrid` 的 RRF 分（约 0.03）会被 0.65 全部丢掉，结果在过滤之前就被截成 0。
    //
    // `memoryTypes: ['rules']` 是**下推**，不是事后过滤：索引在 SQL 的 WHERE 里
    // 排除其它记忆类型，所以「前 5 条命中都是偏好 / 实体」不会再把规则挤掉
    // （§8.3 的 `SearchQuery.memoryTypes`）。
    context.deadline?.mark('index');
    const result = await context.search.findWithDiagnostics(taskContext, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit: RULE_LIMIT,
      contextTypes: ['memory'],
      memoryTypes: ['rules'],
      deadlineAt: context.deadline?.deadlineAt,
      onUpstream: (upstream) => context.deadline?.mark(upstream),
    });

    // 相对阈值的基准取**规则**里的最高分：类型过滤已经保证 `hits` 全是规则，
    // 不需要再逐条 `stat` 补记忆类型（那会多一次 SQL，而且旧的「先取 N 条再筛」
    // 正是本工具返回空结果的根因）。
    const ruleHits = result.hits.map((hit) => ({ uri: hit.uri, score: hit.score }));
    const topScore = Math.max(...ruleHits.map((hit) => hit.score));
    const cutoff = topScore * threshold;

    const rules: string[] = [];
    // 逐条读正文是本地文件系统阶段；放在检索之后上报，超时归因才不会指向索引。
    context.deadline?.mark('filesystem');
    for (const hit of ruleHits) {
      if (hit.score < cutoff) {
        continue;
      }
      const uri = Uri.parse(hit.uri);
      try {
        const document = await context.filesystem.read(uri, context.principals);
        rules.push(`## ${hit.uri}\n${document.text.trim()}`);
      } catch (error) {
        // 索引与磁盘短暂不一致（刚删、刚移动）是正常状态：跳过这一条，不打断整次查询。
        if (error instanceof ComemError) {
          context.logger.warn('rule_search 跳过不可读的规则', {
            requestId: context.requestId,
            uri: hit.uri,
            code: error.code,
          });
          continue;
        }
        throw error;
      }
    }

    if (rules.length === 0) {
      return textResult(
        [
          'Found 0 applicable rule(s):',
          ...formatDegradations(context.config.retrieval.engine, result),
        ].join('\n'),
      );
    }
    return textResult(
      [
        `Found ${rules.length} applicable rule(s):\n\n${rules.join('\n\n')}`,
        ...formatDegradations(context.config.retrieval.engine, result),
      ].join('\n'),
    );
  },
};
