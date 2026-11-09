/**
 * `edit` 必须与 `write` 一样触发派生数据通知（架构文档 §7、§8.2、§10.6、§11.2）。
 *
 * 缺陷现场：`FileSystemService.edit` 写完文件后不通知 `NodeWriteObserver`，所以
 * `node.body_digest` / `node_fts` / 摘要 / 物化权限全部停在旧值。用户看到的是
 * 「我明明改了，搜出来还是老的」——而 MCP 工具仍然回报 `Index: indexed`，因为
 * 那一列只判断索引行存在（`api/mcp/registry.ts` 的 `indexStatus`）。
 *
 * 这个用例从**公开入口**（`POST /content/edit`）走一遍，断言的是可观察结果：
 * 新正文里的词能搜到、只在旧正文里的词搜不到、`body_digest` 变了。把 `edit` 里的
 * 通知删掉，三条断言一起红。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';
/** 身份展开后的主体集合；只用于直接调检索服务，与 HTTP 的身份解析无关。 */
const PRINCIPALS: readonly string[] = [SUBJECT, 'user:*'];

const DIR = `${ROOT}/memories`;
const FILE = `${DIR}/deploy.md`;

/**
 * 旧正文与新正文里的「只在一边出现」的词。用 ASCII 单词而不是中文：`node_fts`
 * 的分词器是 `unicode61`，一段连续汉字是一个 token，`旧词` 不会命中 `这是旧词正文`。
 */
const OLD_WORD = 'bluebird';
const NEW_WORD = 'kestrel';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  // 网络边界替身：任何一次 `fetch` 都立即失败，不产生真实连接（检索的意图分析、
  // 查询嵌入都会退回 FTS）。测试不能依赖本机能否连外网。
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request): Promise<Response> => {
      throw new TypeError(`集成测试不发起真实网络请求：${String(input)}`);
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-edit-index-'));
  container = await createContainer({
    // 配置从临时目录读：缺省会读仓库根的 `config.yaml`，那是开发者本机的配置。
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:1/v1',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
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

function inject(options: InjectOptions) {
  return app.inject(options);
}

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function encode(uri: string): string {
  return encodeURIComponent(uri);
}

/** 索引里这条记录正文的 digest（`node` 表的 `body_digest`，文件行是 L2）。 */
function bodyDigestOf(uri: string): string {
  const row = container.db
    .prepare("SELECT body_digest FROM node WHERE uri = ? AND level = 'L2'")
    .get(uri) as Record<string, unknown> | undefined;
  expect(row, `索引里没有 ${uri} 的 L2 行`).toBeDefined();
  return String(row?.['body_digest']);
}

async function findUris(query: string): Promise<readonly string[]> {
  const hits = await container.services.search.find(query, {
    scopes: [ROOT],
    subject: SUBJECT,
    principals: PRINCIPALS,
    limit: 10,
  });
  return hits.map((hit) => hit.uri);
}

describe('edit 之后的索引', () => {
  it('edit 让检索与 body_digest 跟上新正文', async () => {
    const written = await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: FILE, content: `部署走 ${OLD_WORD} 集群，滚动重启。` },
    });
    expect(written.statusCode).toBe(200);
    // 索引维护在观察者里同步完成；`drain` 只等排期的摘要失效与嵌入，这里用它把
    // 「写完之后索引一定已经是新的」变成一个确定点。
    await container.services.indexObserver.drain();

    // 前提：写路径确实把这条记忆索引了，否则下面的断言区分不出「edit 没通知」。
    expect(await findUris(OLD_WORD)).toContain(FILE);
    const digestBefore = bodyDigestOf(FILE);

    const edited = await inject({
      method: 'POST',
      url: '/api/v1/content/edit',
      payload: {
        uri: FILE,
        blocks: [{ search: OLD_WORD, replace: NEW_WORD }],
      },
    });
    expect(resultOf(edited)['applied']).toBe(1);

    // 只在旧正文里的词必须搜不到（旧 `node_fts` 行被替换掉了）。这条就是用户看到的
    // 「我明明改了，搜出来还是老的」。
    expect(await findUris(OLD_WORD)).not.toContain(FILE);
    // 新正文里的词必须在索引里（`node_fts` 换成了新正文）。
    expect(await findUris(NEW_WORD)).toContain(FILE);
    // 正文摘要变了，说明索引行是真的重写过，而不是「恰好 FTS 命中」。
    expect(bodyDigestOf(FILE)).not.toBe(digestBefore);
  });

  it('HTTP 读回的是新正文（通知没有把内容写坏）', async () => {
    await inject({
      method: 'POST',
      url: '/api/v1/content/write',
      payload: { uri: FILE, content: `启动 ${OLD_WORD}。` },
    });
    await inject({
      method: 'POST',
      url: '/api/v1/content/edit',
      payload: { uri: FILE, blocks: [{ search: OLD_WORD, replace: NEW_WORD }] },
    });

    const read = resultOf(
      await inject({ method: 'GET', url: `/api/v1/content/read?uri=${encode(FILE)}` }),
    );
    expect(read['text']).toBe(`启动 ${NEW_WORD}。`);
  });
});
