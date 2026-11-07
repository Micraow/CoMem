/**
 * `rule_search`：按任务上下文取适用规则（架构文档 §11.5、§13.2）。
 *
 * 与 `find` 的差别是返回**完整正文**而不是摘要：规则要被执行，摘要不够。阈值默认
 * 0.65（§13.2），低于它的规则宁可漏掉也不注入——错误的规则比没有规则更危险。
 */

import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  readScopes,
  requiredString,
  textResult,
  unitInterval,
  type McpToolDefinition,
} from '../registry.js';

/** 规则最多返回几条。经验值：注入超过 5 条规则时模型会开始挑，而不是遵守。 */
const RULE_LIMIT = 5;

/** §13.2 的默认阈值。 */
const DEFAULT_THRESHOLD = 0.65;

export const ruleSearchTool: McpToolDefinition = {
  name: 'rule_search',
  kind: 'read',
  description:
    '开始一项任务、需要知道有哪些硬性规则时必须先调用这个，用任务描述去匹配规则库。taskContext 写「要做什么」而不是关键词，规则靠语义相关度匹配；threshold 低于 0.65 容易把无关规则带进来。返回的是规则完整正文，不是摘要，可以直接据此执行。',
  inputSchema: {
    type: 'object',
    properties: {
      taskContext: { type: 'string', description: '任务描述，用于语义匹配规则' },
      threshold: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: DEFAULT_THRESHOLD,
        description: '相关度下限；低于它的规则不返回',
      },
    },
    required: ['taskContext'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'rule_search');
    const taskContext = requiredString(args, 'taskContext', 'rule_search');
    const threshold = unitInterval(args, 'threshold', DEFAULT_THRESHOLD, 'rule_search');
    const scopes = await readScopes(context);

    const hits = await context.search.find(taskContext, {
      scopes,
      subject: context.subject,
      principals: context.principals,
      limit: RULE_LIMIT,
      contextTypes: ['memory'],
      scoreThreshold: threshold,
    });

    const rules: string[] = [];
    for (const hit of hits) {
      if (hit.memoryType !== 'rules') {
        continue;
      }
      const uri = Uri.parse(hit.uri);
      try {
        const document = await context.filesystem.read(uri);
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
      return textResult('Found 0 applicable rule(s):');
    }
    return textResult(`Found ${rules.length} applicable rule(s):\n\n${rules.join('\n\n')}`);
  },
};
