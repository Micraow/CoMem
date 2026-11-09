import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRef } from '../../../src/domain/ingest.js';
import type { Logger } from '../../../src/domain/log.js';
import { QwenSource } from '../../../src/ingest/sources/qwen.js';

let root: string;
let logger: Logger;

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

async function collect(source: QwenSource): Promise<readonly SessionRef[]> {
  const refs: SessionRef[] = [];
  for await (const ref of source.discoverSessions()) {
    refs.push(ref);
  }
  return refs;
}

function single(refs: readonly SessionRef[]): SessionRef {
  const [ref] = refs;
  if (ref === undefined) {
    throw new Error('期望发现一个会话');
  }
  return ref;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'comem-qwen-ingest-'));
  logger = createLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('QwenSource', () => {
  it('展开 history.messages 树，assistant 正文取 content_list 的 answer', async () => {
    const path = join(root, 'Qwen-chat-export-1.json');
    await writeFile(
      path,
      JSON.stringify({
        success: true,
        data: [
          {
            id: 'q1',
            title: '论文工具',
            chat: {
              history: {
                currentId: 'n2',
                messages: {
                  n1: {
                    id: 'n1',
                    role: 'user',
                    content: '找点工具',
                    parentId: null,
                    childrenIds: ['n2'],
                    timestamp: 1790000000,
                  },
                  n2: {
                    id: 'n2',
                    role: 'assistant',
                    content: '',
                    content_list: [
                      { phase: 'thinking_summary', content: '思考' },
                      { phase: 'answer', content: '推荐这些' },
                    ],
                    model: 'qwen3.8-max',
                    parentId: 'n1',
                    childrenIds: [],
                    timestamp: 1790000001,
                  },
                },
              },
            },
          },
        ],
      }),
      'utf8',
    );

    const source = new QwenSource({ paths: [path], logger });
    const ref = single(await collect(source));
    expect(ref.nativeSessionId).toBe('q1');
    expect(ref.title).toBe('论文工具');
    expect(ref.startedAt).toBe(new Date(1790000000 * 1000).toISOString());

    const result = await source.readMessages(ref, null, 100);
    expect(result.messages).toEqual([
      {
        role: 'user',
        text: '找点工具',
        createdAt: new Date(1790000000 * 1000).toISOString(),
        model: null,
        cwd: null,
      },
      {
        role: 'assistant',
        text: '推荐这些',
        createdAt: new Date(1790000001 * 1000).toISOString(),
        model: 'qwen3.8-max',
        cwd: null,
      },
    ]);
  });

  it('支持 chat.history 直接是节点对象（任务草图描述的形状）', async () => {
    const path = join(root, 'Qwen-chat-export-2.json');
    await writeFile(
      path,
      JSON.stringify({
        success: true,
        data: [
          {
            id: 'q2',
            title: null,
            chat: {
              history: {
                n1: {
                  id: 'n1',
                  role: 'user',
                  content: '你好',
                  parentId: null,
                  childrenIds: [],
                  timestamp: '2024-01-01T00:00:00.000Z',
                },
              },
            },
          },
        ],
      }),
      'utf8',
    );
    const source = new QwenSource({ paths: [path], logger });
    const ref = single(await collect(source));
    const result = await source.readMessages(ref, null, 100);
    expect(result.messages.map((message) => message.text)).toEqual(['你好']);
  });

  it('损坏的 JSON 跳过该文件并记进 fileErrors，不静默返回 0 个会话', async () => {
    const path = join(root, 'Qwen-chat-export-3.json');
    await writeFile(path, '{"success": true, "data": [', 'utf8');
    const source = new QwenSource({ paths: [path], logger });

    // 一份损坏的导出不该让同来源的其它文件也导不进来：`discoverSessions` 不抛错，
    // 而是跳过并在 `fileErrors` 里留下带 `locator` 的记录，由编排层写进报告。
    expect(await collect(source)).toEqual([]);
    expect(source.fileErrors).toHaveLength(1);
    expect(source.fileErrors[0]?.locator).toBe(path);
    expect(source.fileErrors[0]?.message).toContain('不是合法 JSON');
  });

  it('脱敏伪影（密码保护）修复后照常发现会话', async () => {
    const path = join(root, 'Qwen-chat-export-4.json');
    await writeFile(
      path,
      `{
        "success": true,
        "data": [{
          "id": "q4",
          "title": null,
          "chat": { "history": { "messages": {
            "n1": {"id":"n1","role":"user","content":"修复后的用户","parentId":null,"childrenIds":[],"timestamp":1790000000,"total_tokens":4密码保护811}
          } } }
        }]
      }`,
      'utf8',
    );
    const source = new QwenSource({ paths: [path], logger });

    const ref = single(await collect(source));
    expect(source.fileErrors).toEqual([]);
    const result = await source.readMessages(ref, null, 100);
    expect(result.messages.map((message) => message.text)).toEqual(['修复后的用户']);
  });
});
