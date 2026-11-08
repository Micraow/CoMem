/**
 * 提示词模板（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 提示词是**数据**：静态骨架放在仓库的 `prompts/*.md` 里，可以在控制台查看和修改；
 * 动态部分（记忆类型清单、页面列表、消息列表）由调用方渲染成字符串，用 `{{name}}`
 * 注入。本文件只做「解析 → 校验 → 替换」，不读文件、不碰数据库，可以穷举测试。
 *
 * ## 为什么是「变量注入」而不是模板引擎
 *
 * 动态部分不是「遍历数组再拼一下」：空列表要换成一句明确的话（「（这次没有预取到
 * 已读记忆。）」，否则模型会自己编造编号）、记忆类型要按字段展开成缩进列表、消息要
 * 按角色加小标题。这些是**领域渲染**，需要类型；`{{#each}}` 之类的语法把它降级成
 * 字符串，类型安全就没了，而且要为一条提示词引入一个模板引擎（AGENTS.md §6 反对
 * 为一个用途引入抽象）。
 *
 * 所以边界是：**骨架进模板，渲染留在代码**。模板只表达「哪一截放在哪里」，
 * 每一截的内容由带类型的纯函数生成。
 *
 * ## 单遍替换
 *
 * 替换值里的 `{{...}}` **不会**被二次解析：`String.prototype.replace` 收到函数时
 * 不会重新扫描替换结果。记忆正文里出现花括号是常态，二次解析会把用户的记忆当成
 * 模板语法。
 */

import { ComemError } from './errors.js';

/**
 * 六条提示词的稳定标识。
 *
 * 标识同时是 `prompts/{id}.md` 的文件名与数据库覆盖行的主键，**不要改**：改了等于
 * 让已有的覆盖静默失效（界面会显示成「没有覆盖」，用户以为自己的修改丢了）。
 * 展示用的中文说明在 `PROMPT_DEFINITIONS` 里。
 */
export const PROMPT_IDS = [
  'extract-system',
  'extract-user',
  'summarize-system',
  'summarize-user',
  'rewrite-system',
  'rewrite-user',
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/**
 * 模板里可用的一个变量。
 *
 * `description` 是给控制台看的：一条提示词的可编辑性建立在「知道哪些位置会被替换」
 * 上，只列变量名等于让用户去猜。说明里不出现内部术语（AGENTS.md §11）。
 */
export interface PromptVariable {
  readonly name: string;
  readonly description: string;
}

export interface PromptDefinition {
  readonly id: PromptId;
  /**
   * 控制台里的短名字，如「记忆抽取 · 系统提示词」。
   *
   * 不用 `id` 当展示名：`extract-system` 这种内部标识不属于用户可见区域
   * （AGENTS.md §11）。也不写「这条提示词在什么时候发给模型」这类长句——那是
   * 文档的事。
   */
  readonly description: string;
  /**
   * 渲染时一定会提供的变量。
   *
   * 模板里的 `{{x}}` 必须是这里的子集——拼错一个字母（`{{pagess}}`）在渲染前就
   * 报错，而不是把字面量发给模型。
   */
  readonly variables: readonly PromptVariable[];
}

/**
 * 六条提示词的目录。
 *
 * 顺序就是控制台的展示顺序：按「抽取 → 摘要 → 重写」的业务链路排，不按字母。
 */
export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
  {
    id: 'extract-system',
    description: '记忆抽取 · 系统提示词',
    variables: [
      { name: 'memoryTypes', description: '内置记忆类型清单（类型、目录、字段与合并策略）' },
      {
        name: 'profileDirective',
        description: '用户画像的当前字数、上限与这次的整份重写判断',
      },
      { name: 'newPageIdStart', description: '新建记忆的起始编号' },
      { name: 'newPageIdExamples', description: '从起始编号起连续三个编号，用于示例' },
    ],
  },
  {
    id: 'extract-user',
    description: '记忆抽取 · 用户消息',
    variables: [
      { name: 'pages', description: '预取到的已读记忆（编号、地址与正文）' },
      { name: 'previousOverviewSection', description: '上一次归档的概览整段；没有时为空' },
      { name: 'messages', description: '这次要抽取的会话消息' },
    ],
  },
  {
    id: 'summarize-system',
    description: '目录摘要 · 系统提示词',
    variables: [
      { name: 'abstractMaxChars', description: '简述的字数预算' },
      { name: 'overviewMaxChars', description: '整篇概览的字数预算' },
    ],
  },
  {
    id: 'summarize-user',
    description: '目录摘要 · 用户消息',
    variables: [
      { name: 'uri', description: '要生成摘要的目录' },
      { name: 'children', description: '直接子节点（名字、类别与摘要）' },
    ],
  },
  {
    id: 'rewrite-system',
    description: '查询重写 · 系统提示词',
    variables: [{ name: 'maxTypedQueries', description: '一次最多产出多少条查询' }],
  },
  {
    id: 'rewrite-user',
    description: '查询重写 · 用户消息',
    variables: [
      { name: 'query', description: '用户当前这句话' },
      { name: 'recentMessages', description: '最近几轮对话，越靠后越新' },
      { name: 'knownScopes', description: '调用方可见的路径范围' },
    ],
  },
];

