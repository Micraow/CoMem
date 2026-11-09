/**
 * 画像格式契约在写入路径与健康度上的闭环（架构文档 §11.1、§17.5）。
 *
 * 验四件事：
 *
 * 1. 不合规画像**写入成功**（不拒绝、不丢弃）；
 * 2. 磁盘上的正文与传入内容一致；
 * 3. 写入成功后有一条 `warn` 日志，带 scope / URI / 违规类型与条数，且不含正文；
 * 4. `ObservabilityService.health()` 与 `GET /health` 能看到计数。
 *
 * 从 `createContainer` 起跑：`profileBodies` 由 bootstrap 注入，只有真实装配能
 * 证明「服务端校验真的接在写入路径上」，单元测试证明不了接线。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { profileMemoryType } from '../../../src/domain/memory-types/profile.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = 'comem://user/local';
const PROFILE_URI = `${SCOPE}/memories/profile.md`;

/**
 * 混合画像：1 条合规 bullet + 6 条违规（标题、非 bullet、日期不可解析、超长、
 * 缺日期、代码围栏）。用来同时验证「不整篇误判」与计数。
 */
const MIXED_BODY = [
  '# 用户画像',
  '- 后端工程师 (as of 2026-11-09)',
  '',
  '这是一段散文，不是条目。',
  '- 用户住在上海 (as of 2026-13-01)',
  '- ' + '甲'.repeat(31) + ' (as of 2026-11-09)',
  '- 用户喜欢猫',
  '```',
].join('\n');

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-profile-format-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      // 写路径会投递摘要失效；规则摘要不碰模型。
      COMEM_SUMMARY_GENERATOR: 'rule',
      // 关掉模型，避免测试因为「今天没开代理」而红。
      COMEM_PROVIDERS_LLM_DEFAULT_TYPE: 'disabled',
      // 让写入路径的 warn 走到 stdout，测试才能从日志行里读到它。
      COMEM_LOGGING_LEVEL: 'warn',
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
  await rm(dataDir, { recursive: true, force: true });
});

describe('画像格式契约的写入链路', () => {
  it('不合规画像写入成功、正文一致、记 warn，并在 health / stats 里可观测', async () => {
    // 只在这个用例里抓 stdout：断言 warn 行，同时确认正文没有进日志。
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await container.services.memory.upsertMemory(
        Uri.parse(SCOPE),
        profileMemoryType,
        { name: 'local', content: MIXED_BODY },
      );

      // 1. 收下，不拒绝、不丢弃。
      expect(result.written).toBe(true);
      expect(result.created).toBe(true);

      // 2. 文件内容与传入一致。
      const raw = await readFile(toDiskPath(dataDir, Uri.parse(PROFILE_URI)), 'utf8');
      expect(raw).toContain(MIXED_BODY);
      const record = await container.services.memory.read(Uri.parse(PROFILE_URI));
      expect(record?.fields['content']).toBe(MIXED_BODY);

      // 3. 一条 warn：带 scope / URI / 类型 / 条数，不带正文。
      const lines = writeSpy.mock.calls.map((call) => String(call[0]));
      const violationLine = lines.find((line) =>
        line.includes('画像正文不符合格式契约'),
      );
      expect(violationLine).toBeDefined();
      const logged = JSON.parse(violationLine ?? '') as Record<string, unknown>;
      expect(logged['level']).toBe('warn');
      expect(logged['scope']).toBe(SCOPE);
      expect(logged['uri']).toBe(PROFILE_URI);
      expect(logged['memoryType']).toBe('profile');
      expect(logged['violationCount']).toBe(6);
      expect(logged['rules']).toEqual(
        expect.arrayContaining([
          'heading',
          'not-bullet',
          'invalid-date-suffix',
          'entry-too-long',
          'missing-date-suffix',
          'code-fence',
        ]),
      );
      // 画像可能含个人信息：日志行里不能出现正文。
      expect(violationLine).not.toContain('后端工程师');
      expect(violationLine).not.toContain('用户住在上海');

      // 4a. health() 看到计数。
      const health = await container.observability.health();
      expect(health.profileFormat).toEqual({
        checked: 1,
        invalid: 1,
        violations: 6,
        truncated: false,
      });

      // 4b. `GET /health` 的 memory 块也带同一个数（§17.9）。
      const healthResponse = await app.inject({ method: 'GET', url: '/health' });
      const healthEnvelope = JSON.parse(healthResponse.body) as {
        result: { memory?: { profileFormat?: unknown } };
      };
      expect(healthEnvelope.result.memory?.profileFormat).toEqual({
        checked: 1,
        invalid: 1,
        violations: 6,
        truncated: false,
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('合规画像不产生 warn，health 里 checked=1 / invalid=0', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await container.services.memory.upsertMemory(Uri.parse(SCOPE), profileMemoryType, {
        name: 'local',
        content: '- 后端工程师 (as of 2026-11-09)',
      });

      const lines = writeSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('画像正文不符合格式契约'))).toBe(false);

      const health = await container.observability.health();
      expect(health.profileFormat).toEqual({
        checked: 1,
        invalid: 0,
        violations: 0,
        truncated: false,
      });
    } finally {
      writeSpy.mockRestore();
    }
  });
});
