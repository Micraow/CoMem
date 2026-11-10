/**
 * 导入编排的装配与运行入口（架构文档 §11.9）。
 *
 * 只留三件事：校验构造参数、把端口收成一个对象、按来源驱动一次导入并汇总报告。
 * 具体职责在 `services/ingest/`：
 *
 * - 选项解析与来源筛选 → `options.ts`
 * - 单个会话的拉取 / 去重 / 游标 / 阶段一 → `session-ingest.ts`
 * - 阶段二的一批 → `extraction.ts`
 * - 报告累加器 → `stats.ts`；错误与时间戳小函数 → `support.ts`
 *
 * **游标与计数只存在于 `run()` 与 `ingestSessionAsync()` 的栈上。** 服务实例本身没有
 * 可变状态，`#ports` 构造后只读。
 */

import { ComemError, comemErrorMessage } from '../../domain/errors.js';

import { drainExtraction } from './extraction.js';
import {
  DEFAULT_EXTRACTION_BATCH_SIZE,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  parseBatchSize,
  parseSince,
  selectSources,
} from './options.js';
import type { IngestPorts } from './ports.js';
import { requireCursors, requireWriter } from './ports.js';
import { ingestSessionAsync } from './session-ingest.js';
import type { MutableReport } from './stats.js';
import { createExtraction, freezeExtraction } from './stats.js';
import { isBefore, locatorOf } from './support.js';
import type {
  IngestHarnessReport,
  IngestOptions,
  IngestReport,
  IngestServiceOptions,
} from './types.js';

export class IngestService {
  readonly #ports: IngestPorts;

