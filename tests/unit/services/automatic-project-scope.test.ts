import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import { resolveAutomaticProjectId } from '../../../src/services/retrieval/project-scope.js';

const IDENTITY = {
  subject: 'user:local',
  principals: ['user:local', 'user:*'],
} as const;

describe('resolveAutomaticProjectId', () => {
  it('没有会话时允许显式项目，支持首轮 ensure 之前召回', async () => {
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      projectId: 'comem',
    })).resolves.toBe('comem');
  });

  it('会话已绑定时采用绑定项目，显式同值可以确认', async () => {
    const sessions = {
      load: async () => ({ projectId: 'comem' }),
    };
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      sessionId: 'sess_1',
      sessions,
    })).resolves.toBe('comem');
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      sessionId: 'sess_1',
      projectId: 'comem',
      sessions,
    })).resolves.toBe('comem');
  });

  it('优先读取会话元数据，不加载消息正文', async () => {
    const sessions = {
      load: async () => {
        throw new Error('should not load messages');
      },
      readSessionMeta: async () => ({ projectId: 'comem' }),
    };
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      sessionId: 'sess_1',
      sessions,
    })).resolves.toBe('comem');
  });

  it('同一会话显式项目与会话绑定冲突时拒绝切换', async () => {
    const sessions = {
      load: async () => ({ projectId: 'comem' }),
    };
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      sessionId: 'sess_1',
      projectId: 'other',
      sessions,
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        sessionId: 'sess_1',
        boundProjectId: 'comem',
        requestedProjectId: 'other',
      },
    });
  });

  it('会话尚未创建时仍使用显式项目', async () => {
    const sessions = {
      load: async () => {
        throw new ComemError('NOT_FOUND', 'missing');
      },
    };
    await expect(resolveAutomaticProjectId({
      ...IDENTITY,
      sessionId: 'sess_new',
      projectId: 'comem',
      sessions,
    })).resolves.toBe('comem');
  });

  it('无项目且无绑定时保持无项目', async () => {
    await expect(resolveAutomaticProjectId(IDENTITY)).resolves.toBeUndefined();
  });
});
