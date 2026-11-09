/**
 * `memory.workingMemory.enabled = true` 的接线验收（架构文档 §10.5）。
 *
 * 已有覆盖只有 `tests/integration/services/commit-steps.test.ts`：直接构造
 * `ArchiveSummaryStep` 并手工传入 `workingMemory: { enabled: true }`。它证明「开关为真
 * 时这一步会写 `.overview.md`」，但没有证明**配置里的这个开关会到那一步手里**——
 * `container.ts` 漏传或传成常量时，服务层测试仍然全绿，生产里工作记忆永远不生成。
 *
 * 这一条从 `createContainer` 起：真实配置 → 真实阶段一 → 真实 `CommitRunner.tick()`
 * → 读归档目录的 `.overview.md`。模型用回环 HTTP 替身（走真实 AiSdk provider 的
 * 请求与解析路径），摘要用 `rule` 生成器，避免第二处模型调用。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';

const SCOPE = 'comem://user/local';
const AUTH_PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

/** 7 段工作记忆的固定输出（与架构文档 §10.5 的代码块同构）。 */
const WORKING_MEMORY = [
  '# 会话工作记忆',
  '',
  '**一行概述**：代码风格 | 定下严格模式 | 已完成',
  '',
  '## 分析',
  '',
  '用户要求开启 TypeScript 严格模式。',
  '',
  '## 主要请求与意图',
  '',
  '确定代码风格。',
  '',
  '## 关键概念',
  '',
  '严格模式。',
  '',
  '## 待办',
  '',
  '无',
  '',
  '## 背景约束',
  '',
  '无',
  '',
  '## 相关上下文',
  '',
  '无',
].join('\n');

let dataDir: string;
let container: Container | undefined;
let llm: FakeLlmHttp;

/**
 * 同一台假模型服务要同时服务三个阶段：
 * - 工作记忆走 `generate`（纯文本），提示词里有「会话归档器」；
 * - 记忆抽取走 `generateJson`，返回空的 `operations` 就够（本用例只关心工作记忆）；
 * - 经验归纳走 `generateJson`，返回空的 `experiences`（同样是空结论）。
 */
function respond(body: string): string {
  if (body.includes('会话归档器')) {
    return WORKING_MEMORY;
  }
  if (body.includes('经验归纳器')) {
    return JSON.stringify({ experiences: [] });
  }
  return JSON.stringify({ operations: [] });
}

function message(id: string): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text: '记住：这个项目用 TypeScript 严格模式。' }],
    createdAt: new Date().toISOString(),
  };
}

function sessionDirectory(sessionUri: Uri): string {
  return join(dataDir, 'user', 'local', 'sessions', sessionUri.name);
}

beforeEach(async () => {
  llm = await startFakeLlmHttp(respond);
  dataDir = await mkdtemp(join(tmpdir(), 'comem-working-memory-'));
  const configPath = join(dataDir, 'config.yaml');
  await writeFile(
    configPath,
    [
      'providers:',
      '  llm:',
      '    default:',
      '      type: openai-compatible',
      `      baseUrl: ${llm.baseUrl}`,
      '      model: fake',
      '      apiKey: test',
      '      maxTokens: 4096',
      '      timeoutSeconds: 30',
      'summary:',
      '  generator: rule',
      'session:',
      '  autoCommit:',
      '    enabled: false',
      'memory:',
      '  workingMemory:',
      '    enabled: true',
    ].join('\n'),
    'utf8',
  );
  container = await createContainer({
    configPath,
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
});

afterEach(async () => {
  await container?.close();
  container = undefined;
  await llm.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('memory.workingMemory.enabled = true（container → 管线 → 磁盘）', () => {
  it('打开后归档目录的 .overview.md 是 7 段工作记忆，计算摘要来自它', async () => {
    const started = container;
    if (started === undefined) {
      throw new Error('容器没有启动。');
    }
    expect(started.config.memory.workingMemory.enabled).toBe(true);

    const sessionUri = await started.services.session.create(
      Uri.parse(SCOPE),
      AUTH_PRINCIPALS,
    );
    await started.services.session.addMessage(sessionUri, message('m1'));
    await started.services.session.commitPhase1(sessionUri);
    // 阶段一写 `messages.jsonl` 会同步投递一次归档目录的摘要失效；先让它落定，
    // 再跑阶段二。否则那一轮规则摘要可能在「工作记忆已写入」之后完成并覆盖它——
    // 那是摘要失效与工作记忆的时序问题，不是本开关的行为。
    await started.services.indexObserver.drain();

    // 阶段二由执行器认领；tick 返回时任务已跑完（commitRunner 等 stop 才收尾，
    // 单任务在 tick 内 await）。
    await started.commitRunner.tick();

    const overview = await readFile(
      join(sessionDirectory(sessionUri), 'history', 'archive_001', '.overview.md'),
      'utf8',
    );
    // 用户可见结果：归档目录的 L1 是工作记忆，不是规则摘要。
    expect(overview).toContain('# 会话工作记忆');
    expect(overview).toContain('## 分析');
    expect(overview).toContain('用户要求开启 TypeScript 严格模式。');

    const abstract = await readFile(
      join(sessionDirectory(sessionUri), 'history', 'archive_001', '.abstract.md'),
      'utf8',
    );
    // L0 从工作记忆的一行概述提取，不是空文件。
    expect(abstract).toContain('代码风格');

    // 确实调过工作记忆这一路模型（不是规则摘要恰好长成这样）。
    expect(llm.requests.some((body) => body.includes('会话归档器'))).toBe(true);
  });
});
