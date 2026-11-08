/**
 * 提交管线第 4 步：摘要失效（架构文档 §9.3、§10.6）。
 *
 * 六条核心链路之一。写入记忆之后，它所在目录的摘要就落后了：`pendingChanges`
 * 要加一，攒够阈值再重算。传播与「到 scope 根停止」由 `SummaryService` 实现，
 * 这一步只负责**批量去重后调用**。
 *
 * ## 为什么要去重（§10.6「批量写入」）
 *
 * `invalidate(node)` 标记的是 `parent(node)`。同一目录下的 N 个文件各调一次，就是
 * N 次祖先标记，其中 N-1 次是重复的——100 个文件就是 200 次标记里 190 次白做。
 * 去重必须在**入口**做（按父目录分组），不能事后合并：标记本身有副作用
 * （`pendingChanges += 1`），重复标记会让目录摘要被判定为「落后很多次」，每次提交都
 * 触发全量重算。
 *
 * 删除也进失效集合：删掉一个记忆同样改变父目录的摘要，只是它不在 `written` 里。
 */

import type { Logger } from '../../../domain/log.js';
import type { Uri } from '../../../domain/uri.js';

import { CommitStep, type StepContext } from '../pipeline.js';
import { isMemoryMergeResult, MERGE_RESULT_KEY } from './memory-merge.js';

export interface SummaryInvalidateStepDeps {
  readonly summary: {
    invalidate(nodeUri: Uri): Promise<unknown>;
  };
  readonly logger: Logger;
}

export class SummaryInvalidateStep extends CommitStep {
  readonly name = 'summary_invalidate' as const;

  readonly #summary: SummaryInvalidateStepDeps['summary'];
  readonly #logger: Logger;

  constructor(deps: SummaryInvalidateStepDeps) {
    super();
    this.#summary = deps.summary;
    this.#logger = deps.logger;
  }

  async run(context: StepContext): Promise<void> {
    const merged = context.state.get(MERGE_RESULT_KEY);
    if (!isMemoryMergeResult(merged)) {
      // 没有写入就没有脏：上游步骤可以直接跳过（例如归档里没有值得保留的记忆）。
      // 重放时 `memory_merge` 会先 `rehydrate` 把结果从 `memory_diff.json` 读回来
      // （§10.4），所以走到这里意味着这次提交真的没有写任何记忆。
      this.#logger.debug('没有记忆写入，跳过摘要失效', {
        archive: context.archiveUri.toString(),
      });
      return;
    }

    const targets = [...merged.written, ...merged.deleted];

    // 每个父目录只留一个代表节点：`invalidate` 标记的是它的 parent，同一父目录下的
    // 其它文件标记的是同一个目录。
    const representative = new Map<string, Uri>();
    for (const uri of targets) {
      const parent = uri.parent();
      if (parent === null) {
        continue;
      }
      const key = parent.toString();
      if (!representative.has(key)) {
        representative.set(key, uri);
      }
    }

    for (const uri of representative.values()) {
      await this.#summary.invalidate(uri);
    }

    this.#logger.info('记忆摘要已失效', {
      archive: context.archiveUri.toString(),
      files: targets.length,
      directories: representative.size,
    });
  }
}
