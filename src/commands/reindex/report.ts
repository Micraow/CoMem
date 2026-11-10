/**
 * 输出约定：进度写 stderr，stdout 只留最终一行结果。
 *
 * 这样 `reindex > report.json` 拿到的是一份干净结果，而不是几万行进度。
 */

import type { ReindexResult } from './options.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function progress(
  scanned: number,
  total: number,
  rewritten: number,
  skipped: number,
  failed: number,
): void {
  process.stderr.write(
    `reindex: ${scanned}/${total} 已扫描，重写 ${rewritten}，跳过 ${skipped}，失败 ${failed}\n`,
  );
}

/**
 * 向量阶段的进度行。
 *
 * 与索引阶段的 `progress()` 分开：`--only=all` 里两段各自从 0 数到总数，共用一个
 * 分母会让「已扫描」在第二段开头倒退，读起来像是重跑了一遍。
 */
export function progressVectors(
  processed: number,
  total: number,
  embedded: number,
  skipped: number,
  failed: number,
): void {
  process.stderr.write(
    `reindex: 向量 ${processed}/${total} 已处理，补齐 ${embedded}，跳过 ${skipped}，失败 ${failed}\n`,
  );
}

/** CLI 的唯一一行 stdout：各段计数的固定格式。 */
export function formatReindexSummary(result: ReindexResult): string {
  return `reindex 完成：扫描 ${result.scanned}，重写 ${result.rewritten}，补齐向量 ${result.vectors} 条，重建关联边 ${result.links} 条，跳过 ${result.skipped}，失败 ${result.failed}。\n`;
}
