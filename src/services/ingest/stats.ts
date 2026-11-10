/**
 * 运行期的可变统计（不进报告）：按 harness 的计数与阶段二累加器。
 *
 * 只有 `run()` 持有这两个对象；它们被显式传给会话落地与阶段二函数，不藏在模块级。
 */

import type { IngestHarness } from '../../domain/ingest.js';

import type {
  IngestError,
  IngestExtractionBatchReport,
  IngestExtractionReport,
} from './types.js';

export interface MutableReport {
  harness: IngestHarness;
  discovered: number;
  skipped: number;
  imported: number;
  appended: number;
  messages: number;
  failed: number;
  errors: IngestError[];
}

export interface MutableExtraction {
  tasksCompleted: number;
  tasksFailed: number;
  /** 全部批次写入的记忆 URI → 类型；用来算「抽取条数」的去重总数。 */
  readonly memories: Map<string, string>;
  readonly pendingReview: Set<string>;
  durationMs: number;
  readonly batches: IngestExtractionBatchReport[];
}

export function createExtraction(): MutableExtraction {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    memories: new Map(),
    pendingReview: new Set(),
    durationMs: 0,
    batches: [],
  };
}

export function freezeExtraction(extraction: MutableExtraction): IngestExtractionReport {
  return {
    skipped: false,
    tasksCompleted: extraction.tasksCompleted,
    tasksFailed: extraction.tasksFailed,
    memoriesExtracted: extraction.memories.size,
    memoriesPendingReview: extraction.pendingReview.size,
    durationMs: extraction.durationMs,
    batches: extraction.batches,
  };
}
