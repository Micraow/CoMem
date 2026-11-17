import { validateOperations, type ConsolidationOperation } from '../../domain/consolidation.js';
import { ComemError } from '../../domain/errors.js';
import type { LlmPrompt } from '../../domain/llm.js';
import { memoryContentOf } from '../../domain/memory-type.js';
import { Uri } from '../../domain/uri.js';
import type { StepContext } from '../commit/pipeline.js';
import { pageContent, stripToolParts } from '../commit/steps/memory-extract.js';
import type { MemoryWriteResult } from '../memory.js';
import { applyPlans } from './apply.js';
import { buildExperiencePrompt } from './archive-prompt.js';
import { userEvidence, type PreferenceEvidence } from './evidence.js';
import { experienceContext, explicitPreferenceContext, writeExperiences } from './experience.js';
import { collectInventory } from './inventory.js';
import { consolidationOutputSchema, describeOperations, normalizeOperations, type ConsolidationOutput } from './output.js';
import { planOperations } from './plan.js';
import { buildConsolidationPrompt, withInferences } from './prompt.js';
import { writeInferences } from './preferences.js';
import type { DreamerOptions, DreamerResult, DreamerServiceDeps, DreamerTraceEntry, InventoryEntry } from './types.js';

export type { DreamerServiceDeps } from './types.js';

const emptyResult = { adds: [], updates: [], deletes: [], trace: [] };

export class DreamerService {
  readonly #deps: DreamerServiceDeps;

  constructor(deps: DreamerServiceDeps) {
    this.#deps = deps;
  }

