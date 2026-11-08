/**
 * 「模型关闭」提供者（架构文档 §4.4、§18 的 `providers.llm.default.type`）。
 *
 * `providers.embedding.type` / `providers.rerank.type` 的 `disabled` 是「不产生
 * 调用」。LLM 这边也一样：它**不是**曾经删掉的那个「返回空结果」的假提供者——假
 * 提供者让「阶段二从未真正执行」看起来像正常状态，而这里每个方法都明确失败。
 *
 * 选桩而不是让工厂返回 `null`：`LlmService` 与它的消费方（摘要、记忆抽取、合并、
 * 检索改写）都要求 `provider` 必填。返回 `null` 会把判空推到每一个调用点，还会
 * 让 `Container.llm` 的类型变成可空——一个配置项不该改变装配层的形状。
 *
 * 正常路径下调用不到它：`config/schema.ts` 的交叉校验保证 `type: disabled` 时
 * 没有功能会去调模型（摘要必须用规则生成器，合并必须关）。桩是防御性的第二道
 * 门：即使将来漏了某条交叉校验，后果也是 `INVALID_ARGUMENT`，而不是一个静默
 * 打出去的网络请求。
 */

import { ComemError } from '../../domain/errors.js';
import type { LlmProvider, LlmResult } from '../../domain/llm.js';

/** 关闭模型时调用方的错误消息。两个方法共用，避免同一件事有两种说法。 */
const DISABLED_MESSAGE =
  'providers.llm.default.type 是 disabled：没有可用的模型提供者，不能发起模型调用。';

function disabled(): never {
  throw new ComemError('INVALID_ARGUMENT', DISABLED_MESSAGE, {
    field: 'providers.llm.default.type',
  });
}

/**
 * 两个方法都不接收参数：桩不关心 prompt，声明成无参仍满足 `LlmProvider` 的签名
 * （TypeScript 允许实现少写参数）。这样也不会为了「用不到」而写出未使用变量。
 */
export class DisabledLlmProvider implements LlmProvider {
  async complete(): Promise<LlmResult> {
    return disabled();
  }

  async completeJson<T>(): Promise<T> {
    return disabled();
  }
}
