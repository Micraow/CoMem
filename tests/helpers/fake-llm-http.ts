/**
 * 测试用的 OpenAI 兼容聊天服务（只监听回环地址）。
 *
 * 真实容器在 `providers.llm.default.baseUrl` 指向这里，因此 `AiSdkLlmProvider`
 * 走的是生产代码里的 HTTP 路径：AI SDK → `POST /chat/completions` → 解析
 * `choices[0].message.content`。测试不 mock `ai` 包，也不依赖外网。
 *
 * 响应由调用方按请求体决定：
 * - `generate`（工作记忆）需要 Markdown 正文；
 * - `generateJson`（记忆抽取 / 记忆合并）需要 JSON 字符串。
 *
 * 与 `tests/integration/services/ingest.test.ts` 里的假模型服务同一套做法；抽出来是
 * 因为「工作记忆」与「记忆合并」两个能力开关的接线测试都要用它。
 */

import { createServer, type Server } from 'node:http';

export interface FakeLlmHttp {
  /** 形如 `http://127.0.0.1:PORT/v1`，直接写进 `providers.llm.default.baseUrl`。 */
  readonly baseUrl: string;
  /** 收到的请求体（JSON 字符串），按到达顺序。 */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

/** 一条最小的 OpenAI 兼容聊天响应。 */
function chatCompletion(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'fake',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/**
 * 启动假模型服务。`respond` 收到原始请求体，返回要放进 `content` 的文本。
 */
export async function startFakeLlmHttp(respond: (body: string) => string): Promise<FakeLlmHttp> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(chatCompletion(respond(body)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('假模型服务没有拿到监听端口。');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
