/**
 * 导入源的装配（架构文档 §11.9）。
 *
 * 四个宿主各有一个 `LogSource` 实现，路径来自 `ingest.paths.<harness>`；空数组
 * 表示用各宿主的默认路径。装配放在这里而不是命令里：命令只解析参数、渲染报告，
 * 新增一个宿主时不应该改 CLI。
 */

import type { ComemConfig } from '../config/schema.js';
import type { IngestHarness } from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';

import type { LogSource } from './source.js';
import { ClaudeCodeSource } from './sources/claude-code.js';
import { CodexSource } from './sources/codex.js';
import { DeepSeekSource } from './sources/deepseek.js';
import { QwenSource } from './sources/qwen.js';

/** 联合类型的运行时清单。新增宿主时 TypeScript 不会提醒这里，测试会。 */
export const INGEST_HARNESSES: readonly IngestHarness[] = [
  'claude-code',
  'codex',
  'deepseek',
  'qwen',
];

export function isIngestHarness(value: string): value is IngestHarness {
  return INGEST_HARNESSES.some((harness) => harness === value);
}

export function createSources(config: ComemConfig, logger: Logger): readonly LogSource[] {
  const paths = config.ingest.paths;
  return [
    new ClaudeCodeSource({ paths: paths['claude-code'], logger }),
    new CodexSource({ paths: paths.codex, logger }),
    new DeepSeekSource({ paths: paths.deepseek, logger }),
    new QwenSource({ paths: paths.qwen, logger }),
  ];
}
