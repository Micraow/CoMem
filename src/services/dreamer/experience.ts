import { z } from 'zod';

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';
import { experiencesMemoryType } from '../../domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../domain/memory-types/preferences.js';
import { entitiesMemoryType } from '../../domain/memory-types/entities.js';
import type { Uri } from '../../domain/uri.js';

import type { MemoryRecord, MemoryWrite, MemoryWriteResult } from '../memory.js';
import { renderMemoryUri } from '../memory.js';
import type { MemoryLinkService } from '../memory-link.js';
import type { ExistingExperience } from './archive-prompt.js';

import type { StepContext } from '../commit/pipeline.js';
import { evidenceTime } from '../memory/evidence.js';
import {
  DEFAULT_PREFETCH_TOP_N,
  pageContent,
  retrievalQuery,
} from '../commit/steps/memory-extract.js';

export interface ExperiencePorts {
  readonly memory: {
    /**
     * §11.3 的预取。归纳用它取「已有经验」：同 topic 的旧正文要参与合并，
     * 没读到的旧正文会被当成不存在，整段重写就变成了覆盖丢失。
     */
    prefetch(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      query: string,
      topN: number,
    ): Promise<readonly MemoryRecord[]>;
    upsertMemory(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      input: MemoryWrite,
    ): Promise<MemoryWriteResult>;
  };
  readonly links: Pick<MemoryLinkService, 'addLinks'>;
  readonly logger: Logger;
}

/**
 * 一条归纳结果。
 *
 * `topic` 是 identity（决定文件路径），`content` 是整段正文。schema 在这里而不是
 * 领域层，是因为 `generateJson` 需要把形状翻译成供应商的 JSON Schema；领域类型
 * 不带运行时信息（与 `memory-extract.ts` 的 `extractOutputSchema` 同一份理由）。
 */
export const experienceSchema = z.object({
  entityPages: z.array(z.number().int().positive()).optional(),
  topic: z.string(),
  content: z.string(),
});

/** 一条记忆记录 → 提示词里的「已有经验」。正文取 `content` 字段，不带标题。 */
function toExisting(record: MemoryRecord): ExistingExperience {
  const topic = record.fields['topic'];
  return {
    topic: typeof topic === 'string' ? topic : record.uri.toString(),
    content: pageContent(record),
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
}

export async function experienceContext(memory: ExperiencePorts['memory'], context: StepContext, canUse: (uri: Uri) => Promise<boolean>) {
  const query = retrievalQuery(context.messages);
  const existing = await memory.prefetch(context.scopeUri, experiencesMemoryType, query, DEFAULT_PREFETCH_TOP_N);
  const entities = await memory.prefetch(context.scopeUri, entitiesMemoryType, query, DEFAULT_PREFETCH_TOP_N);
  const filter = async (records: readonly MemoryRecord[]) => (await Promise.all(records.map(async (record) => await canUse(record.uri) ? [record] : []))).flat();
  return { existing: (await filter(existing)).map(toExisting), entities: await filter(entities) };
}

export async function explicitPreferenceContext(memory: ExperiencePorts['memory'], context: StepContext, canUse: (uri: Uri) => Promise<boolean>) {
  const records = await memory.prefetch(context.scopeUri, preferencesMemoryType, retrievalQuery(context.messages), DEFAULT_PREFETCH_TOP_N);
  const visible = await Promise.all(records.filter((record) => record.memoryType === preferencesMemoryType.type && !record.uri.name.startsWith('inferred-'))
    .map(async (record) => await canUse(record.uri) ? { topic: record.fields['topic'], content: pageContent(record) } : null));
  return visible.filter((record) => record !== null);
}

export async function writeExperiences(
  ports: ExperiencePorts,
  context: StepContext,
  experiences: readonly z.infer<typeof experienceSchema>[],
  entities: readonly MemoryRecord[],
  assertWrite?: (uri: Uri) => Promise<boolean>,
): Promise<MemoryWriteResult[]> {
  const { memory, links, logger } = ports;
  const written: MemoryWriteResult[] = [];
  const seen = new Set<string>();
  for (const experience of experiences) {
    const { topic, content } = experience;

    if (content.trim() === '') {
      // 空正文是一条坏经验，不是整批结论：跳过它，其余条目照常写。
      logger.warn('经验正文为空，跳过这一条', {
        archive: context.archiveUri.toString(),
        topic,
      });
      continue;
    }

    let uri: Uri;
    try {
      uri = renderMemoryUri(context.scopeUri, experiencesMemoryType, { topic });
    } catch (error) {
      // `renderPath` 拒绝含 `/`、`..`、反斜杠或控制字符的 identity：模型给出的
      // topic 拼不出合法路径时跳过这一条，不让整个归档失败。
      logger.warn('经验 topic 拼不出合法路径，跳过这一条', {
        archive: context.archiveUri.toString(),
        topic,
        error: ComemError.from(error).message,
      });
      continue;
    }

    if (seen.has(uri.toString())) continue;
    seen.add(uri.toString());
    if (assertWrite !== undefined && !(await assertWrite(uri))) continue;
    const invalidEntity = experience.entityPages?.some((page) => entities[page - 1]?.entityId === undefined) ?? false;
    if (invalidEntity) logger.warn('经验引用了未提供的实体页面，保留原有引用。', { topic, entityPages: experience.entityPages });
    const write = await memory.upsertMemory(context.scopeUri, experiencesMemoryType, {
      uri,
      ...(experience.entityPages === undefined || invalidEntity ? {} :
        { structure: { entityRefs: experience.entityPages.flatMap((page) => entities[page - 1]?.entityId ?? []) } }),
      provenance: { sources: [context.archiveUri], evidenceAt: evidenceTime(context.messages) },
      update: (current) => ({ ...current, topic, content }),
    }).catch((error: unknown) => {
      const failure = ComemError.from(error);
      if (failure.details?.['reason'] !== 'stale_evidence' && failure.details?.['reason'] !== 'forgotten_evidence') throw error;
      logger.warn('材料未覆盖当前经验记忆', { uri: uri.toString(), code: failure.details['reason'] }); return null;
    });
    if (write === null || !write.written) continue;
    written.push(write);

    try {
      await links.addLinks(uri, [{ toUri: context.archiveUri, linkType: 'derived_from' }]);
    } catch (error) {
      logger.error('记忆关联边写入失败，已忽略：记忆已落盘，可从 sources 重建。', {
        archive: context.archiveUri.toString(),
        uri: uri.toString(),
        error: ComemError.from(error).message,
      });
    }
  }

  return written;
}