  constructor(options: IngestServiceOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `ingest.batchSize 必须是正整数：${options.batchSize}`, {
        batchSize: options.batchSize,
      });
    }
    const extractionBatchSize = options.extractionBatchSize ?? DEFAULT_EXTRACTION_BATCH_SIZE;
    if (!Number.isInteger(extractionBatchSize) || extractionBatchSize <= 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `ingest.extractionBatchSize 必须是正整数：${extractionBatchSize}`,
        { extractionBatchSize },
      );
    }
    const extractionTimeoutMs = options.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
    if (!Number.isInteger(extractionTimeoutMs) || extractionTimeoutMs < 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `ingest.extractionTimeoutMs 必须是非负整数：${extractionTimeoutMs}`,
        { extractionTimeoutMs },
      );
    }
    this.#ports = {
      sources: options.sources,
      scopeUri: options.scopeUri,
      principals: options.principals,
      logger: options.logger,
      batchSize: options.batchSize,
      sessions: options.sessions,
      cursors: options.cursors,
      extraction: options.extraction,
      extractionSkip: options.extractionSkip,
      extractionBatchSize,
      extractionTimeoutMs,
    };
  }

  async run(options: IngestOptions = {}): Promise<IngestReport> {
    const ports = this.#ports;
    const dryRun = options.dryRun ?? false;
    const waitForExtraction = options.waitForExtraction ?? true;
    const extractionTimeoutMs = options.extractionTimeoutMs ?? ports.extractionTimeoutMs;
    // 「本该跑阶段二」的三个条件：不是 dry-run、用户要等、超时不为 0。
    const extractionRequested = !dryRun && waitForExtraction && extractionTimeoutMs > 0;
    // 没有可用模型时跳过阶段二，而不是让每个会话各失败一次。阶段一（归档）不依赖
    // 模型，先导进来本身就是价值；但报告必须说明记忆没被抽取。
    const skipReason = extractionRequested ? ports.extractionSkip : undefined;
    // dry-run 不写游标（可以传只读连接），真跑时在来源循环前失败。
    let writeCursors: NonNullable<IngestPorts['cursors']> | null = null;
    if (!dryRun) {
      requireWriter(ports.sessions);
      writeCursors = requireCursors(ports.cursors);
      if (
        extractionRequested &&
        skipReason === undefined &&
        ports.extraction === undefined
      ) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          '导入默认等待阶段二；要跳过抽取请显式传 waitForExtraction: false。',
          { field: 'extraction' },
        );
      }
    }

    const extraction =
      extractionRequested && skipReason === undefined ? createExtraction() : null;
    if (skipReason !== undefined) {
      ports.logger.warn('阶段二被跳过：providers.llm.default.type 是 disabled', {
        reason: skipReason,
      });
    }

    const since = parseSince(options.since);
    const batchSize = parseBatchSize(options.limitPerSession, ports.batchSize);
    const sources = selectSources(ports.sources, options.harnesses);
    const reports: IngestHarnessReport[] = [];

    for (const source of sources) {
      const report: MutableReport = {
        harness: source.harness,
        discovered: 0,
        skipped: 0,
        imported: 0,
        appended: 0,
        messages: 0,
        failed: 0,
        errors: [],
      };
      // 这一批「本次导入创建的任务」。阶段二按批跑：攒够 extractionBatchSize 个
      // 会话就等一批，避免 908 个会话全部导完才出进度。
      const batchTaskIds: string[] = [];

      try {
        for await (const ref of source.discoverSessions()) {
          report.discovered += 1;
          if (since !== null && isBefore(ref.startedAt, since)) {
            report.skipped += 1;
            continue;
          }
          try {
            const taskId = await ingestSessionAsync(
              ports,
              source,
              ref,
              report,
              writeCursors,
              batchSize,
            );
            if (taskId !== null) {
              batchTaskIds.push(taskId);
              if (extraction !== null && batchTaskIds.length >= ports.extractionBatchSize) {
                await drainExtraction(
                  ports,
                  source.harness,
                  batchTaskIds.splice(0).length,
                  extraction,
                  extractionTimeoutMs,
                );
              }
            }
          } catch (error) {
            report.failed += 1;
            report.errors.push({ locator: ref.locator, message: comemErrorMessage(error) });
            ports.logger.error('导入会话失败', {
              harness: source.harness,
              locator: ref.locator,
              nativeSessionId: ref.nativeSessionId,
              reason: comemErrorMessage(error),
            });
          }
        }
      } catch (error) {
        // 发现阶段失败（Qwen 整份导出不是合法 JSON）：整份文件不可用，明确记进
        // 报告，不静默返回 0 个会话。
        report.failed += 1;
        report.errors.push({
          locator: locatorOf(error) ?? `<${source.harness}>`,
          message: comemErrorMessage(error),
        });
        ports.logger.error('导入源发现失败', {
          harness: source.harness,
          reason: comemErrorMessage(error),
        });
      }

      // 适配器按文件跳过的损坏导出。它们不中断来源，但必须出现在报告里——
      // 「跳过了哪些文件」是用户判断「导入是不是完整」的唯一线索。
      for (const fileError of source.fileErrors ?? []) {
        report.failed += 1;
        report.errors.push(fileError);
      }

      // 这一批的最后几个会话（不足 extractionBatchSize 的余数）。放在 catch 之后：
      // 发现阶段失败时，失败之前已经建好的任务也要跑完，不能留在 pending。
      if (extraction !== null && batchTaskIds.length > 0) {
        await drainExtraction(
          ports,
          source.harness,
          batchTaskIds.splice(0).length,
          extraction,
          extractionTimeoutMs,
        );
      }

      reports.push(report);
      ports.logger.info('导入源完成', {
        harness: report.harness,
        discovered: report.discovered,
        skipped: report.skipped,
        imported: report.imported,
        appended: report.appended,
        messages: report.messages,
        failed: report.failed,
        extractionBatches: extraction?.batches.length ?? 0,
      });
    }

    return {
      harnesses: reports,
      extraction:
        extraction !== null
          ? freezeExtraction(extraction)
          : skipReason === undefined
            ? null
            : { skipped: true, reason: skipReason },
    };
  }
}
