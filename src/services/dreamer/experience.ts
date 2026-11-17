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

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE_LINE_PATTERN = /^\S(?:.*\S)?$/u;

/**
 * 产品预算，不是质量阈值。
 *
 * `claimChars` 与 L0 的 256 字符预算同量级；单条明细上限和列表条数用于限制提示词
 * 体积、模型输出成本与复核负担。通过这些边界不代表经验正确，语义仍由证据、
 * 适用范围和人工复核保证。
 */
const EXPERIENCE_BUDGET = {
  claimChars: 240,
  detailChars: 500,
  appliesWhen: 4,
  procedure: 8,
  limitations: 6,
  evidence: 6,
} as const;

const claimSchema = z
  .string()
  .min(1)
  .max(EXPERIENCE_BUDGET.claimChars)
  .regex(SINGLE_LINE_PATTERN);
const detailSchema = z
  .string()
  .min(1)
  .max(EXPERIENCE_BUDGET.detailChars)
  .regex(SINGLE_LINE_PATTERN);

export interface ExperiencePorts {
  /** active 与 pending 记录；用于发现同 topic 冲突，防止未读正文被覆盖。 */
  listCurrent(
    scopeUri: Uri,
    schema: MemoryTypeSchema,
  ): Promise<readonly MemoryRecord[]>;
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
    read(uri: Uri): Promise<MemoryRecord | null>;
    upsertMemory(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      input: MemoryWrite,
    ): Promise<MemoryWriteResult>;
  };
  readonly links: Pick<MemoryLinkService, 'addLinks'>;
  readonly logger: Logger;
}

export interface ExperienceCatalogEntry {
  readonly uri: string;
  readonly category?: string;
  readonly topic: string;
  readonly summary: string;
  readonly status: MemoryRecord['status'];
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

/**
 * 一条归纳结果。
 *
 * `topic` 是 identity（决定文件路径）。其余字段形成一份可机械校验的经验契约；
 * 服务端再确定性地渲染 `content`，不能由模型把偏好、单题步骤和泛泛说明混成一段。
 * schema 在这里而不是领域层，是因为 `generateJson` 需要把形状翻译成供应商的
 * JSON Schema；领域类型不带运行时信息（与 `memory-extract.ts` 同一份理由）。
 */
export const experienceSchema = z.object({
  entityPages: z.array(z.number().int().positive()).optional(),
  category: z.string().min(1).max(80).regex(SLUG_PATTERN),
  topic: z.string().min(1).max(120).regex(SLUG_PATTERN),
  claim: claimSchema,
  appliesWhen: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.appliesWhen),
  procedure: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.procedure),
  limitations: z.array(detailSchema).max(EXPERIENCE_BUDGET.limitations),
  evidence: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.evidence),
});

/** 结构化归纳结果 → 给人阅读、供检索的 Markdown 正文。 */
export function renderExperienceContent(experience: z.infer<typeof experienceSchema>): string {
  const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  const steps = experience.procedure.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    experience.claim,
    `## 适用条件\n\n${bullets(experience.appliesWhen)}`,
    `## 做法\n\n${steps}`,
    ...(experience.limitations.length === 0 ? [] : [`## 限制\n\n${bullets(experience.limitations)}`]),
    `## 证据\n\n${bullets(experience.evidence)}`,
  ].join('\n\n');
}

/** 一条记忆记录 → 提示词里的「已有经验」。正文取 `content` 字段，不带标题。 */
export function existingExperienceFromRecord(record: MemoryRecord): ExistingExperience {
  const topic = record.fields['topic'];
  const category = record.fields['category'];
  const existing: ExistingExperience = {
    topic: typeof topic === 'string' ? topic : record.uri.toString(),
    content: pageContent(record),
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
  return typeof category === 'string' ? { ...existing, category } : existing;
}

function toCatalogEntry(record: MemoryRecord): ExperienceCatalogEntry {
  const category = record.fields['category'];
  const topic = record.fields['topic'];
  const summary = pageContent(record).replace(/\s+/gu, ' ').trim();
  const entry: ExperienceCatalogEntry = {
    uri: record.uri.toString(),
    topic: typeof topic === 'string' ? topic : record.uri.toString(),
    summary: summary.length <= 240 ? summary : `${summary.slice(0, 240)}…`,
    status: record.status,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
  return typeof category === 'string' ? { ...entry, category } : entry;
}

export async function experienceContext(ports: ExperiencePorts, context: StepContext, canUse: (uri: Uri) => Promise<boolean>) {
  const query = retrievalQuery(context.messages);
  const filter = async (records: readonly MemoryRecord[]) => (await Promise.all(records.map(async (record) => await canUse(record.uri) ? [record] : []))).flat();
  const [catalog, existing, entities] = await Promise.all([
    ports.listCurrent(context.scopeUri, experiencesMemoryType),
    ports.memory.prefetch(context.scopeUri, experiencesMemoryType, query, DEFAULT_PREFETCH_TOP_N),
    ports.memory.prefetch(context.scopeUri, entitiesMemoryType, query, DEFAULT_PREFETCH_TOP_N),
  ]);
  return {
    catalog: (await filter(catalog)).map(toCatalogEntry),
    existing: (await filter(existing)).map(existingExperienceFromRecord),
    entities: await filter(entities),
  };
}

export async function explicitPreferenceContext(ports: ExperiencePorts, context: StepContext, canUse: (uri: Uri) => Promise<boolean>) {
  const records = await ports.listCurrent(context.scopeUri, preferencesMemoryType);
  const visible = await Promise.all(records.filter((record) => record.status === 'active' && record.memoryType === preferencesMemoryType.type && !record.uri.name.startsWith('inferred-'))
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
    const { category, topic } = experience;
    const content = renderExperienceContent(experience);

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
      update: (current) => ({ ...current, topic, category, content }),
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
