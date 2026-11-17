/**
 * 装配阶段 6a：阶段二提交执行器（§10.1、§10.3、§10.4）。
 *
 * 五个步骤的顺序 §10.3 定死：`archive_summary` → `memory_extract` → `memory_merge` →
 * `summary_invalidate` → `dreamer`。合并必须在失效之前（失效步骤读合并写进
 * `state` 的「真正写过的文件」集合），经验归纳最后（不读前四步 `state`）。
 */

import { COMMIT_STEP_NAMES } from '../../domain/archive.js';
import type { CommitStepName, CommitStepSkipReason } from '../../domain/archive.js';
import type { Uri } from '../../domain/uri.js';
import { CommitPipeline } from '../../services/commit/pipeline.js';
import type { CommitPhase, CommitStep } from '../../services/commit/pipeline.js';
import { ArchiveSummaryStep } from '../../services/commit/steps/archive-summary.js';
import { DreamerStep } from '../../services/commit/steps/dreamer.js';
import { MemoryExtractStep } from '../../services/commit/steps/memory-extract.js';
import { MemoryMergeStep } from '../../services/commit/steps/memory-merge.js';
import { SummaryInvalidateStep } from '../../services/commit/steps/summary-invalidate.js';
import { createArchiveArtifacts, createArchivePorts } from '../archive-ports.js';
import { CommitRunner } from '../commit-runner.js';
import type { Foundation } from './foundation.js';
import type { MemoryStack } from './memory.js';
import type { Models } from './models.js';
import type { Retrieval } from './retrieval.js';
import { llmSkipReason } from '../../config/readiness.js';

/**
 * 阶段二执行器（§10.1、§10.3、§10.4）。端口绑定归档目录，所以管线按任务现造
 * （`archive-ports.ts` 的文件头）。位置必须在 `MemoryService` 之后——五个步骤要用它
 * 与 `SummaryService`。
 *
 * 没有可用模型时跳过调模型的三步：`DisabledLlmProvider` 抛 `INVALID_ARGUMENT`，而它
 * 是终态错误——第一次就把任务置 `failed`，归档永远停在 `archive_summary`。阶段一不
 * 依赖模型，缺模型只让阶段二的产物消失。判据与 `ingest` 的
 * `{ skipped, reason }` 相同，显式停用与占位地址分别记录原因。
 */
export function createCommitRunner(
  core: Foundation,
  models: Models,
  retrieval: Retrieval,
  memoryStack: MemoryStack,
  phase: CommitPhase,
): CommitRunner {
  const { config, logger, dataDir, store, metadata, memoryLink } = core;
  const { llm } = models;
  const { summary, task } = retrieval;
  const { memory, dreamer } = memoryStack;

  const skipReason = llmSkipReason(config);
  const commitSkippedSteps =
    skipReason !== null
      ? new Map<CommitStepName, CommitStepSkipReason>([
          ['memory_extract', skipReason],
          ['memory_merge', skipReason],
          ['dreamer', skipReason],
        ])
      : new Map<CommitStepName, CommitStepSkipReason>();

  return new CommitRunner({
    tasks: task,
    createPipeline: (archiveUri, onStepsChanged) => {
      const archivePorts = createArchivePorts(archiveUri, {
        store,
        metadata,
        logger,
        dataDir,
        onStepsChanged,
      });
      const ports = {
        ...archivePorts,
        prepareProjectScope: async (projectScopeUri: Uri) => {
          await store.mkdir(projectScopeUri, { recursive: true });
          await retrieval.indexObserver.onNodeWritten(projectScopeUri, 'directory');
        },
      };
      const archiveArtifacts = createArchiveArtifacts(archiveUri, {
        store,
        metadata,
        logger,
        dataDir,
      });
      // 名字 → 实现。`Record<CommitStepName, CommitStep>`：`COMMIT_STEP_NAMES` 加一步
      // 时这里编译失败。数组写法漏一步只表现为那一步永远不跑。
      const stepByName: Readonly<Record<CommitStepName, CommitStep>> = {
        archive_summary: new ArchiveSummaryStep({
          summary,
          llm,
          metadata,
          workingMemory: { enabled: config.memory.workingMemory.enabled },
          logger,
        }),
        memory_extract: new MemoryExtractStep({
          memory,
          llm,
          archive: archiveArtifacts,
          logger,
          profile: { maxChars: config.memory.profile.maxChars },
        }),
        memory_merge: new MemoryMergeStep({
          memory,
          archive: archiveArtifacts,
          links: memoryLink,
          logger,
        }),
        summary_invalidate: new SummaryInvalidateStep({ summary, logger }),
        dreamer: new DreamerStep({ dreamer, archive: archiveArtifacts, invalidate: (uri) => summary.invalidate(uri) }),
      };
      return new CommitPipeline({
        steps: COMMIT_STEP_NAMES.map((name) => stepByName[name]),
        ports,
        skippedSteps: commitSkippedSteps,
        // 后台阶段计时（§17.2）：管线在任务里跑，`phase()` 会写进程级 gauge。
        phase,
        logger,
      });
    },
    logger,
    concurrency: config.task.concurrency,
  });
}
