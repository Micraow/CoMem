import type { Uri } from '../../../domain/uri.js';
import { appendDreamerDiff, dreamerDiffEntry, type DreamerDiffArchive } from '../../dreamer/archive-diff.js';
import type { DreamerService } from '../../dreamer/service.js';
import { CommitStep, type StepContext } from '../pipeline.js';

export class DreamerStep extends CommitStep {
  readonly name = 'dreamer' as const;

  constructor(private readonly deps: {
    readonly dreamer: Pick<DreamerService, 'fromArchive'>;
    readonly archive: DreamerDiffArchive;
    readonly invalidate: (uri: Uri) => Promise<unknown>;
  }) { super(); }

  async run(context: StepContext): Promise<void> {
    const written = await this.deps.dreamer.fromArchive(context);
    await appendDreamerDiff(this.deps.archive, context.archiveUri, written.map(dreamerDiffEntry));
    for (const write of written) await this.deps.invalidate(write.uri);
  }
}
