/**
 * 回归：没有可用 LLM 时归档能完成（`providers.llm.default.type: disabled`）。
 *
 * 背景：`DisabledLlmProvider` 抛 `INVALID_ARGUMENT`，而 `isTerminalStepError` 把它
 * 判成终态——`MemoryExtractStep` 第一次失败就把任务置 `failed`，归档永远停在
 * `stepsDone: ["archive_summary"]`，后面的步骤一步都不跑。归档目录在、`session`
 * 表里也有记录，但记忆没抽取、`find` 一条都搜不到。
 *
 * 判据与 `ingest` 的 `{ skipped: true, reason: 'llm_disabled' }` 相同：阶段一
 * （归档落盘、建任务、`session` 关联）不依赖模型，缺模型只让阶段二的产物消失。
 *
 * 这条用例从 `createContainer`（真实配置加载）一路走到 `commitRunner.tick()`，
 * 钉住四件事：
 *
 * 1. 任务以 `done` 结束（不是 `failed`），`error` 为空；
 * 2. `.meta.json` 的 `stepsDone` 含全部四步，`skippedSteps` 写明跳过原因；
 * 3. `warn` 日志说明 `memory_extract` 被跳过；
 * 4. 一次模型调用都没有（`fetch` 未被调用），归档产物里没有 `memory_diff.json`。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

const ALL_STEPS = [
  'archive_summary',
  'memory_extract',
  'memory_merge',
  'summary_invalidate',
] as const;

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  // 网络边界替身：没有可用模型时一次调用都不该发生。真的发出去就会红。
  vi.spyOn(globalThis, 'fetch');
  dataDir = await mkdtemp(join(tmpdir(), 'comem-commit-no-llm-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_PROVIDERS_LLM_DEFAULT_TYPE: 'disabled',
      COMEM_SESSION_AUTO_COMMIT_ENABLED: 'false',
    },
  });
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function message(id: string, text: string): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text }],
    createdAt: '2026-11-08T00:00:00.000Z',
  };
}

describe('没有可用 LLM 时归档能完成', () => {
  it('任务成功、memory_extract 被跳过、一次模型调用都没有', async () => {
    const warn = vi.spyOn(container.logger, 'warn');

    const sessionUri = await container.services.session.create(Uri.parse(ROOT), PRINCIPALS, {
      sessionId: 'sess_1',
    });
    await container.services.session.addMessage(sessionUri, message('msg_1', '项目里不用 any。'));
    const committed = await container.services.session.commitPhase1(sessionUri);

    await container.commitRunner.tick();

    // 1. 任务以 done 结束。`failed` 就是修复前的形态。
    const task = container.services.taskStore.get(committed.taskId);
    expect(task?.status).toBe('done');
    expect(task?.error).toBeNull();

    // 2. 四步都「完成」；跳过的那两步另记原因。
    expect(task?.stepsDone).toEqual([...ALL_STEPS]);
    const meta = await container.services.session.readArchiveMeta(committed.archiveUri);
    expect(meta?.stepsDone).toEqual([...ALL_STEPS]);
    expect(meta?.skippedSteps).toEqual([
      { step: 'memory_extract', reason: 'llm_disabled' },
      { step: 'memory_merge', reason: 'llm_disabled' },
    ]);

    // 3. 跳过必须可见：归档会走到 `.done`，用户不会收到任何错误。
    expect(warn).toHaveBeenCalledWith(
      'memory_extract 被跳过：providers.llm.default.type 是 disabled',
      expect.objectContaining({ step: 'memory_extract', reason: 'llm_disabled' }),
    );

    // 4. 没有模型就没有抽取，也没有可合并的操作（`memory_diff.json` 不存在）。
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const archivePath = join(
      dataDir,
      'user',
      'local',
      'sessions',
      'sess_1',
      'history',
      'archive_001',
    );
    await expect(stat(join(archivePath, '.done'))).resolves.toBeDefined();
    await expect(stat(join(archivePath, 'memory_diff.json'))).rejects.toThrow();
  });

  it('GET /health 能查到记忆抽取被跳过', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      readonly result: Record<string, unknown>;
    };
    const result = body.result;
    // 同样的部署里摘要是规则生成器，`status` 已经是 degraded。
    expect(result['status']).toBe('degraded');
    expect(result['memoryExtract']).toEqual({ skipped: true, reason: 'llm_disabled' });
  });
});
