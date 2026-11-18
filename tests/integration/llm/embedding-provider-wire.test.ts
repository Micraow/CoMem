import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AiSdkEmbeddingProvider } from '../../../src/adapters/llm/embedding-provider.js';
import { NullLogger } from '../../helpers/null-logger.js';

const MODEL = 'wire-embedding';
const DIMENSION = 3;

let server: ReturnType<typeof createServer> | undefined;

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function startServer(
  respond: (input: string[], requestNumber: number, response: ServerResponse) => void,
): Promise<{ readonly baseUrl: string; readonly requests: string[][] }> {
  const requests: string[][] = [];
  server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw) as { input: string[] };
      requests.push(body.input);
      respond(body.input, requests.length, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function createProvider(baseUrl: string): AiSdkEmbeddingProvider {
  return new AiSdkEmbeddingProvider({
    type: 'openai-compatible',
    baseUrl,
    model: MODEL,
    apiKey: 'sk-wire-test',
    dimension: DIMENSION,
    maxBatchSize: 4,
    timeoutSeconds: 1,
    logger: new NullLogger(),
  });
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  server = undefined;
});

describe('AiSdkEmbeddingProvider HTTP 路径', () => {
  it('真实 AI SDK 把 413 解析为 APICallError，并保持二分后的向量顺序与 usage', async () => {
    const wire = await startServer((input, _requestNumber, response) => {
      if (input.length === 4) {
        sendJson(response, 413, { error: { message: 'Payload too large' } });
        return;
      }
      sendJson(response, 200, {
        data: input.map((text) => ({ embedding: [text.charCodeAt(0), 0, 0] })),
        usage: { prompt_tokens: input.length },
      });
    });

    const result = await createProvider(wire.baseUrl).embed(['a', 'b', 'c', 'd']);

    expect(wire.requests).toEqual([
      ['a', 'b', 'c', 'd'],
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(result.vectors.map((vector) => vector[0])).toEqual([97, 98, 99, 100]);
    expect(result.usage).toEqual({ promptTokens: 4, totalTokens: 4 });
  });

  it('真实 AI SDK 的 context-limit 重试共享单批 timeout 预算', async () => {
    const wire = await startServer((_input, requestNumber, response) => {
      if (requestNumber === 1) {
        sendJson(response, 400, {
          error: { message: 'maximum context length exceeded' },
        });
      }
    });

    const error = await createProvider(wire.baseUrl)
      .embed(['甲乙丙丁'], { timeoutMs: 30 })
      .catch((caught: unknown) => caught);

    expect(wire.requests).toEqual([['甲乙丙丁'], ['甲乙']]);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { timeoutMs: 30 },
    });
  });
});
