import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  estimateTokens,
  nextTurn,
  renderMessageText,
  shouldAutoCommit,
  type AutoCommitPolicy,
  type Session,
  type SessionMessage,
} from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';

const NOW = new Date('2026-11-05T17:00:00.000Z');

function policy(overrides: Partial<AutoCommitPolicy> = {}): AutoCommitPolicy {
  return {
    enabled: true,
    pendingTokenThreshold: 150000,
    messageCountThreshold: 100,
    minCommitIntervalSeconds: 0,
    idleTimeoutSeconds: 0,
    keepRecentCount: 0,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_7f3a91c2',
    uri: Uri.parse('comem://user/alice/sessions/sess_7f3a91c2'),
    status: 'open',
    messages: [],
    messageCount: 0,
    pendingTokens: 0,
    lastCommitAt: null,
    ...overrides,
  };
}

function message(createdAt: string, turn = 1): SessionMessage {
  return {
    id: `msg_${String(turn).padStart(2, '0')}`,
    role: 'user',
    parts: [{ kind: 'text', text: '你好' }],
    createdAt,
    turn,
  };
}

describe('estimateTokens', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按每码点约 1 token 计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文按每 4 码点约 1 token 计，向上取整', () => {
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('中英混排分别计数后相加', () => {
    expect(estimateTokens('你好abc')).toBe(3);
  });

  it('emoji 至少算 1 个 token', () => {
    expect(estimateTokens('😀')).toBe(1);
  });
});

describe('nextTurn', () => {
  it('空会话从第 1 轮开始', () => {
    expect(nextTurn([])).toBe(1);
  });

  it('轮次等于消息总数', () => {
    expect(nextTurn([message('2026-11-05T16:00:00.000Z', 1)])).toBe(2);
    expect(
      nextTurn([message('2026-11-05T16:00:00.000Z', 1), message('2026-11-05T16:01:00.000Z', 2)]),
    ).toBe(3);
  });
});

