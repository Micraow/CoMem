/**
 * 目录 L0/L1 元数据文件。每个文件单独原子替换；同一目录的两次双写串行执行，
 * 并用 frontmatter 生成信息识别来自不同代的 L0/L1。
 */

import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { fsErrorCode } from '../../domain/errors.js';
import type { FsErrorMapper } from './error-map.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import { writeFileStaged } from './atomic-write.js';
import { parseDocument, serializeDocument } from './frontmatter.js';
import { toDiskPath } from './path.js';

export const ABSTRACT_FILE_NAME = '.abstract.md';
export const OVERVIEW_FILE_NAME = '.overview.md';

export interface SummaryGeneration {
  readonly generatedBy: 'llm' | 'rule';
  readonly generatedAt?: string;
  readonly degraded?: boolean;
}

export interface SummaryFileContent {
  readonly abstract: string;
  readonly overview: string;
  readonly complete: boolean;
  readonly consistent: boolean;
  readonly generation: SummaryGeneration | null;
}

export interface SummaryFileStoreDeps {
  readonly dataDir: string;
  readonly logger: Logger;
  readonly mapError: FsErrorMapper;
}

const FRONTMATTER_KEYS = {
  generatedBy: 'generated_by',
  generatedAt: 'generated_at',
  degraded: 'degraded',
} as const;

function readGeneration(data: Readonly<Record<string, unknown>>): SummaryGeneration | null {
  const generatedBy = data[FRONTMATTER_KEYS.generatedBy];
  if (generatedBy !== 'llm' && generatedBy !== 'rule') {
    return null;
  }
  const generatedAt = data[FRONTMATTER_KEYS.generatedAt];
  const degraded = data[FRONTMATTER_KEYS.degraded];
  const generation: {
    generatedBy: 'llm' | 'rule';
    generatedAt?: string;
    degraded?: boolean;
  } = { generatedBy };
  if (typeof generatedAt === 'string') {
    generation.generatedAt = generatedAt;
  }
  if (typeof degraded === 'boolean') {
    generation.degraded = degraded;
  }
  return generation;
}

function toGenerationRecord(generation: SummaryGeneration): Record<string, unknown> {
  return {
    [FRONTMATTER_KEYS.generatedBy]: generation.generatedBy,
    ...(generation.generatedAt === undefined
      ? {}
      : { [FRONTMATTER_KEYS.generatedAt]: generation.generatedAt }),
    ...(generation.degraded === undefined
      ? {}
      : { [FRONTMATTER_KEYS.degraded]: generation.degraded }),
  };
}

function sameGeneration(
  left: SummaryGeneration | null,
  right: SummaryGeneration | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.generatedBy === right.generatedBy
    && left.generatedAt === right.generatedAt
    && left.degraded === right.degraded
  );
}

export class SummaryFileStore {
  readonly #dataDir: string;
  readonly #logger: Logger;
  readonly #mapError: FsErrorMapper;
  readonly #writeQueues = new Map<string, Promise<void>>();

  constructor(deps: SummaryFileStoreDeps) {
    this.#dataDir = deps.dataDir;
    this.#logger = deps.logger;
    this.#mapError = deps.mapError;
  }

  async read(directoryUri: Uri): Promise<SummaryFileContent> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    const [abstract, overview] = await Promise.all([
      this.#readDocument(join(directory, ABSTRACT_FILE_NAME), directoryUri),
      this.#readDocument(join(directory, OVERVIEW_FILE_NAME), directoryUri),
    ]);
    const content: SummaryFileContent = {
      abstract: abstract?.body ?? '',
      overview: overview?.body ?? '',
      complete: abstract !== null && overview !== null,
      consistent:
        abstract !== null
        && overview !== null
        && sameGeneration(abstract.generation, overview.generation),
      generation: overview?.generation ?? abstract?.generation ?? null,
    };
    this.#logger.debug('读取目录摘要', {
      uri: directoryUri.toString(),
      hasAbstract: abstract !== null,
      hasOverview: overview !== null,
    });
    return content;
  }

  async write(
    directoryUri: Uri,
    abstract: string,
    overview: string,
    generation?: SummaryGeneration,
  ): Promise<void> {
    const key = directoryUri.toString();
    const previous = this.#writeQueues.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.#writeNow(directoryUri, abstract, overview, generation));
    this.#writeQueues.set(key, write);

    try {
      await write;
    } finally {
      if (this.#writeQueues.get(key) === write) {
        this.#writeQueues.delete(key);
      }
    }
  }

  async #writeNow(
    directoryUri: Uri,
    abstract: string,
    overview: string,
    generation?: SummaryGeneration,
  ): Promise<void> {
    const directory = toDiskPath(this.#dataDir, directoryUri);
    await this.#ensureDirectory(directory, directoryUri);
    const abstractPath = join(directory, ABSTRACT_FILE_NAME);
    const overviewPath = join(directory, OVERVIEW_FILE_NAME);

    const abstractTemp = await this.#writeTemp(abstractPath, abstract, directoryUri, generation);
    let overviewTemp: string;
    try {
      overviewTemp = await this.#writeTemp(overviewPath, overview, directoryUri, generation);
    } catch (error) {
      await rm(abstractTemp, { force: true }).catch(() => undefined);
      throw error;
    }

    await this.#rename(abstractTemp, abstractPath, directoryUri);
    await this.#rename(overviewTemp, overviewPath, directoryUri);
    this.#logger.debug('写入目录摘要', {
      uri: directoryUri.toString(),
      abstractChars: abstract.length,
      overviewChars: overview.length,
      degraded: generation?.degraded ?? false,
    });
  }

  async #readDocument(
    absolute: string,
    directoryUri: Uri,
  ): Promise<{ readonly body: string; readonly generation: SummaryGeneration | null } | null> {
    let raw: string;
    try {
      raw = (await readFile(absolute)).toString('utf8');
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw this.#mapError(error, directoryUri);
    }
    const parsed = parseDocument(raw);
    return { body: parsed.body, generation: readGeneration(parsed.data) };
  }

  async #readFrontmatter(
    absolute: string,
    directoryUri: Uri,
  ): Promise<Readonly<Record<string, unknown>>> {
    try {
      return parseDocument((await readFile(absolute)).toString('utf8')).data;
    } catch (error) {
      if (isMissing(error)) {
        return {};
      }
      throw this.#mapError(error, directoryUri);
    }
  }

  async #writeTemp(
    absolute: string,
    body: string,
    directoryUri: Uri,
    generation: SummaryGeneration | undefined,
  ): Promise<string> {
    const existing = await this.#readFrontmatter(absolute, directoryUri);
    const data =
      generation === undefined ? existing : { ...existing, ...toGenerationRecord(generation) };
    return writeFileStaged(
      absolute,
      serializeDocument(body, data),
      (error) => this.#mapError(error, directoryUri),
    );
  }

  async #rename(temp: string, absolute: string, directoryUri: Uri): Promise<void> {
    try {
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw this.#mapError(error, directoryUri);
    }
  }

  async #ensureDirectory(directory: string, directoryUri: Uri): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw this.#mapError(error, directoryUri);
    }
  }
}

function isMissing(error: unknown): boolean {
  const code = fsErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}
