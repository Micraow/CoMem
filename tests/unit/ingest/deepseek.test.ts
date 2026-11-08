import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRef } from '../../../src/domain/ingest.js';
import type { Logger } from '../../../src/domain/log.js';
import { DeepSeekSource } from '../../../src/ingest/sources/deepseek.js';

let root: string;
let logger: Logger;

function createLogger(): Logger {
  const mock: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mock,
  };
  return mock;
}

async function collect(source: DeepSeekSource): Promise<readonly SessionRef[]> {
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

function node(
  id: string,
  parent: string | null,
  children: readonly string[],
  message: Record<string, unknown> | null,
): Record<string, unknown> {
  return { id, parent, children, message };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'comem-deepseek-ingest-'));
  logger = createLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DeepSeekSource', () => {
  it('按第一条子分支展开树，只取 REQUEST / RESPONSE', async () => {
    const path = join(root, 'conversations.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'conv-1',
          title: 'GitHub 项目',
          inserted_at: '2025-01-05T11:25:58.137000+08:00',
          updated_at: '2025-01-05T11:26:47.152000+08:00',
          mapping: {
            root: node('root', null, ['u1'], null),
            u1: node('u1', 'root', ['a1'], {
              model: 'deepseek-chat',
              inserted_at: '2025-01-05T11:25:58.279000+08:00',
              fragments: [{ type: 'REQUEST', content: '有哪些项目' }],
            }),
            a1: node('a1', 'u1', ['u2', 'a2'], {
              model: 'deepseek-chat',
              inserted_at: '2025-01-05T11:26:00.000000+08:00',
              fragments: [
                { type: 'THINK', content: '思考' },
                { type: 'RESPONSE', content: '有这些项目' },
              ],
            }),
            u2: node('u2', 'a1', [], {
              model: 'deepseek-chat',
              inserted_at: '2025-01-05T11:26:39.159000+08:00',
              fragments: [{ type: 'REQUEST', content: '再说说' }],
            }),
            a2: node('a2', 'a1', [], {
              model: 'deepseek-chat',
              inserted_at: '2025-01-05T11:26:41.000000+08:00',
              fragments: [{ type: 'RESPONSE', content: '另一个分支' }],
            }),
          },
        },
      ]),
      'utf8',
    );

    const source = new DeepSeekSource({ paths: [path], logger });
    const ref = single(await collect(source));
    expect(ref.nativeSessionId).toBe('conv-1');
    expect(ref.title).toBe('GitHub 项目');
    expect(ref.startedAt).toBe('2025-01-05T11:25:58.137000+08:00');

    const result = await source.readMessages(ref, null, 100);
    expect(result.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:有哪些项目',
      'assistant:有这些项目',
      'user:再说说',
    ]);
    expect(result.messages[1]?.model).toBe('deepseek-chat');
  });

  it('没有 fragments 时退回 content.parts（旧版导出），非字符串 part 跳过', async () => {
    const path = join(root, 'conversations.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'conv-legacy',
          title: null,
          inserted_at: '2024-01-01T00:00:00.000Z',
          mapping: {
            root: node('root', null, ['n1'], null),
            n1: node('n1', 'root', [], {
              role: 'user',
              inserted_at: '2024-01-01T00:00:01.000Z',
              content: { content_type: 'text', parts: ['旧版正文', { type: 'image' }] },
            }),
          },
        },
      ]),
      'utf8',
    );
    const source = new DeepSeekSource({ paths: [path], logger });
    const ref = single(await collect(source));
    const result = await source.readMessages(ref, null, 100);
    expect(result.messages).toEqual([
      {
        role: 'user',
        text: '旧版正文',
        createdAt: '2024-01-01T00:00:01.000Z',
        model: null,
        cwd: null,
      },
    ]);
  });

  it('树游标：limit 1 后从下一个节点继续', async () => {
    const path = join(root, 'conversations.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'conv-2',
          title: null,
          inserted_at: null,
          mapping: {
            root: node('root', null, ['n1'], null),
            n1: node('n1', 'root', ['n2'], { fragments: [{ type: 'REQUEST', content: 'a' }] }),
            n2: node('n2', 'n1', [], { fragments: [{ type: 'RESPONSE', content: 'b' }] }),
          },
        },
      ]),
      'utf8',
    );
    const source = new DeepSeekSource({ paths: [path], logger });
    const ref = single(await collect(source));

    const first = await source.readMessages(ref, null, 1);
    expect(first.messages.map((message) => message.text)).toEqual(['a']);
    expect(first.cursor).toEqual({ kind: 'tree_node', value: 'n1' });

    const second = await source.readMessages(ref, first.cursor, 1);
    expect(second.messages.map((message) => message.text)).toEqual(['b']);
    expect(second.cursor).toEqual({ kind: 'tree_node', value: 'n2' });

    const third = await source.readMessages(ref, second.cursor, 1);
    expect(third.messages).toEqual([]);
    expect(third.cursor.value).toBe('n2');
  });

  it('坏会话跳过，不影响其它会话', async () => {
    const path = join(root, 'conversations.json');
    await writeFile(
      path,
      JSON.stringify([
        { id: 42 },
        {
          id: 'conv-3',
          title: 'ok',
          inserted_at: '2024-01-01T00:00:00.000Z',
          mapping: {
            root: node('root', null, ['n1'], null),
            n1: node('n1', 'root', [], { fragments: [{ type: 'REQUEST', content: 'ok' }] }),
          },
        },
      ]),
      'utf8',
    );
    const source = new DeepSeekSource({ paths: [path], logger });
    const refs = await collect(source);
    expect(refs).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
