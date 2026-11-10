/**
 * 阶段二的一批：驱动执行器、按批记时、把任务失败与超时写进报告。
 *
 * 累加器 `extraction` 由 `run()` 持有并传入；执行器端口来自 `IngestPorts`。执行器
 * 缺失时的抛出点仍在 try 之内，与搬移前一致：一批跑失败不该让整次导入变成异常。
 */

import { ComemError } from '../../domain/errors.js';
import type { IngestHarness } from '../../domain/ingest.js';

import type { IngestPorts } from './ports.js';
import type { MutableExtraction } from './stats.js';
import { errorMessage } from './support.js';
import type { ExtractionRunner, IngestExtractionBatch } from './types.js';

export async function drainExtraction(
  ports: IngestPorts,
  harness: IngestHarness,
  sessions: number,
  extraction: MutableExtraction,
  timeoutMs: number,
): Promise<void> {
  const index = extraction.batches.length + 1;
  const startedAt = Date.now();
  let batch: IngestExtractionBatch;
  try {
    batch = await requireExtraction(ports.extraction).run({ timeoutMs });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    extraction.durationMs += durationMs;
    extraction.batches.push({
      index,
      harness,
      sessions,
      tasksCompleted: 0,
      tasksFailed: 0,
      memoriesExtracted: 0,
      memoriesPendingReview: 0,
      durationMs,
      timedOut: false,
      error: errorMessage(error),
    });
    ports.logger.error('阶段二执行失败', {
      harness,
      batch: index,
      sessions,
      reason: errorMessage(error),
    });
    return;
  }

  if (batch.tasksAttempted === 0) {
    // 队列空：不产生空批次。计时也不累加——那是「等了一下」而不是「跑了一批」。
    return;
  }

  const durationMs = Date.now() - startedAt;
  extraction.tasksCompleted += batch.tasksCompleted;
  extraction.tasksFailed += batch.tasksFailed;
  extraction.durationMs += durationMs;
  for (const [uri, memoryType] of batch.memories) {
    extraction.memories.set(uri, memoryType);
  }
  for (const uri of batch.pendingReview) {
    extraction.pendingReview.add(uri);
  }

  extraction.batches.push({
    index,
    harness,
    sessions,
    tasksCompleted: batch.tasksCompleted,
    tasksFailed: batch.tasksFailed,
    memoriesExtracted: batch.memories.size,
    memoriesPendingReview: batch.pendingReview.length,
    durationMs,
    timedOut: batch.timedOut,
    error: null,
  });

  ports.logger.info('阶段二完成', {
    harness,
    batch: index,
    sessions,
    tasksCompleted: batch.tasksCompleted,
    tasksFailed: batch.tasksFailed,
    memoriesExtracted: batch.memories.size,
    memoriesPendingReview: batch.pendingReview.length,
    durationMs,
    timedOut: batch.timedOut,
  });
}

/** 阶段二执行器必须注入：否则导入会静默停在「任务已建、记忆没抽」。 */
function requireExtraction(
  extraction: IngestPorts['extraction'],
): ExtractionRunner {
  if (extraction === undefined) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '导入需要阶段二执行器；`waitForExtraction` 为 true 时必须注入 ExtractionRunner。',
    );
  }
  return extraction;
}
