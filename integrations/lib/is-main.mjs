/**
 * 入口判定：这个模块是被直接执行，还是被测试 import。
 *
 * 六个 `servers/*.mjs` 逐字重复同一个表达式。它**必须收 `import.meta.url` 作参数**：
 * `import.meta` 属于调用方那个模块，共享模块里取到的是它自己的地址。
 *
 * 符号链接不走这里。`bin` 装出来的入口（`cli.mjs`）与 stdio 代理
 * （`mcp-proxy.mjs`）要取 realpath 再比——`argv[1]` 是链接路径时字符串比较永远
 * 不相等。两处各自实现，不合并。
 */

import { pathToFileURL } from 'node:url';

/**
 * @param {string} moduleUrl 调用方的 `import.meta.url`
 */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}
