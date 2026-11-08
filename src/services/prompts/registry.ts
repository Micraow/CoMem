/**
 * 提示词渲染器的进程级注册表（架构文档 §9.2、§18）。
 *
 * ## 为什么是模块级绑定，而不是构造参数
 *
 * 三条提示词的调用点不在本 wave 的文件所有权里（`services/search.ts`、
 * `services/summary.ts`、`services/commit/steps/memory-extract.ts`），而
 * `REWRITE_SYSTEM_PROMPT` 在 `search.ts` 里是一个**值**（`system: REWRITE_SYSTEM_PROMPT`），
 * 不是函数调用——它没法通过参数注入。
 *
 * 于是「数据库覆盖」只能通过一条进程级绑定进入渲染路径：
 *
 * - `bootstrap/container.ts` 构造 `PromptService` 之后调用 `bindPromptRenderer`；
 * - 控制台保存 / 重置覆盖时，`PromptService` 调 `notifyPromptRenderers`，
 *   `rewrite.ts` 重新渲染 `REWRITE_SYSTEM_PROMPT`。
 *
 * **这是模块级可变状态，与容器注入的约定冲突**（`api/http/routes/index.ts` 里写过
 * 为什么不用模块级单例）。代价换来的是「不改三个不属于本 wave 的文件」。下一个
 * wave 把 `PromptService` 注入 `SearchServiceDeps` / `MemoryExtractStepDeps` 之后，
 * 这个文件应当删掉，`REWRITE_SYSTEM_PROMPT` 变成一个普通函数调用。
 *
 * 未绑定时用**只读仓库默认模板**的渲染器：单元测试直接调 `buildExtractPrompt`
 * 不需要先起一个容器。
 */

import { readPromptDefault } from '../../config/prompt-defaults.js';
import { renderPromptBody, type PromptId } from '../../domain/prompt.js';

/** 把一条提示词渲染成字符串。`PromptService` 是它的唯一生产实现。 */
export interface PromptRenderer {
  render(id: PromptId, variables: Readonly<Record<string, string>>): string;
}

/** 只读 `prompts/*.md`（没有数据库覆盖）。容器起来之前的默认实现。 */
export const DEFAULT_PROMPT_RENDERER: PromptRenderer = {
  render: (id, variables) => renderPromptBody(id, readPromptDefault(id), variables),
};

let activeRenderer: PromptRenderer = DEFAULT_PROMPT_RENDERER;

const listeners = new Set<() => void>();

/** 当前生效的渲染器。模块级绑定，见文件头。 */
export function promptRenderer(): PromptRenderer {
  return activeRenderer;
}

/**
 * 换掉当前渲染器并通知订阅方。
 *
 * 通知是必需的：`REWRITE_SYSTEM_PROMPT` 是一个在模块求值时就渲染好的字符串，
 * 不重渲染的话「保存覆盖」对它无效——界面显示已保存、请求里仍是旧提示词。
 */
export function bindPromptRenderer(renderer: PromptRenderer): void {
  activeRenderer = renderer;
  notifyPromptRenderers();
}

/** 通知所有订阅方重新渲染。`PromptService` 在保存 / 重置之后调。 */
export function notifyPromptRenderers(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** 订阅「渲染器变了」。目前只有 `rewrite.ts` 的模块级常量需要它。 */
export function onPromptRendererChange(listener: () => void): void {
  listeners.add(listener);
}