describe('shouldAutoCommit', () => {
  it('未启用时永远不提交', () => {
    const busy = session({ pendingTokens: 999999, messageCount: 999 });

    expect(shouldAutoCommit(busy, policy({ enabled: false }), NOW)).toBe(false);
  });

  it('token 严格大于阈值时提交', () => {
    expect(
      shouldAutoCommit(session({ pendingTokens: 150000 }), policy(), NOW),
    ).toBe(false);
    expect(
      shouldAutoCommit(session({ pendingTokens: 150001 }), policy(), NOW),
    ).toBe(true);
  });

  it('消息数严格大于阈值时提交', () => {
    expect(shouldAutoCommit(session({ messageCount: 100 }), policy(), NOW)).toBe(false);
    expect(shouldAutoCommit(session({ messageCount: 101 }), policy(), NOW)).toBe(true);
  });

  it('两次自动提交的最小间隔未到时不提交', () => {
    // 30 秒前刚提交过，最小间隔 60 秒。
    const recent = session({ pendingTokens: 200000, lastCommitAt: '2026-11-05T16:59:30.000Z' });

    expect(shouldAutoCommit(recent, policy({ minCommitIntervalSeconds: 60 }), NOW)).toBe(false);
  });

  it('最小间隔满足后按阈值提交', () => {
    const old = session({ pendingTokens: 200000, lastCommitAt: '2026-11-05T16:58:59.000Z' });

    expect(shouldAutoCommit(old, policy({ minCommitIntervalSeconds: 60 }), NOW)).toBe(true);
  });

  it('空闲达到 idleTimeoutSeconds 且有未提交内容时提交', () => {
    const idle = session({
      pendingTokens: 10,
      messageCount: 1,
      messages: [message('2026-11-05T16:58:00.000Z')],
    });

    expect(shouldAutoCommit(idle, policy({ idleTimeoutSeconds: 60 }), NOW)).toBe(true);
  });

  it('空闲时间还没到时不提交', () => {
    const active = session({
      pendingTokens: 10,
      messageCount: 1,
      messages: [message('2026-11-05T16:59:30.000Z')],
    });

    expect(shouldAutoCommit(active, policy({ idleTimeoutSeconds: 60 }), NOW)).toBe(false);
  });

  it('没有未提交内容时不会因为空闲而提交', () => {
    const empty = session({ messages: [message('2026-11-05T16:00:00.000Z')] });

    expect(shouldAutoCommit(empty, policy({ idleTimeoutSeconds: 60 }), NOW)).toBe(false);
  });

  it('idleTimeoutSeconds 为 0 时关闭空闲提交', () => {
    const idle = session({
      pendingTokens: 10,
      messageCount: 1,
      messages: [message('2026-11-05T10:00:00.000Z')],
    });

    expect(shouldAutoCommit(idle, policy({ idleTimeoutSeconds: 0 }), NOW)).toBe(false);
  });

  it('没有消息时用上次提交时间算空闲', () => {
    const idle = session({ pendingTokens: 5, lastCommitAt: '2026-11-05T16:58:00.000Z' });

    expect(shouldAutoCommit(idle, policy({ idleTimeoutSeconds: 60 }), NOW)).toBe(true);
  });

  it('时间戳非法时抛 INVALID_ARGUMENT，而不是静默放过限速', () => {
    let caught: unknown;
    try {
      shouldAutoCommit(
        session({ pendingTokens: 200000, lastCommitAt: '不是时间' }),
        policy({ minCommitIntervalSeconds: 60 }),
        NOW,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('INVALID_ARGUMENT');
  });
});

describe('renderMessageText', () => {
  it('拼接文本部分', () => {
    const message: SessionMessage = {
      id: 'msg_01',
      role: 'assistant',
      parts: [
        { kind: 'text', text: '第一行' },
        { kind: 'text', text: '第二行' },
      ],
      createdAt: '2026-11-05T16:00:00.000Z',
      turn: 1,
    };

    expect(renderMessageText(message)).toBe('第一行\n第二行');
  });

  it('工具调用带名字与调用 ID', () => {
    const message: SessionMessage = {
      id: 'msg_02',
      role: 'assistant',
      parts: [
        {
          kind: 'tool_use',
          toolUseId: 'call_1',
          name: 'read',
          input: { uri: 'comem://user/alice/memories' },
        },
      ],
      createdAt: '2026-11-05T16:00:00.000Z',
      turn: 1,
    };

    expect(renderMessageText(message)).toBe(
      '[tool_use read call_1] {"uri":"comem://user/alice/memories"}',
    );
  });

  it('工具结果按是否报错加标记', () => {
    const ok: SessionMessage = {
      id: 'msg_03',
      role: 'tool',
      parts: [{ kind: 'tool_result', toolUseId: 'call_1', output: 'ok', isError: false }],
      createdAt: '2026-11-05T16:00:00.000Z',
      turn: 1,
    };
    const failed: SessionMessage = {
      ...ok,
      parts: [{ kind: 'tool_result', toolUseId: 'call_1', output: '报错', isError: true }],
    };

    expect(renderMessageText(ok)).toBe('[tool_result call_1] ok');
    expect(renderMessageText(failed)).toBe('[tool_result call_1 error] 报错');
  });

  it('工具输入的 undefined 也能渲染成字符串', () => {
    const message: SessionMessage = {
      id: 'msg_04',
      role: 'assistant',
      parts: [{ kind: 'tool_use', toolUseId: 'call_1', name: 'list', input: undefined }],
      createdAt: '2026-11-05T16:00:00.000Z',
      turn: 1,
    };

    expect(renderMessageText(message)).toBe('[tool_use list call_1] undefined');
  });

  it('没有 parts 时返回空串', () => {
    const message: SessionMessage = {
      id: 'msg_05',
      role: 'system',
      parts: [],
      createdAt: '2026-11-05T16:00:00.000Z',
      turn: 1,
    };

    expect(renderMessageText(message)).toBe('');
  });
});
