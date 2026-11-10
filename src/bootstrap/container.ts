/**
 * 装配模块的稳定路径。
 *
 * 实现按依赖域拆在 `container/` 下（见那里的 `index.ts`），这里只做 re-export：
 * `main.ts` / `commands/` / `tests/` 的 import 路径与对外符号逐字不变。
 */

export {
  FileResourceStorage,
  InheritingAuthorizer,
  assertDataDirWritable,
  createContainer,
  llmBaseUrlIsPlaceholder,
} from './container/index.js';
export type {
  Container,
  ContainerServices,
  CreateContainerOptions,
} from './container/index.js';
