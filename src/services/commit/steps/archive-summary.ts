/**
 * 提交管线第 1 步：归档摘要（架构文档 §9.1、§9.2、§10.1、§10.5）。
 *
 * 归档目录 `archive_NNN/` 本身是一个目录节点：它的 `.abstract.md` 是 L0，
 * `.overview.md` 是 L1。这一步把它按 §9.2 自底向上生成出来，后续步骤（记忆抽取、
 * 摘要失效）依赖它已有的摘要基线。
 *
 * ## 工作记忆（§10.5）
 *
 * `memory.workingMemory.enabled` 为真时，除了目录摘要，还要维护一份 6 段结构化
 * 工作记忆，写在归档目录的 `.overview.md`。它的作用是「让下一次提交的抽取知道上次
 * 聊到哪了」——没有它，每次提交都是孤立的一次抽取，判断不了「这个偏好是延续还是
 * 改变」。
 *
 * v1 默认关闭：它要多一次 LLM 调用，只在长会话场景有价值（§18 的
 * `memory.workingMemory.enabled`）。关闭时这一步就是一次普通的目录摘要重建。
 *
 * 开启时工作记忆**替换**归档目录的 L1，L0 从它提取（§9.1 的两层不矛盾）——所以
 * 先重建目录摘要、再覆盖，而不是二选一：目录摘要为空的归档在控制台上看起来像坏数据。
 */

import type { MetadataFileStore } from '../../../adapters/fs/metadata-file.js';
import { ComemError } from '../../../domain/errors.js';
import type { LlmPrompt } from '../../../domain/llm.js';
import type { Logger } from '../../../domain/log.js';
import { renderMessageText, type SessionMessage } from '../../../domain/session.js';
import { extractAbstract } from '../../../domain/summary.js';

import type { LlmService } from '../../llm.js';
import type { SummaryService } from '../../summary.js';

import { CommitStep, type StepContext } from '../pipeline.js';

export interface WorkingMemoryInput {
  readonly messages: readonly SessionMessage[];
  /** 上一个归档的工作记忆；第一次提交为 `null`（§10.5） */
  readonly previousOverview: string | null;
}

export interface ArchiveSummaryStepDeps {
  readonly summary: Pick<SummaryService, 'regenerate'>;
  readonly llm: Pick<LlmService, 'generate'>;
  readonly metadata: Pick<MetadataFileStore, 'writeSummary'>;
  readonly workingMemory: {
    /** §18 的 `memory.workingMemory.enabled`，v1 默认 `false` */
    readonly enabled: boolean;
  };
  readonly logger: Logger;
}

/** 6 段工作记忆的结构（架构文档 §10.5 的代码块，逐字对应）。 */
const WORKING_MEMORY_SECTIONS = [
  '## 分析',
  '## 主要请求与意图',
  '## 关键概念',
  '## 待办',
  '## 背景约束',
  '## 相关上下文',
] as const;

function buildWorkingMemoryPrompt(input: WorkingMemoryInput): LlmPrompt {
  const system = [
    '你是 CoMem 的会话归档器。把一段刚结束的会话压缩成一份结构化的工作记忆，',
    '让下一次提交能判断「这次聊的偏好是延续还是改变」。',
    '',
    '## 输出结构',
    '只输出 Markdown 正文，不要 frontmatter，不要代码块，不要解释：',
    [
      '# 会话工作记忆',
      '',
      '**一行概述**：[主题]：[意图] | [结果] | [状态]',
      '',
      ...WORKING_MEMORY_SECTIONS.flatMap((section) => [section, '', '<内容>', '']),
    ].join('\n'),
    '## 约束',
    '- 六个二级标题必须原样出现，顺序不变，每段都要写；没有内容时写「无」。',
    '- 一行概述放在正文最前面，不单独占一个标题。',
    '- 只写会话里真的出现过的事实，不要编造。',
  ].join('\n');

  const transcript =
    input.messages.length === 0
      ? '（这次没有会话消息。）'
      : input.messages.map((message) => `### ${message.role}\n${renderMessageText(message)}`).join('\n\n');

  const sections = [`## 会话记录`, transcript];
  if (input.previousOverview !== null && input.previousOverview.trim() !== '') {
    // §10.5：上一个归档的概览让抽取知道「上次聊到哪」。放在会话记录之前，
    // 模型先看到历史再看这次的增量，叙述顺序与时间顺序一致。
    sections.unshift('## 上一次归档的工作记忆', input.previousOverview);
  }
  sections.push('## 任务', '按上面的结构输出工作记忆。');

  return { system, messages: [{ role: 'user', content: sections.join('\n\n') }] };
}

export class ArchiveSummaryStep extends CommitStep {
  readonly name = 'archive_summary' as const;

  readonly #summary: ArchiveSummaryStepDeps['summary'];
  readonly #llm: ArchiveSummaryStepDeps['llm'];
  readonly #metadata: ArchiveSummaryStepDeps['metadata'];
  readonly #workingMemory: ArchiveSummaryStepDeps['workingMemory'];
  readonly #logger: Logger;

  constructor(deps: ArchiveSummaryStepDeps) {
    super();
    this.#summary = deps.summary;
    this.#llm = deps.llm;
    this.#metadata = deps.metadata;
    this.#workingMemory = deps.workingMemory;
    this.#logger = deps.logger;
  }

  async run(context: StepContext): Promise<void> {
    const recomputed = await this.#summary.regenerate(context.archiveUri);
    this.#logger.debug('归档摘要已生成', {
      archive: context.archiveUri.toString(),
      directories: recomputed.length,
    });

    if (!this.#workingMemory.enabled) {
      return;
    }

    const result = await this.#llm.generate(
      buildWorkingMemoryPrompt({
        messages: context.messages,
        previousOverview: context.latestArchiveOverview,
      }),
    );
    const overview = result.text;
    if (overview.trim() === '') {
      throw new ComemError('PROVIDER_UNAVAILABLE', '工作记忆生成结果为空，已中止这次提交。', {
        archive: context.archiveUri.toString(),
      });
    }

    await this.#metadata.writeSummary(context.archiveUri, extractAbstract(overview), overview, {
      generatedBy: 'llm',
      generatedAt: new Date().toISOString(),
      degraded: false,
    });
    this.#logger.info('归档工作记忆已生成', {
      archive: context.archiveUri.toString(),
      overviewChars: overview.length,
    });
  }
}
