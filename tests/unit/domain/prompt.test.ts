/**
 * 提示词模板的领域层验收（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 三组断言：
 *
 * 1. **模板引擎**：占位符解析、行号、未知变量、缺变量、单遍替换。
 * 2. **仓库里的 `prompts/*.md`**：六条模板都能通过校验——把「编辑模板发错」挡在
 *    启动之前，而不是等模型收到一条字面量提示词。
 * 3. **渲染快照**：改造前（提示词写死在 TS 里）的逐字节输出。改模板必须显式更新
 *    快照（`pnpm vitest -u`），否则「改一行提示词」会静默改变模型行为。
 */

import { describe, expect, it } from 'vitest';

import { readPromptDefault } from '../../../src/config/prompt-defaults.js';
import { ComemError } from '../../../src/domain/errors.js';
import {
  PROMPT_DEFINITIONS,
  PROMPT_IDS,
  listPromptPlaceholders,
  normalizePromptBody,
  promptDefinition,
  renderPromptBody,
  validatePromptBody,
  type PromptId,
} from '../../../src/domain/prompt.js';
import { BUILTIN_MEMORY_TYPES } from '../../../src/domain/memory-types/index.js';
import { Uri } from '../../../src/domain/uri.js';
import { buildExtractPrompt } from '../../../src/services/prompts/extract.js';
import { buildRewriteUserPrompt, REWRITE_SYSTEM_PROMPT } from '../../../src/services/prompts/rewrite.js';
import { buildSummaryPrompt } from '../../../src/services/prompts/summarize.js';

function expectError(run: () => unknown): ComemError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    return error as ComemError;
  }
  throw new Error('期望抛出 ComemError，但它正常返回了');
}

