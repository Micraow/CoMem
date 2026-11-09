/**
 * 截断标记只有一份定义（架构文档 §13.2 的 `list` / `tree` / `read`）。
 *
 * 三个出口都会在正文末尾写一行标记表示「这不是全部内容」，宿主与控制台是按这个
 * 字符串本身识别截断的。任何一处改动——哪怕只差一个标点或一个空格——都会让那个
 * 出口静默地宣布「读完了」：用户拿到的是前 N 条，却没有任何信号提示。
 *
 * 行为等价由 `tests/integration/mcp/tools.test.ts` 与
 * `tests/integration/api/mcp-http-parity.test.ts` 断言。本文件是结构性断言：
 * `src/**` 里这个字符串字面量只能出现一次（在 `api/mcp/text.ts`），且三个出口
 * 必须从共享模块 import 并真的用它。行为测试只能证明「当前三处一致」，挡不住
 * 第四份定义长出来。
 *
 * `tests/` 自己不参与扫描：用例必须硬编码期望的字符串，否则断言就成了
 * 「实现和自己相等」。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRUNCATED_MARKER } from '../../../src/api/mcp/text.js';

const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url));

/** 三个产出截断标记的出口，相对 `src/`。 */
const EXIT_SOURCES = [
  'api/mcp/tools/tree.ts',
  'api/mcp/tools/list.ts',
  'api/mcp/tools/read.ts',
] as const;

/**
 * 带引号的标记字面量（单双引号都算）。故意不匹配反引号：JSDoc 里用反引号引用
 * 标记是说明文字，不是定义。
 */
const QUOTED_MARKER = /(['"])\.\.\. \(truncated\)\1/gu;

function collectSources(directory: string): { name: string; text: string }[] {
  const sources: { name: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...collectSources(path));
    } else if (entry.name.endsWith('.ts')) {
      sources.push({
        // 报告里用 `api/mcp/tools/list.ts` 这种写法，不依赖平台的路径分隔符。
        name: relative(SRC_ROOT, path).split(sep).join('/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return sources;
}

const SOURCES = collectSources(SRC_ROOT);

/** 每份源码里字符串字面量出现的次数（只统计真的定义了字面量的文件）。 */
const DEFINITION_COUNTS = SOURCES.map((source) => ({
  name: source.name,
  count: [...source.text.matchAll(QUOTED_MARKER)].length,
})).filter((entry) => entry.count > 0);

describe('TRUNCATED_MARKER', () => {
  it('文本不变：三个出口的标记逐字相同', () => {
    // 这是宿主与控制台识别的字符串本身，改它等于改协议，必须显式改这里。
    expect(TRUNCATED_MARKER).toBe('... (truncated)');
  });
});

describe('截断标记只有一份定义', () => {
  it('src/ 里这个字符串字面量只出现一次，且在共享模块里', () => {
    expect(DEFINITION_COUNTS).toEqual([{ name: 'api/mcp/text.ts', count: 1 }]);
  });

  for (const name of EXIT_SOURCES) {
    it(`${name} 从共享模块 import，没有自己的字面量`, () => {
      const source = SOURCES.find((entry) => entry.name === name);
      expect(source).toBeDefined();
      const text = source?.text ?? '';

      // 自己抄一份定义（哪怕值暂时相同）就是第二份真相。
      expect([...text.matchAll(QUOTED_MARKER)]).toHaveLength(0);
      expect(text).toContain("import { TRUNCATED_MARKER } from '../text.js';");
      // import 之外至少还有一处使用：只剩 import 时说明输出已经绕开共享常量，
      // 这时候标记的文本可以和共享模块完全不同。
      expect([...text.matchAll(/TRUNCATED_MARKER/gu)].length).toBeGreaterThan(1);
    });
  }
});