  async fromArchive(context: StepContext): Promise<MemoryWriteResult[]> {
    const archive = this.#deps.archive;
    if (archive === undefined) throw new ComemError('INTERNAL', 'Dreamer 未接入归档端口。');
    if (!(await archive.canUse(context.scopeUri, context.archiveUri))) return [];
    const messages = stripToolParts(context.messages);
    if (messages.length === 0) return [];
    const { existing, entities } = await experienceContext(archive.memory, context, (uri) => archive.canUse(context.scopeUri, uri.parent() ?? uri));
    const currentEvidence = context.scopeUri.scope === 'user' ? userEvidence(context.archiveUri, context.messages) : [];
    const evidence = currentEvidence.length === 0 ? [] : [...currentEvidence, ...await archive.evidence(context.scopeUri, context.archiveUri)];
    const base = buildExperiencePrompt({
      messages, existing, today: new Date().toISOString().slice(0, 10),
      entities: entities.map((record, index) => ({ pageId: index + 1, content: pageContent(record), aliases: record.fields['aliases'] })),
    });
    const explicit = evidence.some(({ session }) => !session.equals(currentEvidence[0]?.session ?? session))
      ? await explicitPreferenceContext(archive.memory, context, (uri) => archive.canUse(context.scopeUri, uri.parent() ?? uri)) : [];
    const output = await this.#model(withInferences(base, evidence, explicit));
    if (output.action === 'read' || (output.operations?.length ?? 0) > 0) {
      throw new ComemError('INVALID_ARGUMENT', 'Dreamer 归档阶段只接受经验和待复核偏好。');
    }
    const authorize = (uri: Uri) => archive.canUse(context.scopeUri, uri.parent() ?? uri);
    const written = await writeExperiences(archive, context, output.experiences ?? [], entities, authorize);
    const inferred = await writeInferences(this.#deps, context.scopeUri, output.inferences ?? [], evidence, authorize, false, context.archiveUri);
    const writes = [...written, ...inferred.writes];
    this.#deps.logger.info('Dreamer 归档整理完成', { archive: context.archiveUri.toString(), written: writes.length });
    return writes;
  }

  async run(scope: Uri, options: DreamerOptions): Promise<DreamerResult> {
    const dryRun = options.dryRun ?? true;
    const directory = scope.child('memories');
    const canRead = async (uri: Uri) => (await options.canRead?.(uri) ?? true) && (await this.#deps.canShare?.(scope, uri) ?? true);
    const inventory = await collectInventory(this.#deps, directory, { ...options, canRead });
    const evidence = await this.#deps.archive?.evidence(scope) ?? [];
    if (inventory.candidates.length === 0 && new Set(evidence.map(({ session }) => session.toString())).size < 2) return emptyResult;
    const { operations, trace, inferences } = await this.#explore(scope, inventory.candidates, evidence, { ...options, canRead });
    const validation = validateOperations(operations, { existing: inventory.uris, allowedScopes: [directory.toStringAsDirectory()] });
    if ('error' in validation) throw new ComemError('INVALID_ARGUMENT', `模型产出的操作整批被拒绝：${validation.error}`, {
      scope: scope.toString(), operations: operations.map(({ kind, uri }) => `${kind} ${uri}`),
    });
    for (const operation of validation.valid) {
      const uri = Uri.parse(operation.uri);
      if (this.#deps.canShare !== undefined && !(await this.#deps.canShare(scope, uri))) {
        throw new ComemError('PERMISSION_DENIED', 'Dreamer 不能跨独立的目录权限整理记忆。');
      }
      await options.authorize?.(uri, operation.kind);
    }
    const plans = await planOperations(this.#deps, scope, validation.valid);
    const applied = await applyPlans(this.#deps, scope, plans, dryRun);
    const inferred = await writeInferences(this.#deps, scope, inferences ?? [], evidence,
      async (uri) => {
        if (this.#deps.canShare !== undefined && !(await this.#deps.canShare(scope, uri))) return false;
        await options.authorize?.(uri, 'add');
        return true;
      }, dryRun).catch((error: unknown) => {
      const failure = ComemError.from(error);
      throw new ComemError(failure.code, `Dreamer 写入偏好时失败：${failure.message}`, { ...applied, ...failure.details });
    });
    if (!dryRun) for (const uri of [...applied.adds, ...applied.updates, ...inferred.writes.map(({ uri }) => uri.toString())]) {
      await this.#deps.invalidate?.(Uri.parse(uri));
    }
    return { ...applied, adds: [...applied.adds, ...inferred.previews, ...inferred.writes.map(({ uri }) => uri.toString())], trace };
  }

  async #model(prompt: LlmPrompt): Promise<ConsolidationOutput> {
    const output = await this.#deps.llm.generateJson(prompt, consolidationOutputSchema, {
      purpose: 'dreamer',
    });
    if (output.action === undefined && output.experiences === undefined && output.inferences === undefined) {
      throw new ComemError('INVALID_ARGUMENT', 'Dreamer 模型没有返回可识别的操作。');
    }
    return output;
  }

  async #explore(scope: Uri, inventory: readonly InventoryEntry[], evidence: readonly PreferenceEvidence[], options: DreamerOptions): Promise<{
    operations: readonly ConsolidationOperation[]; trace: DreamerTraceEntry[]; inferences: ConsolidationOutput['inferences'];
  }> {
    const reads = new Map<string, string>();
    const trace: DreamerTraceEntry[] = [];
    const allowed = new Set(inventory.map(({ uri }) => uri));
    const maxIterations = this.#deps.maxIterations ?? 10; // 与配置默认相同；限制后台模型调用成本。
    const directory = scope.child('memories');
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const output = await this.#model(withInferences(buildConsolidationPrompt({
        scope: directory.toStringAsDirectory(), inventory, reads, iteration, maxIterations,
      }), evidence));
      if (output.action !== 'read') {
        if (output.action !== 'finish') throw new ComemError('INVALID_ARGUMENT', 'Dreamer 手动整理需要 read 或 finish 动作。');
        const operations = normalizeOperations(output);
        trace.push({ iteration, action: 'finish', readUris: [], summary: describeOperations(operations) });
        return { operations, trace, inferences: output.inferences };
      }
      const readUris = await this.#read(output.uris ?? [], allowed, directory, reads, options);
      trace.push({ iteration, action: 'read', readUris, summary: `请求读取 ${readUris.length} 条记忆的正文。` });
    }
    throw new ComemError('RESOURCE_EXHAUSTED', `记忆合并在 ${maxIterations} 轮内没有结束。没有应用任何操作。`, {
      scope: scope.toString(), maxIterations, read: [...reads.keys()],
    });
  }

  async #read(requested: readonly string[], allowed: ReadonlySet<string>, directory: Uri, reads: Map<string, string>, options: DreamerOptions) {
    if (requested.length === 0) throw new ComemError('INVALID_ARGUMENT', '记忆合并的 read 动作没有给出 uris。');
    const readUris: string[] = [];
    for (const raw of requested) {
      const uri = Uri.tryParse(raw);
      if (uri === null || !directory.isAncestorOf(uri)) throw new ComemError('INVALID_ARGUMENT', `请求读取 scope 外的路径：${raw}。`);
      const canonical = uri.toString();
      if (!allowed.has(canonical) || (options.canRead !== undefined && !(await options.canRead(uri)))) {
        throw new ComemError('NOT_FOUND', `记忆不在可读清单中：${canonical}。`);
      }
      const record = await this.#deps.memory.read(uri);
      if (record?.status !== 'active') throw new ComemError('NOT_FOUND', `记忆不在可读清单中：${canonical}。`);
      reads.set(canonical, memoryContentOf(record.fields));
      readUris.push(canonical);
    }
    return readUris;
  }
}
