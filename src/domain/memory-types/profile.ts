import type { MemoryTypeSchema } from '../memory-type.js';

/**
 * 用户画像（架构文档 §11.1、§6.5 的 `memories/profile.md`）。
 *
 * 单文件类型：整个 scope 只有一条，filename 里没有占位符，identity 只作为
 * 合并时的记录标识。
 *
 * **`description` 会原样渲染进抽取提示词**（`services/prompts/extract.ts` 的
 * `renderMemoryTypes`）。它不是写给人看的摘要，而是给模型的判定规则：收录范围、
 * 路由表、格式契约与反例缺一条，模型就会把不属于画像的内容塞进来。实测 8 次归档
 * 把类型签名、配置值与参数含义写进了画像——不是模型不听话，是这里只写了「基本
 * 信息、职业与工作方式」，而「工作方式」这个词把技术细节也包进去了。
 *
 * 改这里等于改模型行为，不是改注释。
 */
export const profileMemoryType = {
  type: 'profile',
  description: [
    '用户画像：这个人是「谁」的稳定身份。整份注入每次会话的开头，是固定成本，只装跨会话仍成立的事实。',
    '',
    '**收录**（当前成立、换个会话也不变）：',
    '- 姓名或常用称谓、年龄段、籍贯与当前所在地；',
    '- 当前学历、职业与雇主（如「后端工程师，做分布式存储」）；',
    '- 关系状态、长期健康状况；',
    '- 稳定的沟通风格与语言偏好（如「先给结论」「用中文回答」）。',
    '',
    '**不收录**：',
    '- 一次性技术细节：类型签名、配置项与取值、常量含义、代码片段、命令、文件路径；',
    '- 只对当前任务成立的临时状态（正在改哪个文件、这次卡在哪、刚跑了什么）；',
    '- 从对话里推断出的动机与能力，以及对性格的评价（如「他很严谨」「对并发敏感」）。',
    '',
    '**路由**（下列内容不属于画像，写到对应类型）：',
    '- 某个日期发生的转变、已完成的事件、做过的决定 → `events`（如「2026-10 离职」）；',
    '- 喜好、习惯、对做法的取舍 → `preferences`（如「偏好 2 空格缩进」）；',
    '- 具体的项目、库、工具、组织、第三方人物 → `entities`（如「`Settings::nextHop` 是三级映射」）；',
    '- 必须遵守的约束、可复用的流程 → `rules` / `experiences`；',
    '- 只对当前会话成立的上下文 → 丢弃。',
    '',
    '**格式契约**：',
    '- 正文是一组 bullet，不带小标题，一条一个事实；',
    '- 每条以 `(as of YYYY-MM-DD)` 结尾，日期用今天；',
    '- 单条不超过 30 字（日期后缀不算）；',
    '- 同一个可变状态只保留最新值，不留历史：职业变了就替换，不写「之前是 X，现在是 Y」；',
    '- 陈述事实，不写评价与推断。',
    '',
    '**反例**（下面这些都不该出现在画像里）：',
    '- 「`periodic_monitor_interval = MicroSeconds(3)`」→ 配置事实，属于 `entities`；',
    '- 「用户正在改 `memory-extract.ts` 的阈值判断」→ 一次性任务状态，丢弃；',
    '- 「用户对并发问题很敏感」→ 性格评价，丢弃。',
  ].join('\n'),
  directory: 'memories',
  filename: 'profile.md',
  operationMode: 'upsert',
  fields: [
    {
      name: 'name',
      type: 'string',
      identity: true,
      required: true,
      description: '用户的名字或常用称呼',
    },
    {
      name: 'role',
      type: 'string',
      merge: 'patch',
      description: '职业、岗位或主要角色，如「后端工程师」',
    },
    {
      name: 'content',
      type: 'string',
      merge: 'patch',
      description: '画像正文：按上面的格式契约写的稳定身份条目（不是技术栈清单）',
    },
    {
      name: 'updatedAt',
      type: 'string',
      merge: 'replace',
      description: '最后更新时间，ISO 8601 时间串',
    },
  ],
} satisfies MemoryTypeSchema;