/** 按标识取定义。标识是联合类型，查不到只可能是定义表漏了一项。 */
export function promptDefinition(id: PromptId): PromptDefinition {
  const definition = PROMPT_DEFINITIONS.find((candidate) => candidate.id === id);
  if (definition === undefined) {
    throw new ComemError('INTERNAL', `提示词定义缺失：${id}`, { promptId: id });
  }
  return definition;
}

const ID_SET: ReadonlySet<string> = new Set(PROMPT_IDS);

export function isPromptId(value: string): value is PromptId {
  return ID_SET.has(value);
}

/** 变量名：字母开头，后接字母、数字或下划线。 */
const VARIABLE_NAME = '[A-Za-z][A-Za-z0-9]*';

/** 合法的占位符。名字两侧允许空白（`{{ pages }}`），编辑器自动补空格时不至于报错。 */
const PLACEHOLDER_PATTERN = new RegExp(`\\{\\{(\\s*${VARIABLE_NAME}\\s*)\\}\\}`, 'g');

/** 一个占位符在模板里的位置。行号给「错误必须能定位」用（AGENTS.md §1）。 */
export interface PromptPlaceholder {
  readonly name: string;
  /** 1 起算的行号 */
  readonly line: number;
}

function lineOf(body: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (body.charCodeAt(cursor) === 0x0a) {
      line += 1;
    }
  }
  return line;
}

/**
 * 模板正文规范化：去掉结尾的换行。
 *
 * 文件以换行结尾是 POSIX 惯例，编辑器也会自动补一个；而模板的结尾换行没有意义，
 * 留在渲染结果里会让「同一条提示词」因为文件末尾多一个空行而不同。只去尾部，
 * 不动行尾空白——缩进可能是有意的。
 */
export function normalizePromptBody(body: string): string {
  return body.replace(/\n+$/, '');
}

/**
 * 列出模板里的全部占位符。
 *
 * 语法错误（`{{` 之后不是合法的变量名，或没有配对的 `}}`）在这里就抛：静默跳过会
 * 把 `{{ pages }` 当普通文本发给模型，而模型那边看不出它其实是一个没被替换的变量。
 */
export function listPromptPlaceholders(id: PromptId, body: string): readonly PromptPlaceholder[] {
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  const placeholders: PromptPlaceholder[] = [];
  let opening = body.indexOf('{{');
  while (opening >= 0) {
    pattern.lastIndex = opening;
    const match = pattern.exec(body);
    if (match === null || match.index !== opening) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `提示词 ${id} 第 ${String(lineOf(body, opening))} 行的 \`{{\` 没有配成合法的变量：变量要写成 \`{{name}}\`，名字只能包含字母、数字与下划线。`,
        { promptId: id, line: lineOf(body, opening), offset: opening },
      );
    }
    const name = (match[1] ?? '').trim();
    placeholders.push({ name, line: lineOf(body, opening) });
    opening = body.indexOf('{{', pattern.lastIndex);
  }
  return placeholders;
}

/**
 * 校验模板：语法合法，且用到的变量都在定义里。
 *
 * 未知变量按**第一个**报错，并列出可用变量——一次报一个能直接定位，全报出来用户
 * 还得自己找哪一行。
 */
export function validatePromptBody(id: PromptId, body: string): void {
  const definition = promptDefinition(id);
  const known = new Set(definition.variables.map((variable) => variable.name));
  const unknown = listPromptPlaceholders(id, normalizePromptBody(body)).find(
    (placeholder) => !known.has(placeholder.name),
  );
  if (unknown === undefined) {
    return;
  }
  const available = definition.variables
    .map((variable) => `\`${variable.name}\`（${variable.description}）`)
    .join('、');
  throw new ComemError(
    'INVALID_ARGUMENT',
    `提示词 ${id} 第 ${String(unknown.line)} 行引用了不存在的变量 \`${unknown.name}\`。可用变量：${available}。`,
    {
      promptId: id,
      variable: unknown.name,
      line: unknown.line,
      available: [...known],
    },
  );
}

/**
 * 渲染模板。
 *
 * 三个失败条件都必须抛错，不能把占位符原样留在结果里：
 *
 * 1. 模板语法错误（`listPromptPlaceholders`）；
 * 2. 模板用了定义外的变量——多半是拼写错误（`validatePromptBody`）；
 * 3. 模板需要的变量没有传——**这是唯一一个「代码少传了」的失败**，渲染成
 *    `{{pages}}` 字面量时模型会把它当成正文，而错误只会在模型的输出里出现。
 */
export function renderPromptBody(
  id: PromptId,
  body: string,
  variables: Readonly<Record<string, string>>,
): string {
  const template = normalizePromptBody(body);
  validatePromptBody(id, template);
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  return template.replace(pattern, (_whole, rawName: string) => {
    const name = rawName.trim();
    const value = variables[name];
    if (value === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `提示词 ${id} 需要变量 \`${name}\`，但渲染时没有提供。`,
        { promptId: id, variable: name, provided: Object.keys(variables) },
      );
    }
    return value;
  });
}
