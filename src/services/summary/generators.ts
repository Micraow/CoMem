/**
 * L0 / L1 的两种生成策略（§9.2）。
 *
 * `LlmSummarizer` 调模型，`RuleSummarizer` 断网降级，由装配方按 `summary.generator`
 * 配置选择（§18）。降级不是静默的：`degraded` 写进 `.abstract.md` / `.overview.md`
 * 的 frontmatter，控制台的「监控」页与 `health` 工具读它（§9.2、§17.9）。
 *
 * 两个生成器都只产 L1，L0 由 `extractAbstract` 从 L1 正文提取——两层各生成一遍必然
 * 互相矛盾。预算（`truncateToChars`）在服务层执行，换任何生成器实现都不会超。
 */

import {
  ABSTRACT_MAX_CHARS,
  OVERVIEW_MAX_CHARS,
  extractAbstract,
  type DirectorySummary,
  type SummaryGenerator,
  type SummaryInput,
} from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import type { LlmService } from '../llm.js';
import { buildSummaryPrompt } from '../prompts/summarize.js';

/**
 * 首句终止符：中英文句号、叹号、问号与换行（§9.2 的「各自摘要首句」）。
 *
 * 只是规则摘要的切分启发式，不是完整的分句（`v1.2` 会在点处截断）。规则摘要本身
 * 就是降级产物，为此引入分词器不值得。
 */
const SENTENCE_TERMINATORS = /[。！？!?\n]/;

/** 空目录的规则摘要正文。与 `buildSummaryPrompt` 的「（这个目录是空的。）」同义。 */
const EMPTY_DIRECTORY_TEXT = '（这个目录是空的。）';

/** 生成器选项。两个预算同时进提示词，避免「提示词里 256、截断用 4000」。 */
export interface SummarizerOptions {
  readonly abstractMaxChars: number;
  readonly overviewMaxChars: number;
}

const DEFAULT_SUMMARIZER_OPTIONS: SummarizerOptions = {
  abstractMaxChars: ABSTRACT_MAX_CHARS,
  overviewMaxChars: OVERVIEW_MAX_CHARS,
};

/** 取一段摘要的首句；没有终止符时返回整段。 */
function firstSentence(text: string): string {
  const flat = text.trim();
  if (flat === '') {
    return '';
  }
  const index = flat.search(SENTENCE_TERMINATORS);
  return index < 0 ? flat : flat.slice(0, index + 1).trim();
}

/** 规则摘要的标题：目录名；scope 根没有名字，退回整串 URI。 */
function ruleTitle(uri: Uri): string {
  return uri.name === '' ? uri.toString() : uri.name;
}

/**
 * 调模型的摘要生成器（§9.2 的实现 1）。
 *
 * 只产 L1（`buildSummaryPrompt` 的四段结构），L0 由 `extractAbstract` 从 L1 正文
 * 提取——两层各生成一遍必然互相矛盾。
 *
 * **不在这里截断**：预算是 `SummaryService` 的职责（`truncateToChars`），生成器只
 * 负责「模型说了什么」。这样换一个生成器实现时预算仍然生效。
 */
export class LlmSummarizer implements SummaryGenerator {
  readonly #llm: LlmService;
  readonly #options: SummarizerOptions;

  constructor(llm: LlmService, options: SummarizerOptions = DEFAULT_SUMMARIZER_OPTIONS) {
    this.#llm = llm;
    this.#options = options;
  }

  async generate(input: SummaryInput): Promise<DirectorySummary> {
    const prompt = buildSummaryPrompt({
      uri: input.uri,
      children: input.children,
      abstractMaxChars: this.#options.abstractMaxChars,
      overviewMaxChars: this.#options.overviewMaxChars,
    });
    const result = await this.#llm.generate(prompt);
    return {
      abstract: extractAbstract(result.text),
      overview: result.text,
      degraded: false,
    };
  }
}

/**
 * 断网降级的摘要生成器（§9.2 的实现 2）。
 *
 * 不调模型，纯字符串拼接：一级标题 + 每个直接子节点一行「名字：摘要首句」。
 * 结果恒带 `degraded: true`——静默降级等于骗人（§17.9）。
 */
export class RuleSummarizer implements SummaryGenerator {
  async generate(input: SummaryInput): Promise<DirectorySummary> {
    const lines =
      input.children.length === 0
        ? [EMPTY_DIRECTORY_TEXT]
        : input.children.map((child) => {
            const sentence = firstSentence(child.abstract);
            return sentence === '' ? `- ${child.name}` : `- ${child.name}：${sentence}`;
          });
    const overview = [`# ${ruleTitle(input.uri)}`, '', ...lines].join('\n');
    return { abstract: extractAbstract(overview), overview, degraded: true };
  }
}
