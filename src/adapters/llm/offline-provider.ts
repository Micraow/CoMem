/**
 * 离线提供者：不连网络，对任何请求都返回**空结果**。
 *
 * ## 为什么需要它
 *
 * 归档管线的第二步（记忆抽取）和第一步（归档摘要，`generator: llm` 时）要调模型。
 * 没有模型凭据时任务会失败重试三次再进死信——这不是缺陷，是设计好的降级路径。
 * 但**演示与端到端测试不能因此停摆**：它们要验证的是「管线编排、步骤跳过、
 * `.done` 落盘、任务记账」这些**与模型无关**的部分。
 *
 * 有了它，`bash scripts/demo.sh` 和 CI 可以在完全离线的环境里跑通整条链路，
 * 而不用把「没有 API key」写进验收口径。
 *
 * ## 它返回什么
 *
 * 结构化输出返回「空操作列表」——`memory_extract` 的合法结论是「这次没有需要
 * 抽取的记忆」。这不是伪造数据：**空结果是真实语义的一个取值**，不是占位符。
 *
 * 文本输出返回一句固定说明，让日志里能看出「这次跑的是离线提供者」。
 *
 * ## 它不能用来做什么
 *
 * **不能用来验证抽取质量。** 需要验证「模型能不能从对话里抽出正确的记忆」时
 * 必须用真实模型或录制的响应（`FakeLlmProvider`）。这个类的存在理由是
 * 「绕开模型验证编排」，不是「替代模型」。
 */

import type { LlmPrompt, LlmProvider, LlmResult } from '../../domain/llm.js';
import type { ZodType } from 'zod';

/**
 * 结构化输出的候选空形状。
 *
 * 按顺序挑第一个能被 schema 接受的——这样换一个步骤（`memory_extract` /
 * `rewrite` / …）不用改这个类。**全部失败时抛出原始 Zod 错误**，而不是编一个
 * 能让调用方继续跑的值：那会把「schema 变了」变成「静默产出空结果」。
 */
const EMPTY_CANDIDATES: readonly unknown[] = [
  { operations: [] },
  { operations: [], skipped: [] },
  { queries: [] },
  {},
  [],
];

const OFFLINE_TEXT = '（离线提供者：没有连接模型，这条是占位输出。）';

export class OfflineLlmProvider implements LlmProvider {
  // 参数故意不声明：`no-unused-vars` 不认下划线前缀，而这两个参数确实用不上。
  // TypeScript 允许实现比接口少写形参。
  async complete(): Promise<LlmResult> {
    return {
      text: OFFLINE_TEXT,
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    };
  }

  async completeJson<T>(_prompt: LlmPrompt, schema: ZodType<T>): Promise<T> {
    let lastError: unknown = null;
    for (const candidate of EMPTY_CANDIDATES) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) {
        return parsed.data;
      }
      lastError = parsed.error;
    }
    // 抛 Zod 错误而不是 ComemError：`LlmService` 会把它当解析失败重试一次，
    // 重试仍失败就降级。让它走既有路径，不在这里另造一套错误语义。
    throw lastError;
  }
}
