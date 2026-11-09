import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRef } from '../../../src/domain/ingest.js';
import type { Logger } from '../../../src/domain/log.js';
import { ClaudeCodeSource } from '../../../src/ingest/sources/claude-code.js';

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

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeSession(name: string, lines: readonly string[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, lines.join(''), 'utf8');
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'comem-claude-ingest-'));
  logger = createLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ClaudeCodeSource', () => {
  it('把真实样本行解析成 NormalizedMessage，并过滤侧支、元记录与纯工具轮', async () => {
    const path = await writeSession('s1.jsonl', [
      line({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: '给我看一下' },
        timestamp: '2026-08-25T03:13:44.308Z',
        uuid: 'u1',
        isMeta: false,
        cwd: '/home/micraow/workspace/nexus',
        gitBranch: 'main',
        sessionId: 's1',
      }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet',
          content: [
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        timestamp: '2026-08-25T03:13:45.000Z',
        isSidechain: false,
        isMeta: false,
        sessionId: 's1',
        cwd: '/home/micraow/workspace/nexus',
      }),
      line({ type: 'user', isSidechain: true, message: { role: 'user', content: '子 agent' }, sessionId: 's1' }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: '合成记录' }, sessionId: 's1' }),
      line({
        type: 'user',
        isSidechain: false,
        isMeta: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
        sessionId: 's1',
      }),
      line({ type: 'system', content: '系统提示', sessionId: 's1' }),
    ]);

    const source = new ClaudeCodeSource({ paths: [root], logger });
    const refs = [];
    for await (const ref of source.discoverSessions()) {
      refs.push(ref);
    }
    expect(refs).toHaveLength(1);
    expect(refs[0]?.nativeSessionId).toBe('s1');
    expect(refs[0]?.startedAt).toBe('2026-08-25T03:13:44.308Z');

    const result = await source.readMessages(single(refs), null, 100);
    expect(result.messages).toEqual([
      {
        role: 'user',
        text: '给我看一下',
        createdAt: '2026-08-25T03:13:44.308Z',
        model: null,
        cwd: '/home/micraow/workspace/nexus',
      },
      {
        role: 'assistant',
        text: '好的',
        createdAt: '2026-08-25T03:13:45.000Z',
        model: 'claude-sonnet',
        cwd: '/home/micraow/workspace/nexus',
      },
    ]);
    expect(result.cursor.kind).toBe('byte_offset');
    expect(result.cursor.value).not.toBe('0');
    expect(path).toContain('s1.jsonl');
  });

  it('坏行跳过并计数，游标继续前进', async () => {
    await writeSession('s1.jsonl', [
      '{not json}\n',
      line({ type: 'user', message: { role: 'user', content: '第一条' }, sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z' }),
      '[]\n',
    ]);
    const source = new ClaudeCodeSource({ paths: [root], logger });
    const ref = single(await collect(source));
    const result = await source.readMessages(ref, null, 100);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('第一条');
    expect(source.skippedLines).toBe(2);
  });

  it('按 limit 分批：游标停在最后一条返回的消息之后', async () => {
    await writeSession('s1.jsonl', [
      line({ type: 'user', message: { role: 'user', content: 'a' }, sessionId: 's1' }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'b' }, sessionId: 's1' }),
      line({ type: 'user', message: { role: 'user', content: 'c' }, sessionId: 's1' }),
    ]);
    const source = new ClaudeCodeSource({ paths: [root], logger });
    const ref = single(await collect(source));

    const first = await source.readMessages(ref, null, 2);
    expect(first.messages.map((message) => message.text)).toEqual(['a', 'b']);
    const second = await source.readMessages(ref, first.cursor, 2);
    expect(second.messages.map((message) => message.text)).toEqual(['c']);
    const third = await source.readMessages(ref, second.cursor, 2);
    expect(third.messages).toEqual([]);
    expect(third.cursor.value).toBe(second.cursor.value);
  });

  it('CRLF 行尾的字节偏移不漂移', async () => {
    const path = join(root, 's1.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, sessionId: 's1' })}\r\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'b' }, sessionId: 's1' })}\r\n`,
      'utf8',
    );
    const source = new ClaudeCodeSource({ paths: [root], logger });
    const ref = single(await collect(source));
    const first = await source.readMessages(ref, null, 1);
    const second = await source.readMessages(ref, first.cursor, 1);
    expect(first.messages[0]?.text).toBe('a');
    expect(second.messages[0]?.text).toBe('b');
  });

  it('没有对话的文件（history.jsonl）不发现会话', async () => {
    await writeSession('history.jsonl', [line({ display: 'ls', sessionId: 's1' })]);
    const source = new ClaudeCodeSource({ paths: [root], logger });
    expect(await collect(source)).toEqual([]);
  });
});

async function collect(source: ClaudeCodeSource): Promise<readonly SessionRef[]> {
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
