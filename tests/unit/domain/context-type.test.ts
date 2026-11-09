/**
 * `contextTypeOf` 的归类矩阵（架构文档 §6.3、§6.5、§8.1）。
 *
 * 这条判断原先在 `services/index-observer.ts`、`services/summary.ts`、
 * `commands/reindex.ts` 各写一份。合并到领域层之后，矩阵在这里穷举：四个上下文
 * 目录、`projects/{pid}/` 的剥离、更深的段名不参与判断、认不出的路径兜底
 * `resource`。`tests/integration/commands/reindex-context-type-consistency.test.ts`
 * 负责对拍两条写索引的链路，这里只钉住纯函数的输入输出。
 */

import { describe, expect, it } from 'vitest';

import type { ContextType } from '../../../src/domain/node.js';
import { contextTypeOf } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

interface ContextTypeCase {
  readonly uri: string;
  readonly expected: ContextType;
}

const CASES: readonly ContextTypeCase[] = [
  // scope 根：没有上下文段，兜底 resource
  { uri: 'comem://user/alice', expected: 'resource' },

  // 四个上下文目录：目录自身与其中的文件、更深的子目录都归同一类
  { uri: 'comem://user/alice/memories', expected: 'memory' },
  { uri: 'comem://user/alice/memories/profile.md', expected: 'memory' },
  { uri: 'comem://user/alice/memories/preferences/code-style.md', expected: 'memory' },
  { uri: 'comem://user/alice/resources', expected: 'resource' },
  { uri: 'comem://user/alice/resources/paper.pdf', expected: 'resource' },
  { uri: 'comem://user/alice/skills', expected: 'skill' },
  { uri: 'comem://user/alice/skills/license-review/must-locate-license.md', expected: 'skill' },
  { uri: 'comem://user/alice/sessions', expected: 'session' },
  { uri: 'comem://user/alice/sessions/2026-11-09/summary.md', expected: 'session' },

  // 组空间与个人空间共用一套布局
  { uri: 'comem://group/eng/memories/decision.md', expected: 'memory' },
  { uri: 'comem://group/eng/projects/app/skills/review.md', expected: 'skill' },

  // 项目作用域：`projects/{pid}/` 先剥一层，再看下一段
  { uri: 'comem://user/alice/projects', expected: 'resource' },
  { uri: 'comem://user/alice/projects/comem', expected: 'resource' },
  { uri: 'comem://user/alice/projects/comem/memories', expected: 'memory' },
  { uri: 'comem://user/alice/projects/comem/memories/note.md', expected: 'memory' },
  { uri: 'comem://user/alice/projects/comem/resources/spec.pdf', expected: 'resource' },
  { uri: 'comem://user/alice/projects/comem/skills/style.md', expected: 'skill' },
  { uri: 'comem://user/alice/projects/comem/sessions/s1.md', expected: 'session' },

  // 不在任何已知目录下：兜底 resource
  { uri: 'comem://user/alice/notes/idea.md', expected: 'resource' },
  { uri: 'comem://user/alice/projects/comem/misc/other.md', expected: 'resource' },

  // 只看第一段：更深的段名不参与判断
  { uri: 'comem://user/alice/memories/archive/resources/paper.md', expected: 'memory' },
  { uri: 'comem://user/alice/projects/comem/resources/memories/note.md', expected: 'resource' },

  // `projects` 只在根下第一段才剥离；出现在更深的位置是普通目录名
  { uri: 'comem://user/alice/memories/projects/note.md', expected: 'memory' },
];

describe('contextTypeOf', () => {
  it.each(CASES)('$uri → $expected', ({ uri, expected }) => {
    expect(contextTypeOf(Uri.parse(uri))).toBe(expected);
  });

  it('矩阵覆盖全部四个 context_type', () => {
    const produced = new Set(CASES.map((entry) => entry.expected));
    expect([...produced].sort()).toEqual(['memory', 'resource', 'session', 'skill']);
  });
});
