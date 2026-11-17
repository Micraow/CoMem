import { z } from 'zod';

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { MemoryTypeSchema } from '../../domain/memory-type.js';
import { experiencesMemoryType } from '../../domain/memory-types/experiences.js';
import { preferencesMemoryType } from '../../domain/memory-types/preferences.js';
import { entitiesMemoryType } from '../../domain/memory-types/entities.js';
import { Uri } from '../../domain/uri.js';

import type { MemoryRecord, MemoryWrite, MemoryWriteResult } from '../memory.js';
import { renderMemoryUri } from '../memory.js';
import type { MemoryLinkService } from '../memory-link.js';
import type { ExistingExperience } from './archive-prompt.js';
import { validateExperienceEvidence } from './experience-evidence.js';
import { experienceSources } from './experience-sources.js';
import {
  historicalExperienceEvidence,
  renderExperienceContent,
} from './experience-render.js';

export { historicalExperienceEvidence, renderExperienceContent } from './experience-render.js';

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
 * 产品预算，不是质量阈值：`claimChars` 与 L0 的 256 字符预算同量级；单条明细
 * 上限和列表条数只限制提示词体积、输出成本与复核负担，不保证经验正确。
 */
const EXPERIENCE_BUDGET = {
  claimChars: 240,
  detailChars: 500,
  situation: 4,
  approach: 8,
  reflection: 6,
  evidence: 6,
} as const;

const claimSchema = z.string().min(1).max(EXPERIENCE_BUDGET.claimChars).regex(SINGLE_LINE_PATTERN);
const detailSchema = z.string().min(1).max(EXPERIENCE_BUDGET.detailChars).regex(SINGLE_LINE_PATTERN);
const messageIdSchema = z.string().min(1).max(256).regex(SINGLE_LINE_PATTERN);
const caseUriSchema = z.string().min(1).max(2_048).regex(SINGLE_LINE_PATTERN);

const experienceEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    messageId: messageIdSchema,
    role: z.enum(['user', 'assistant']),
    quote: detailSchema,
  }),
  z.strictObject({
    kind: z.literal('case'),
    caseUri: caseUriSchema,
    quote: detailSchema,
  }),
]);

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
 * `topic` 是 identity（决定文件路径）。`claim` 是能独立检索的结论；
 * `situation / approach / reflection` 分别承担适用边界、做法、结果与未决限制。
 * `evidence` 引用本次消息或已读取的具体案例；服务端写前核对 URI、逐字片段
 * 和可见案例集合。消息或案例都可以独立形成有效证据。
 * 服务端再确定性地渲染 `content`，不能让模型把引用伪装成实测。
 * schema 在这里而不是领域层，是因为 `generateJson` 需要把形状翻译成供应商的
 * JSON Schema；领域类型不带运行时信息（与 `memory-extract.ts` 同一份理由）。
 */
export const experienceSchema = z.strictObject({
  entityPages: z.array(z.number().int().positive()).optional(),
  category: z.string().min(1).max(80).regex(SLUG_PATTERN),
  topic: z.string().min(1).max(120).regex(SLUG_PATTERN),
  claim: claimSchema,
  situation: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.situation),
  approach: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.approach),
  reflection: z.array(detailSchema).min(1).max(EXPERIENCE_BUDGET.reflection),
  evidence: z.array(experienceEvidenceSchema).min(1).max(EXPERIENCE_BUDGET.evidence),
});

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
  cases: readonly MemoryRecord[],
  entities: readonly MemoryRecord[],
  assertWrite?: (uri: Uri) => Promise<boolean>,
): Promise<MemoryWriteResult[]> {
  const { memory, links, logger } = ports;
  // 先验证整批，再开始写入，避免第二条引用错误时第一条已经落盘。
  const citedCases = validateExperienceEvidence(experiences, context.messages, cases);
  const written: MemoryWriteResult[] = [];
  const seen = new Set<string>();
  for (const experience of experiences) {
    const { category, topic } = experience;
    const evidenceCases = citedCases.get(topic) ?? [];
    const provenance = experienceSources(evidenceCases, context.archiveUri);

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
      provenance: { sources: provenance, evidenceAt: evidenceTime(context.messages) },
      update: (current) => ({
        ...current,
        topic,
        category,
        content: renderExperienceContent(
          experience,
          historicalExperienceEvidence(typeof current['content'] === 'string' ? current['content'] : ''),
          context.archiveUri.toString(),
        ),
      }),
    }).catch((error: unknown) => {
      const failure = ComemError.from(error);
      if (failure.details?.['reason'] !== 'stale_evidence' && failure.details?.['reason'] !== 'forgotten_evidence') throw error;
      logger.warn('材料未覆盖当前经验记忆', { uri: uri.toString(), code: failure.details['reason'] }); return null;
    });
    if (write === null || !write.written) continue;
    written.push(write);

    try {
      await links.addLinks(uri, provenance.map((toUri) => ({ toUri, linkType: 'derived_from' })));
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
