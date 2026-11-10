/**
 * 编排层看到的端口集合（`IngestService` 的依赖），以及「必须注入」的判定。
 *
 * 端口由 `bootstrap/` 构造后经 `IngestServiceOptions` 传入；跨文件的编排函数只拿这个
 * 对象，不拿服务实例——状态由调用方显式传入，不在模块级藏一份。
 */

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';
import type { LogSource } from '../../ingest/source.js';

import type {
  ExtractionRunner,
  IngestExtractionSkipReason,
  IngestServiceOptions,
} from './types.js';

/** 一次导入运行中的全部依赖。字段与 `IngestServiceOptions` 的构造结果一一对应。 */
export interface IngestPorts {
  readonly sources: readonly LogSource[];
  readonly scopeUri: Uri;
  readonly principals: readonly string[];
  readonly logger: Logger;
  readonly batchSize: number;
  readonly sessions: IngestServiceOptions['sessions'];
  readonly cursors: IngestServiceOptions['cursors'];
  readonly extraction: ExtractionRunner | undefined;
  readonly extractionSkip: IngestExtractionSkipReason | undefined;
  readonly extractionBatchSize: number;
  readonly extractionTimeoutMs: number;
}

export function requireWriter(
  sessions: IngestPorts['sessions'],
): NonNullable<IngestPorts['sessions']> {
  if (sessions === undefined) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '导入需要会话服务；`dryRun` 之外必须注入 SessionService。',
    );
  }
  return sessions;
}
