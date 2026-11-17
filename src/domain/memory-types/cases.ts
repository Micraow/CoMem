import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 一次具体任务的案例。
 *
 * 它保留任务目标、实际尝试、具体输入/参数和观察结果，便于以后回答「当时怎么做的、
 * 结果是什么」。跨案例抽象出的可复用做法属于 `experiences`；这里的单次结果不能直接
 * 改写成普遍经验。
 */
export const casesMemoryType = {
  type: 'cases',
  description: [
    '具体任务案例：一次可以独立描述的任务，以及这次实际尝试和观察结果。',
    '',
    '**收录**：',
    '- 用户提出的明确任务，例如解题、调试、配置、实验、构建或内容制作；',
    '- 本次实际使用了什么方法、输入、参数、版本或操作顺序；',
    '- 实际观察到的结果、失败、限制、产物和仍待验证的部分；',
    '- 以后需要回答「当时怎么做的」「参数是多少」「为什么失败」时必须保留的细节。',
    '',
    '**不收录**：',
    '- 寒暄、随口讨论、没有独立任务或可核对结果的片段；',
    '- 只有助手猜测、预期结果，尚未实际尝试的内容；',
    '- 没有保留价值的一次计算；这种情况不写记忆，原会话已经足够。',
    '',
    '**路由**：',
    '- 用户稳定喜欢怎样工作、交流或选择 → `preferences`；',
    '- 某个时间真实发生、决定或完成的事实 → `events`；',
    '- 从多个案例中抽象出的同类做法 → `experiences`，抽取阶段不要输出；',
    '- 必须遵守的硬约束 → `rules`；',
    '- 只完成到哪一步、下一步且没有可复用结论时，保留为未完成案例或留在原会话。',
    '',
    '**正文契约**：首行写一句可独立理解的任务与结果摘要；随后用 `## 尝试`、',
    '`## 结果`、`## 证据` 记录实际过程和可核对结果。具体参数只在来源明确时保留，',
    '不得补算或猜测。',
  ].join('\n'),
  directory: 'memories/cases',
  filename: '{case}.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'case',
      type: 'string',
      identity: true,
      required: true,
      description: '具体任务案例标识，小写短横线；同类题目也应保留能区分本次任务的标识',
    },
    {
      name: 'task',
      type: 'string',
      merge: 'replace',
      required: true,
      description: '一句话说明本次任务目标、对象和必要约束',
    },
    {
      name: 'outcome',
      type: 'string',
      merge: 'replace',
      required: true,
      description: '观察结果：success / failure / partial / unfinished / unknown',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      required: true,
      description: '案例正文：首行结论，随后记录实际尝试、具体参数、结果与证据',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
