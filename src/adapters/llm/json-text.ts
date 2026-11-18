import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { z, type ZodType } from 'zod';

import type { LlmPrompt, LlmUsage } from '../../domain/llm.js';
import { ComemError } from '../../domain/errors.js';
import { readUsage } from './usage.js';

export interface JsonTextResult<T> {
  readonly value: T;
  readonly usage: LlmUsage;
  readonly finishReason: string;
}

interface JsonTextOptions<T> {
  readonly model: LanguageModel;
  readonly prompt: LlmPrompt;
  readonly schema: ZodType<T>;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly abortSignal: AbortSignal;
}

function withJsonSchemaInstructions<T>(
  system: string | undefined,
  schema: ZodType<T>,
): string {
  let jsonSchema: string;
  try {
    jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  } catch {
    // transform / refinement 没有可逆的 JSON Schema。调用方的系统提示词仍包含
    // 输出结构，本地 safeParse 继续执行 transform；这里不把 schema 序列化失败
    // 冒充模型调用失败。
    jsonSchema = '遵循系统提示词中已经声明的 JSON 结构。';
  }
  return [
    system,
    '只输出一个符合下面 JSON Schema 的 JSON 值。不要输出 Markdown 代码块、解释或其它文本。',
    jsonSchema,
  ].filter((part): part is string => part !== undefined).join('\n\n');
}

function balancedJsonEnd(text: string, start: number): number | undefined {
  if (text[start] !== '{' && text[start] !== '[') return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (directError) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '{' && text[index] !== '[') continue;
      const end = balancedJsonEnd(text, index);
      if (end === undefined) continue;
      try {
        return JSON.parse(text.slice(index, end + 1)) as unknown;
      } catch {
        // 继续找下一个完整 JSON 值；最终错误保留原始整段解析失败。
      }
    }
    throw directError;
  }
}

function parseAndValidateJson<T>(
  text: string,
  schema: ZodType<T>,
): { readonly value: T } | { readonly error: Error } {
  let decoded: unknown;
  try {
    decoded = parseJsonText(text);
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? { value: parsed.data } : { error: parsed.error };
}

/**
 * OpenAI 兼容网关不保证执行 `response_format`。schema 放进系统指令，
 * 输出在进程内提取和校验；模型外包的 Markdown 或说明文字会被移除，
 * 对象字段不会被猜测或修复。
 */
export async function generateJsonText<T>(options: JsonTextOptions<T>): Promise<JsonTextResult<T>> {
  const result = await generateText({
    model: options.model,
    instructions: withJsonSchemaInstructions(options.prompt.system, options.schema),
    messages: [...options.messages],
    maxOutputTokens: options.maxTokens,
    temperature: options.temperature,
    maxRetries: 0,
    abortSignal: options.abortSignal,
  });
  const usage = readUsage(result.usage);
  const parsed = parseAndValidateJson(result.text, options.schema);
  if ('error' in parsed) {
    const details = {
      usage,
      ...(result.finishReason === 'length'
        ? { truncated: true, finishReason: result.finishReason }
        : { cause: parsed.error.name }),
    };
    throw new ComemError(
      result.finishReason === 'length' ? 'PROVIDER_UNAVAILABLE' : 'INVALID_ARGUMENT',
      result.finishReason === 'length'
        ? '模型输出被截断，结构化结果不完整。请调大 maxTokens 后重试。'
        : '模型输出不是合法的结构化数据，无法按 schema 解析。',
      details,
    );
  }
  return { value: parsed.value, usage, finishReason: result.finishReason };
}
