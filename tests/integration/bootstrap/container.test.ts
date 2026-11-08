import { readdirSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentVersion } from '../../../src/adapters/sqlite/database.js';
import {
  createContainer,
  llmBaseUrlIsPlaceholder,
  type Container,
} from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';


const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';
const PRINCIPALS = [SUBJECT, 'user:*'];

/**
 * 最新迁移版本。
 *
 * **不要写成字面量。** 每加一个迁移，写死的数字就会红一次——那不是回归，是测试在
 * 替我们数文件。这里扫目录，断言的是「容器启动时把迁移跑到了最新的那个版本」。
 */
const LATEST_SCHEMA_VERSION = Math.max(
  ...readdirSync(new URL('../../../src/adapters/sqlite/migrations', import.meta.url))
    .map((name) => /^(\d{4})_/.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number),
);

let dataDir: string;
let container: Container;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-container-'));
  container = await createContainer({
    // **配置从临时目录读，不是仓库根。**
    //
    // 缺省时 `loadConfig` 读 cwd 的 `config.yaml`——那是开发者本机的配置，
    // 可能指向真实远程网关。测试一旦读它就不再是孤立的：网络抖动、配额、
    // 甚至「今天没开代理」都会让测试红，而红的原因与代码无关。
    //
    // 临时目录里没有这个文件，所以走内置默认值。
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      // 写路径会投递摘要失效；用规则摘要，测试不碰模型。
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
});

