/**
 * 模型提供方适配器（架构文档 §4.4）。
 *
 * `services/` 只依赖 `domain/llm.ts` 的 `LlmProvider` 接口；这里的两个实现由
 * `bootstrap/container.ts` 按配置装配，测试用 `FakeLlmProvider`。
 */

export { AiSdkLlmProvider, type AiSdkProviderOptions } from './ai-sdk-provider.js';
export { FakeLlmProvider, type FakeCall, type FakeResponse } from './fake-provider.js';
