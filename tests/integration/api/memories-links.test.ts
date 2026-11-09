/**
 * `GET /memories/{uri}/links` 的端到端验收（架构文档 §11.10、W97）。
 *
 * 这条端点在 `MemoryMergeStep` 接线之前恒返回 `links: []`：仓储、服务、路由、
 * 单测全都齐备，唯独没有产生端。服务层测试（`commit-steps.test.ts`）证明「合并
 * 步骤会写 links」，但证明不了**容器把 `memoryLink` 传给了那一步**——`container.ts`
 * 漏传或传错实例时，服务层测试仍然全绿，而这一个端点永远空。
 *
 * 所以这里从 `createContainer` 起：真实配置 → 真实阶段一 → 真实
 * `CommitRunner.tick()` → 真实 HTTP 路由。模型用回环 HTTP 替身（走真实
 * `AiSdkLlmProvider` 的请求与解析路径），不依赖外网。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdentityResolver } from '../../../src/api/http/middleware.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';

const ROOT = 'comem://user/local';
const AUTH_PRINCIPALS: readonly string[] = ['user:local', 'user:*'];
const MEMORY = `${ROOT}/memories/experiences/code-style.md`;

/** 抽取步骤的模型输出：一条新建的 `experiences` 记忆（与 commit-runner 用例同构）。 */
const EXTRACT_RESPONSE = JSON.stringify({
  operations: [
    {
      kind: 'upsert',
      pageId: 100,
      type: 'experiences',
      identity: { topic: 'code-style' },
      operations: [
        { kind: 'replace', field: 'content', value: '项目里不用 any，需要收窄时用 unknown。' },
      ],
    },
  ],
});

let dataDir: string;
let container: Container | undefined;
let app: FastifyInstance | undefined;
let llm: FakeLlmHttp;

function message(id: string): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text: '记住：这个项目里不用 any。' }],
    createdAt: new Date().toISOString(),
  };
}

function inject(options: InjectOptions): Promise<{ readonly body: string; readonly statusCode: number }> {
  if (app === undefined) {
    throw new Error('HTTP 服务没有启动。');
  }
  return app.inject(options);
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function encode(uri: string): string {
  return encodeURIComponent(uri);
}

beforeEach(async () => {
  llm = await startFakeLlmHttp((body) => {
    // 归档摘要走规则生成器、工作记忆默认关闭：这里会收到两次 `generateJson`，
    // 抽取一次、经验归纳一次；归纳返回空结论，不额外产生记忆。
    if (body.includes('记忆抽取')) {
      return EXTRACT_RESPONSE;
    }
    if (body.includes('经验归纳器')) {
      return JSON.stringify({ experiences: [] });
    }
    return JSON.stringify({ operations: [] });
  });
  dataDir = await mkdtemp(join(tmpdir(), 'comem-links-'));
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
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  app = await startServer(container.resolveIdentity);
});

/**
 * 用指定的身份解析器起 HTTP 服务。
 *
 * 外层用例只需要容器绑定的那个身份；ACL 用例要在一个进程里区分两个调用方，
 * 所以身份从请求头来（`x-comem-subject`），不再走「只接受绑定主体」的生产解析器。
 */
async function startServer(resolveIdentity: IdentityResolver): Promise<FastifyInstance> {
  const started = container;
  if (started === undefined) {
    throw new Error('容器没有启动。');
  }
  return createHttpServer({
    config: started.config,
    logger: started.logger,
    observability: started.observability,
    routes: started.routes,
    mcp: started.mcp,
    resolveIdentity,
  });
}

afterEach(async () => {
  if (container !== undefined) {
    await container.services.indexObserver.drain();
  }
  await app?.close();
  await container?.close();
  container = undefined;
  app = undefined;
  await llm.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /memories/{uri}/links（归档管线产生 derived_from）', () => {
  it('归档后正向非空，且方向 backlinks 能从归档 URI 反查回这条记忆', async () => {
    const started = container;
    if (started === undefined) {
      throw new Error('容器没有启动。');
    }

    const sessionUri = await started.services.session.create(Uri.parse(ROOT), AUTH_PRINCIPALS);
    await started.services.session.addMessage(sessionUri, message('m1'));
    await started.services.session.commitPhase1(sessionUri);
    // 阶段一写 `messages.jsonl` 会同步投递目录摘要失效；先让它落定，再跑阶段二。
    await started.services.indexObserver.drain();
    // 阶段二由执行器认领；tick 返回时任务已跑完。
    await started.commitRunner.tick();

    const archiveUri = `${sessionUri.toString()}/history/archive_001`;

    const forward = resultOf(
      await inject({ method: 'GET', url: `/api/v1/memories/${encode(MEMORY)}/links` }),
    );
    expect(forward['direction']).toBe('links');
    const links = forward['links'] as Record<string, unknown>[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      from: MEMORY,
      to: archiveUri,
      linkType: 'derived_from',
      weight: 1,
      matchText: '',
    });

    const backward = resultOf(
      await inject({
        method: 'GET',
        url: `/api/v1/memories/${encode(archiveUri)}/links?direction=backlinks`,
      }),
    );
    expect(backward['direction']).toBe('backlinks');
    const backlinks = backward['links'] as Record<string, unknown>[];
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({ from: MEMORY, to: archiveUri, linkType: 'derived_from' });
  });
});

