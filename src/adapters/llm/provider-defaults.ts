/**
 * 供应商适配器的内置默认值。
 *
 * `openai-compatible` 的 SDK 设置要求 `baseURL` 非空字符串（`@ai-sdk/openai-compatible`
 * 的类型是必填）。`config.providers.llm.default.baseUrl` 有默认值，正常路径不会走到
 * 这里；兜底成 OpenAI 官方地址，避免把 `undefined` 拼进请求 URL。
 *
 * 生成（`ai-sdk-provider.ts`）与嵌入（`embedding-provider.ts`）两个适配器共用这一份：
 * 各写一遍时，改一处漏一处会让两条链路打到不同的地址，症状是「生成走了自建网关、
 * 嵌入却打到官方」。
 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