afterEach(async () => {
  await container.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('createContainer', () => {
  it('每个服务都可实例化', () => {
    const { services } = container;
    for (const [name, service] of Object.entries(services)) {
      expect(service, `服务 ${name} 是 undefined`).toBeDefined();
    }
    // 少写一个键时上面的循环发现不了；这里钉住集合本身。
    expect(Object.keys(services).sort()).toEqual(
      [
        'acl',
        'assembler',
        'auth',
        'filesystem',
        'identity',
        'index',
        'indexObserver',
        'ledger',
        'memory',
        'prompts',
        'resource',
        'search',
        'session',
        'skill',
        'summary',
        'task',
        'taskStore',
      ].sort(),
    );
    expect(container.mcpRegistry.list()).toHaveLength(16);
    expect(container.routes.length).toBeGreaterThan(0);
    expect(container.observability).toBeDefined();
  });

  it('数据库迁移跑到最新版本，数据根与 `_meta` 已创建', async () => {
    expect(currentVersion(container.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(container.config.dataDir).toBe(dataDir);
    await expect(stat(join(dataDir, '_meta'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, '_meta', 'comem.sqlite'))).resolves.toBeDefined();
  });

  it('全新部署只读路径可用：四个上下文目录建好、权限行存在、列表是空的', async () => {
    // 不预置的后果不是「权限收得太紧」而是**全新部署下什么都看不见**：
    // `list` / `tree` / `GET /sessions` 都走 `filterReadable`，物化表里没有根行
    // 就一条都返回不了，而「空列表」和「没有权限」是两件事。
    const root = Uri.parse('comem://user/local');
    for (const name of ['memories', 'resources', 'skills', 'sessions']) {
      await expect(stat(join(dataDir, 'user', 'local', name))).resolves.toBeDefined();
    }

    const listed = await container.services.filesystem.list(root, PRINCIPALS);
    expect(listed.map((entry) => entry.uri.name).sort()).toEqual([
      'memories',
      'resources',
      'sessions',
      'skills',
    ]);

    // 会话页走的是 `filesystem.list(scope.child('sessions'), PRINCIPALS)`，不是 `SessionService`。
    const sessions = await container.services.filesystem.list(root.child('sessions'), PRINCIPALS);
    expect(sessions).toEqual([]);
  });

  it('close() 幂等', async () => {
    await container.close();
    await expect(container.close()).resolves.toBeUndefined();
  });

  it('写文件 → 索引能查到 → 权限行存在（端到端）', async () => {
    const { filesystem, acl, index } = container.services;
    const root = Uri.parse(ROOT);
    await acl.ensureRootPreset(root);

    const file = root.child('memories', 'preferences', 'code-style.md');
    await filesystem.write(file, '用户偏好 TypeScript 严格模式。', PRINCIPALS, {
      frontmatter: { summary: '偏好 TypeScript 严格模式' },
    });
    await container.services.indexObserver.drain();

    const hits = await index.search({
      text: 'TypeScript',
      scopes: [ROOT],
      principals: PRINCIPALS,
      limit: 10,
    });
    expect(hits.some((hit) => hit.uri === file.toString())).toBe(true);

    const rows = container.db
      .prepare('SELECT principal, level, effect FROM node_permission WHERE node_uri = ?')
      .all(file.toString());
    expect(rows).toEqual([{ principal: SUBJECT, level: 7, effect: 'allow' }]);
  });

  it('请求记录与指标都在容器里（request_log 可写）', async () => {
    await container.observability.recordRequest({
      requestId: 'req-container',
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 3,
      errorCode: null,
      subject: SUBJECT,
    });

    const row = container.db
      .prepare('SELECT request_id, path, status_code FROM request_log WHERE request_id = ?')
      .get('req-container');
    expect(row).toEqual({ request_id: 'req-container', path: '/health', status_code: 200 });
    expect(container.observability.renderMetrics()).toContain(
      'comem_http_request_duration_seconds_count',
    );
  });
});

/**
 * 回归（W59）：`providers.llm.default.baseUrl` 的默认值 `https://api.example.com/v1`
 * 是 IANA 保留域名（RFC 2606），永远不可达。把它当占位值留在默认配置里，等于
 * 「默认配置下摘要功能静默不工作」——写文件成功、HTTP 200，但摘要从来没有生成过。
 *
 * 选 B（保留默认值 + 启动告警）而不是删掉默认值：删掉会让 `providers.llm.default`
 * 变成必填，`loadConfig` 的「配置文件不存在时使用默认值」以及所有不配模型的
 * 测试、`config.example.yaml` 之外的单用户部署全部启动失败，代价大于这条告警。
 */
describe('providers.llm.default.baseUrl 占位值', () => {
  it('按主机名识别保留域名，不误伤真实域名', () => {
    expect(llmBaseUrlIsPlaceholder('https://api.example.com/v1')).toBe(true);
    expect(llmBaseUrlIsPlaceholder('http://api.example.com:8080/v1')).toBe(true);
    expect(llmBaseUrlIsPlaceholder('https://api.example.com.evil.test/v1')).toBe(false);
    expect(llmBaseUrlIsPlaceholder('http://127.0.0.1:3425/v1')).toBe(false);
    expect(llmBaseUrlIsPlaceholder('not a url')).toBe(false);
    expect(llmBaseUrlIsPlaceholder('')).toBe(false);
  });

  it('默认配置启动时打一条 warn，说明摘要等依赖模型的功能不会工作', async () => {
    const warnDir = await mkdtemp(join(tmpdir(), 'comem-container-warn-'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let created: Container | undefined;
    try {
      created = await createContainer({
        configPath: join(warnDir, 'config.yaml'),
        env: {
          ...process.env,
          COMEM_DATA_DIR: warnDir,
          COMEM_SUMMARY_GENERATOR: 'rule',
          COMEM_LOGGING_LEVEL: 'warn',
        },
      });

      // `mockRestore()` 会清空 `mock.calls`，所以断言在恢复之前做。
      const lines = writeSpy.mock.calls.map((call) => String(call[0]));
      const warning = lines.find((line) => line.includes('providers.llm.default.baseUrl 是占位值'));
      expect(warning).toBeDefined();
      expect(warning).toContain('api.example.com');
      expect(warning).toContain('"level":"warn"');
    } finally {
      writeSpy.mockRestore();
      await created?.close();
      await rm(warnDir, { recursive: true, force: true });
    }
  });

  it('换成真实 baseUrl 后不再告警', async () => {
    const quietDir = await mkdtemp(join(tmpdir(), 'comem-container-quiet-'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let created: Container | undefined;
    try {
      created = await createContainer({
        configPath: join(quietDir, 'config.yaml'),
        env: {
          ...process.env,
          COMEM_DATA_DIR: quietDir,
          COMEM_SUMMARY_GENERATOR: 'rule',
          COMEM_LOGGING_LEVEL: 'warn',
          COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:3425/v1',
        },
      });

      const lines = writeSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('providers.llm.default.baseUrl 是占位值'))).toBe(
        false,
      );
    } finally {
      writeSpy.mockRestore();
      await created?.close();
      await rm(quietDir, { recursive: true, force: true });
    }
  });
});