/**
 * §12.4 的出口规则也管边的**另一端**。
 *
 * 查询的 URI 过 `assert` 不代表响应里其它 URI 也能给：`backlinks` 回答的是「哪些
 * 记忆来自这次归档」，而一条记忆的 URI 本身就说明了它的存在与主题
 * （`.../profile/health-condition.md`）。所以两个方向都按另一端求一次 read，
 * 无权限的边整条不返回。
 *
 * 用例同时钉住「对照」：A 自己那条边必须照常出现。只断言「B 的 URI 不在响应里」
 * 的话，把所有边都滤掉也能绿。
 */
describe('GET /memories/{uri}/links：另一端也要可读', () => {
  const SUBJECT_A = 'user:a';
  const SUBJECT_B = 'user:b';
  const ROOT_A = 'comem://user/a';
  const ROOT_B = 'comem://user/b';
  const MEMORY_A = `${ROOT_A}/memories/notes/health-condition.md`;
  const MEMORY_B = `${ROOT_B}/memories/notes/allergy.md`;
  const ARCHIVE_A = `${ROOT_A}/sessions/s-1/history/archive_001`;

  beforeEach(async () => {
    // 外层 beforeEach 起的服务只接受绑定身份；这组用例要两个身份。
    await app?.close();
    app = await startServer(async (headers) => {
      const subject = headers['x-comem-subject'] ?? SUBJECT_A;
      return { subject, principals: [subject, 'user:*'] };
    });
  });

  function principalsOf(subject: string): readonly string[] {
    return [subject, 'user:*'];
  }

  /**
   * A 的记忆来自 A 的归档；B 的记忆也指向同一个归档；A 的记忆还引用了一条 B 的
   * 记忆。三条边都写进真实仓储，走真实写路径落盘（观察者会物化权限行）。
   */
  async function seed(): Promise<void> {
    const started = container;
    if (started === undefined) {
      throw new Error('容器没有启动。');
    }
    await started.services.acl.ensureRootPreset(Uri.parse(ROOT_A));
    await started.services.acl.ensureRootPreset(Uri.parse(ROOT_B));
    await started.services.filesystem.write(
      Uri.parse(MEMORY_A),
      'A 的健康情况。',
      principalsOf(SUBJECT_A),
    );
    await started.services.filesystem.write(
      Uri.parse(MEMORY_B),
      'B 的健康情况。',
      principalsOf(SUBJECT_B),
    );
    await started.services.filesystem.write(
      Uri.parse(`${ARCHIVE_A}/summary.md`),
      '归档摘要。',
      principalsOf(SUBJECT_A),
    );
    await started.services.indexObserver.drain();

    started.services.memoryLink.addLinks(Uri.parse(MEMORY_A), [
      { toUri: Uri.parse(ARCHIVE_A), linkType: 'derived_from' },
      { toUri: Uri.parse(MEMORY_B), linkType: 'references' },
    ]);
    started.services.memoryLink.addLinks(Uri.parse(MEMORY_B), [
      { toUri: Uri.parse(ARCHIVE_A), linkType: 'derived_from' },
    ]);
  }

  it('backlinks：from 无读权限的边不返回，A 自己的边照常返回', async () => {
    await seed();
    const response = await inject({
      method: 'GET',
      url: `/api/v1/memories/${encode(ARCHIVE_A)}/links?direction=backlinks`,
      headers: { 'x-comem-subject': SUBJECT_A },
    });
    expect(response.statusCode).toBe(200);
    // B 的 URI 一个字符都不出现。先断这条：变异（去掉另一端求权）时红的正是它。
    expect(response.body).not.toContain(MEMORY_B);
    expect(response.body).not.toContain(ROOT_B);
    const result = resultOf(response);
    expect(result['direction']).toBe('backlinks');
    const links = result['links'] as Record<string, unknown>[];
    // 对照：没有把整批边滤掉。
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: MEMORY_A, to: ARCHIVE_A });
  });

  it('links：to 无读权限的边不返回，A 自己的边照常返回', async () => {
    await seed();
    const response = await inject({
      method: 'GET',
      url: `/api/v1/memories/${encode(MEMORY_A)}/links`,
      headers: { 'x-comem-subject': SUBJECT_A },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(MEMORY_B);
    expect(response.body).not.toContain(ROOT_B);
    const result = resultOf(response);
    expect(result['direction']).toBe('links');
    const links = result['links'] as Record<string, unknown>[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: MEMORY_A, to: ARCHIVE_A });
  });
});