describe('提示词定义表', () => {
  it('覆盖全部标识，且顺序与 PROMPT_IDS 一致', () => {
    expect(PROMPT_DEFINITIONS.map((definition) => definition.id)).toEqual([...PROMPT_IDS]);
  });

  it('每条提示词都有短名字与至少一个变量说明', () => {
    for (const definition of PROMPT_DEFINITIONS) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.variables.length).toBeGreaterThan(0);
      for (const variable of definition.variables) {
        expect(variable.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('变量名在一条提示词内不重复', () => {
    for (const definition of PROMPT_DEFINITIONS) {
      const names = definition.variables.map((variable) => variable.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('仓库里的 prompts/*.md', () => {
  it.each([...PROMPT_IDS])('%s 的模板通过校验（没有拼错的变量）', (id) => {
    expect(() => {
      validatePromptBody(id, readPromptDefault(id));
    }).not.toThrow();
  });

  it('每条模板都真的用了变量（否则「可编辑」只是把提示词搬了个地方）', () => {
    for (const id of PROMPT_IDS) {
      expect(listPromptPlaceholders(id, readPromptDefault(id)).length).toBeGreaterThan(0);
    }
  });

  it('模板文件以换行结尾，读取后没有尾部空行', () => {
    for (const id of PROMPT_IDS) {
      expect(readPromptDefault(id).endsWith('\n')).toBe(true);
      expect(readPromptDefault(id).endsWith('\n\n')).toBe(false);
    }
  });
});

describe('normalizePromptBody', () => {
  it('去掉结尾的换行', () => {
    expect(normalizePromptBody('abc\n')).toBe('abc');
    expect(normalizePromptBody('abc\n\n\n')).toBe('abc');
  });

  it('保留行内与行尾空白', () => {
    expect(normalizePromptBody('a  \nb\t')).toBe('a  \nb\t');
  });

  it('空串与纯换行都归一到空串', () => {
    expect(normalizePromptBody('')).toBe('');
    expect(normalizePromptBody('\n\n')).toBe('');
  });
});

describe('listPromptPlaceholders', () => {
  it('按出现顺序列出变量与行号', () => {
    const body = '第一行\n{{pages}}\n\n{{messages}} 和 {{pages}}';
    expect(listPromptPlaceholders('extract-user', body)).toEqual([
      { name: 'pages', line: 2 },
      { name: 'messages', line: 4 },
      { name: 'pages', line: 4 },
    ]);
  });

  it('变量名两侧允许空白', () => {
    expect(listPromptPlaceholders('extract-user', '{{ pages }}')).toEqual([
      { name: 'pages', line: 1 },
    ]);
  });

  it('没有占位符时返回空数组', () => {
    expect(listPromptPlaceholders('extract-user', '纯文本，没有变量')).toEqual([]);
  });

  it('未闭合的 {{ 报错并带行号', () => {
    const error = expectError(() => listPromptPlaceholders('extract-user', '第一行\n{{ pages'));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('第 2 行');
    expect(error.details?.['line']).toBe(2);
  });

  it('变量名不合法时报错', () => {
    expectError(() => listPromptPlaceholders('extract-user', '{{ 1abc }}'));
    expectError(() => listPromptPlaceholders('extract-user', '{{pag-ess}}'));
  });

  it('三层花括号是语法错误（不做「尽量猜」的解析）', () => {
    expectError(() => listPromptPlaceholders('extract-user', '{{{pages}}}'));
  });
});

describe('validatePromptBody', () => {
  it('拼错的变量名被拒绝，并列出可用变量', () => {
    const error = expectError(() => validatePromptBody('extract-user', '## 已读记忆\n{{pagess}}'));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('第 2 行');
    expect(error.message).toContain('pagess');
    expect(error.message).toContain('pages');
    expect(error.details?.['variable']).toBe('pagess');
    expect(error.details?.['available']).toEqual(
      promptDefinition('extract-user').variables.map((variable) => variable.name),
    );
  });
});

describe('renderPromptBody', () => {
  it('替换全部占位符，未用到的变量被忽略', () => {
    const body = '## 已读记忆\n\n{{pages}}\n\n## 会话记录\n\n{{messages}}';
    expect(
      renderPromptBody('extract-user', body, { pages: 'P', messages: 'M', extra: '未使用' }),
    ).toBe('## 已读记忆\n\nP\n\n## 会话记录\n\nM');
  });

  it('只替换一遍：替换值里的 {{...}} 不会被二次解析', () => {
    const body = '{{pages}}';
    expect(renderPromptBody('extract-user', body, { pages: '{{messages}}' })).toBe('{{messages}}');
  });

  it('变量名两侧的空白不影响取值', () => {
    expect(renderPromptBody('extract-user', '{{ pages }}', { pages: 'P' })).toBe('P');
  });

  it('缺变量时抛错并说明是哪个变量', () => {
    const error = expectError(() => renderPromptBody('extract-user', '{{pages}}', {}));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('pages');
    expect(error.details?.['provided']).toEqual([]);
  });

  it('模板里的换行不影响渲染结果', () => {
    expect(renderPromptBody('extract-user', 'a\n', {})).toBe('a');
  });
});

describe('六条提示词的渲染快照', () => {
  const memoryTypes = Object.values(BUILTIN_MEMORY_TYPES);

  function extractWithPages() {
    return buildExtractPrompt({
      messages: [
        { role: 'user', content: '我更喜欢 2 空格缩进。' },
        { role: 'assistant', content: '记住了。' },
      ],
      memoryTypes,
      pages: [
        {
          pageId: 1,
          uri: 'comem://user/alice/memories/preferences/code-style.md',
          memoryType: 'preferences',
          content: '---\ntype: preferences\n---\n\n## content\n\n两空格缩进。',
        },
        {
          pageId: 2,
          uri: 'comem://user/alice/memories/profile.md',
          memoryType: 'profile',
          content: 'alice',
        },
      ],
      previousOverview: '上次聊到代码风格。',
      profileMaxChars: 800,
      today: '2026-11-08',
    });
  }

  function extractWithout() {
    return buildExtractPrompt({
      messages: [],
      memoryTypes,
      pages: [],
      profileMaxChars: 800,
      today: '2026-11-08',
    });
  }

  function summaryWithChildren() {
    return buildSummaryPrompt({
      uri: Uri.parse('comem://user/alice/memories'),
      children: [
        {
          uri: Uri.parse('comem://user/alice/memories/profile.md'),
          name: 'profile.md',
          kind: 'document',
          abstract: 'alice，后端工程师。',
        },
        {
          uri: Uri.parse('comem://user/alice/memories/preferences'),
          name: 'preferences',
          kind: 'directory',
          abstract: '偏好清单。',
        },
      ],
    });
  }

  /**
   * 每个快照对应「改造前写死在 TS 里的那一段」。改造是纯重构，九段文本一个字都
   * 不能变——变一位就是模型看到的东西变了，而这类改动在评审里最难看出来。
   */
  const fixtures: readonly { name: string; render: () => string }[] = [
    { name: 'extract-system', render: () => extractWithPages().system ?? '' },
    { name: 'extract-user', render: () => extractWithPages().messages[0]?.content ?? '' },
    { name: 'extract-user-no-overview', render: () => extractWithout().messages[0]?.content ?? '' },
    { name: 'summarize-system', render: () => summaryWithChildren().system ?? '' },
    { name: 'summarize-user', render: () => summaryWithChildren().messages[0]?.content ?? '' },
    {
      name: 'summarize-user-empty',
      render: () =>
        buildSummaryPrompt({ uri: Uri.parse('comem://user/alice/memories'), children: [] }).messages[0]
          ?.content ?? '',
    },
    { name: 'rewrite-system', render: () => REWRITE_SYSTEM_PROMPT },
    {
      name: 'rewrite-user',
      render: () =>
        buildRewriteUserPrompt({
          query: '我们组的代码风格约定还在吗',
          recentMessages: [
            { role: 'user', text: '我上次说的编码规范呢？' },
            { role: 'assistant', text: '两条：两空格缩进、提交信息用英文。' },
          ],
          knownScopes: ['comem://user/alice', 'comem://group/eng'],
        }),
    },
    {
      name: 'rewrite-user-empty',
      render: () => buildRewriteUserPrompt({ query: '你好', recentMessages: [], knownScopes: [] }),
    },
  ];

  it.each(fixtures)('$name', ({ render }) => {
    expect(render()).toMatchSnapshot();
  });

  it.each([...PROMPT_IDS])('%s 的默认模板本身可以原样渲染', (id: PromptId) => {
    const variables: Record<string, string> = {};
    for (const variable of promptDefinition(id).variables) {
      variables[variable.name] = `〔${variable.name}〕`;
    }
    const text = renderPromptBody(id, readPromptDefault(id), variables);
    expect(text).not.toContain('{{');
  });
});

/**
 * `renderProfileDirective` 的三个分支（架构文档 §11.1「超阈值重写」）。
 *
 * 快照只覆盖「未超上限」一个分支；另外两个分支如果走错，画像要么不收敛（超上限
 * 时不重写），要么根本没有画像时也不新建。这两条是收敛机制真正生效的地方，必须
 * 单独断言，不能只靠一条快照。
 */
describe('画像收敛指令（profileDirective）', () => {
  const memoryTypes = Object.values(BUILTIN_MEMORY_TYPES);
  const profilePage = (content: string) => ({
    pageId: 7,
    uri: 'comem://user/alice/memories/profile.md',
    memoryType: 'profile',
    content,
  });

  function systemWith(pages: ReturnType<typeof profilePage>[], profileMaxChars: number): string {
    return buildExtractPrompt({
      messages: [],
      memoryTypes,
      pages,
      profileMaxChars,
      today: '2026-11-08',
    }).system ?? '';
  }

  it('没有画像时要求新建，并带上今天日期', () => {
    const system = systemWith([], 800);
    expect(system).toContain('没有读到用户画像');
    expect(system).toContain('新建一条 `profile`');
    expect(system).toContain('2026-11-08');
  });

  it('超过上限时要求整份重写，而非增量 patch', () => {
    const body = '甲'.repeat(801); // 801 > 800
    const system = systemWith([profilePage(body)], 800);
    expect(system).toContain('已超上限');
    expect(system).toContain('replace content');
    expect(system).toContain('正文 801 字，上限 800 字');
    expect(system).not.toContain('未超上限');
  });

  it('未超上限时走增量维护，但保留格式不合规也要重写的出口', () => {
    const system = systemWith([profilePage('alice')], 800);
    expect(system).toContain('未超上限');
    expect(system).toContain('`patch` 增量维护');
    expect(system).toContain('整份重写');
    expect(system).not.toContain('已超上限');
  });
});
