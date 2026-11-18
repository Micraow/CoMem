/**
 * 目录摘要输入的稳定 digest（架构文档 §9.3）。
 *
 * 子项先按名称、URI 排序，避免同一组输入因列目录顺序不同而触发无意义的模型调用。
 * `version` 是编码版本：摘要输入或归一化规则改变时，旧记录自然失配并重算一次。
 */

import { stableDigest } from './node.js';
import type { SummaryInput } from './summary.js';

export function digestSummaryInput(input: SummaryInput): string {
  const children = [...input.children].sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri < rightUri) return -1;
    if (leftUri > rightUri) return 1;
    return 0;
  });
  return stableDigest(JSON.stringify({
    // v2：status 进入输入。升级后旧的摘要输入自然失配，存量错误摘要会重建。
    version: 2,
    uri: input.uri.toString(),
    sourceText: input.sourceText ?? null,
    dialogue: input.dialogue ?? null,
    children: children.map((child) => ({
      uri: child.uri.toString(),
      name: child.name,
      kind: child.kind,
      status: child.status,
      abstract: child.abstract,
    })),
  }));
}
