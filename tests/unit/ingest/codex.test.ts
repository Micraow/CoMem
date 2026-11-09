import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRef } from '../../../src/domain/ingest.js';
import type { Logger } from '../../../src/domain/log.js';
import { CodexSource } from '../../../src/ingest/sources/codex.js';

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

async function collect(source: CodexSource): Promise<readonly SessionRef[]> {
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
  root = await mkdtemp(join(tmpdir(), 'comem-codex-ingest-'));
  logger = createLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('CodexSource', () => {
  it('只取 response_item.message，跳过 reasoning / 工具 / developer', async () => {
    const path = join(root, 'rollout-2026-08-25T03-05-51-abc.jsonl');
    await writeFile(
      path,
      [
        line({
          timestamp: '2026-08-25T03:05:51.031Z',
          type: 'session_meta',
          payload: {
            session_id: '01a036e1-6764-77e0-b613-54e99ba2a761',
            cwd: '/home/micraow/workspace/nexus',
          },
        }),
        line({
          timestamp: '2026-08-25T03:05:52.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '看一下仓库' }],
          },
        }),
        line({ timestamp: '2026-08-25T03:05:53.000Z', type: 'response_item', payload: { type: 'reasoning' } }),
        line({
          timestamp: '2026-08-25T03:05:54.000Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{}' },
        }),
        line({
          timestamp: '2026-08-25T03:05:55.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '系统提示' }],
          },
        }),
        line({
          timestamp: '2026-08-25T03:05:56.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '我先看看' }],
          },
        }),
        line({ timestamp: '2026-08-25T03:05:57.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '重复' } }),
        '{坏行}\n',
      ].join(''),
      'utf8',
    );

    const source = new CodexSource({ paths: [root], logger });
    const ref = single(await collect(source));
    expect(ref.nativeSessionId).toBe('01a036e1-6764-77e0-b613-54e99ba2a761');
    expect(ref.startedAt).toBe('2026-08-25T03:05:51.031Z');

    const result = await source.readMessages(ref, null, 100);
    expect(result.messages).toEqual([
      {
        role: 'user',
        text: '看一下仓库',
        createdAt: '2026-08-25T03:05:52.000Z',
        model: null,
        cwd: '/home/micraow/workspace/nexus',
      },
      {
        role: 'assistant',
        text: '我先看看',
        createdAt: '2026-08-25T03:05:56.000Z',
        model: null,
        cwd: '/home/micraow/workspace/nexus',
      },
    ]);
    expect(source.skippedLines).toBe(1);
  });

  it('从任意深度的子目录发现 rollout 文件', async () => {
    const nested = join(root, '2026', '08', '25');
    await writeFile(
      join(root, 'ignore.jsonl'),
      line({ type: 'session_meta', payload: { session_id: 'ignored' } }),
      'utf8',
    );
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, 'rollout-2026-08-25T03-05-51-abc.jsonl'),
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } }),
      'utf8',
    );
    const source = new CodexSource({ paths: [root], logger });
    const refs = await collect(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.nativeSessionId).toBe('rollout-2026-08-25T03-05-51-abc');
  });
});
