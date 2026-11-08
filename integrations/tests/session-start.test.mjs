/**
 * `SessionStart`：profile / 偏好 / 技能目录的注入（架构文档 §15.2）。
 *
 * 重点是技能目录的**三档 token 预算**：全放 → 只名字 → 一行计数。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ComemHookError } from '../lib/http.mjs';
import { fitContext, stripFrontmatter } from '../lib/injection.mjs';
import { estimateTokens, handleSessionStart, renderSkillCatalog } from '../servers/session-start.mjs';

const SKILLS = [
  { name: 'code-review', description: '审查改动并给出可执行的修改建议' },
  { name: 'release', description: '打标签、生成变更日志、发布' },
];

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async get(path, query) {
      calls.push({ path, query });
      const key = `${path}?${query?.uri ?? ''}`;
      const handler = routes[key] ?? routes[path];
      if (handler === undefined) {
        throw new Error(`404 ${key}`);
      }
      return handler;
    },
  };
}

test('预算放得下时列出名字 + 描述', () => {
  const catalog = renderSkillCatalog(SKILLS, 1000);
  assert.match(catalog, /<available-skills>/);
  assert.match(catalog, /- code-review: 审查改动/);
  assert.match(catalog, /- release: 打标签/);
});

test('放不下描述时只列名字', () => {
  // 详细列表约 40 token，名字列表约 15 token；预算取中间。
  const detailed = renderSkillCatalog(SKILLS, 1000);
  assert.ok(estimateTokens(detailed) > 20);
  const catalog = renderSkillCatalog(SKILLS, 20);
  assert.match(catalog, /- code-review\n- release\n/);
  assert.doesNotMatch(catalog, /审查改动/);
});

test('连名字都放不下时缩成一行计数', () => {
  const catalog = renderSkillCatalog(SKILLS, 1);
  assert.match(catalog, /^<available-skills>\n2 个技能可用（详细列表超出预算）\n<\/available-skills>$/);
});

test('没有技能时不输出空块', () => {
  assert.equal(renderSkillCatalog([], 1000), undefined);
});

test('注入 profile 与偏好（read 的结果可以是对象也可以是字符串）', async () => {
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': { text: '# alice\n后端工程师' },
    '/api/v1/content/overview?comem://user/alice/memories/preferences': {
      overview: '偏好 TypeScript strict',
    },
    '/api/v1/skills': { skills: SKILLS },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );

  assert.ok(result?.context);
  assert.match(result.context, /<comem-profile>\n# alice\n后端工程师\n<\/comem-profile>/);
  assert.match(result.context, /<comem-preferences>\n偏好 TypeScript strict\n<\/comem-preferences>/);
  assert.match(result.context, /<available-skills>\n- code-review: 审查改动/);
});

test('profile 不存在时跳过该块，其它照常注入', async () => {
  const http = fakeHttp({
    '/api/v1/content/overview?comem://user/alice/memories/preferences': {
      overview: '偏好 TypeScript',
    },
    '/api/v1/skills': { skills: [] },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );
  assert.doesNotMatch(result.context, /comem-profile/);
  assert.match(result.context, /comem-preferences/);
});

/**
 * 回归（P1）：偏好必须按**目录**读。
 *
 * 曾经的实现是 `content/read?uri=.../preferences/.overview.md`，而 `.overview.md`
 * 是保留名，`Uri.parse` 抛 `INVALID_URI`（HTTP 400），`.catch(() => null)` 把它吞成
 * 「没有偏好」——块从上线起就没注入过，文件却一直在盘上。这个用例钉住「发的是
 * `content/overview`，参数是目录 URI」。
 */
test('偏好走 content/overview + 目录 URI（不再拼保留名 .overview.md）', async () => {
  const http = fakeHttp({
    '/api/v1/content/overview?comem://user/alice/memories/preferences': {
      overview: '偏好 TypeScript strict',
    },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );

  assert.match(result.context, /<comem-preferences>/);
  assert.ok(
    http.calls.some(
      (call) =>
        call.path === '/api/v1/content/overview' &&
        call.query?.uri === 'comem://user/alice/memories/preferences',
    ),
  );
  assert.ok(http.calls.every((call) => !String(call.query?.uri ?? '').includes('.overview.md')));
});

test('偏好目录不存在（403 / 404）时静默跳过，不记 warn', async () => {
  const warnings = [];
  const http = {
    async get(path) {
      if (path === '/api/v1/content/read') {
        return { text: '# alice' };
      }
      if (path === '/api/v1/content/overview') {
        throw new ComemHookError('目录不存在', { code: 'HOOK_HTTP_ERROR', status: 404, path });
      }
      return { skills: [] };
    },
  };

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' },
      http,
      env: {},
      warn: (message, data) => warnings.push({ message, data }),
    },
  );

  assert.doesNotMatch(result.context, /comem-preferences/);
  assert.deepEqual(warnings, []);
});

test('读取偏好失败时记一条 warn，不静默', async () => {
  const warnings = [];
  const http = {
    async get(path) {
      if (path === '/api/v1/content/read') {
        return { text: '# alice' };
      }
      // 400 = INVALID_URI：配置或代码错误，绝不能当成「没有偏好」。
      throw new ComemHookError('URI 不合法', { code: 'HOOK_HTTP_ERROR', status: 400, path });
    },
  };

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' },
      http,
      env: {},
      warn: (message, data) => warnings.push({ message, data }),
    },
  );

  assert.doesNotMatch(result.context, /comem-preferences/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /comem-preferences/);
  assert.equal(warnings[0].data.status, 400);
  assert.equal(warnings[0].data.uri, 'comem://user/alice/memories/preferences');
});

test('技能列表是 URI 数组时取最后一段当名字', async () => {
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': 'x',
    '/api/v1/content/overview?comem://user/alice/memories/preferences': { overview: 'y' },
    '/api/v1/skills': { skills: ['comem://user/alice/skills/code-review'] },
  });
  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );
  assert.match(result.context, /- code-review/);
});

test('没有 userId 时不发请求（doctor 会报这一项）', async () => {
  const http = fakeHttp({});
  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: '', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );
  assert.equal(result, undefined);
  assert.equal(http.calls.length, 0);
});

test('bypass 会话时不注入（§8.9）', async () => {
  const http = fakeHttp({});
  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' },
      http,
      env: { COMEM_BYPASS_SESSION: '1' },
    },
  );
  assert.equal(result, undefined);
  assert.equal(http.calls.length, 0);
});

test('按路径 glob 关掉（§8.9 的 COMEM_BYPASS_SESSION_PATTERNS）', async () => {
  const http = fakeHttp({});
  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/home/alice/scratch/exp', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' },
      http,
      env: { COMEM_BYPASS_SESSION_PATTERNS: '*/scratch/*,*/tmp/*' },
    },
  );
  assert.equal(result, undefined);
  assert.equal(http.calls.length, 0);
});


/**
 * 注入预算（§15.2）：画像只注入正文、超预算按 head/tail 截断、宿主字节上限
 * 决定丢块顺序。
 *
 * 三条独立机制，任何一条被删掉都要有对应用例变红：
 * - 去掉 `stripFrontmatter` → 「注入不含 YAML frontmatter」红；
 * - 去掉 `elideToBudget` → 「超预算时截断」红；
 * - 把 CJK 换算改回 `chars / 4` → 「中文不低估」红。
 */
test('画像超预算时保留前 8 行 + 尾部，中间插带 URI 的省略标记', async () => {
  const line = (index) => `第 ${index} 行：用户在做网络仿真相关工作，主要使用 NS-3 模拟器。`;
  const lines = Array.from({ length: 200 }, (_, index) => line(index + 1));
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': { text: lines.join('\n') },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, profileBudgetTokens: 300, tmpDir: '/tmp' },
      http,
      env: {},
    },
  );

  const injected = result.context;
  assert.ok(injected.split('\n').length < 200, '行数必须少于原始 200 行');
  assert.match(injected, /已省略中间 \d+ 行/);
  assert.match(injected, /完整内容用 read 取回 comem:\/\/user\/alice\/memories\/profile\.md/);
  for (const kept of lines.slice(0, 8)) {
    assert.ok(injected.includes(kept), `前 8 行必须保留：${kept}`);
  }
  assert.ok(injected.includes(lines.at(-1)), '尾部最后一行必须保留');
  assert.ok(!injected.includes(line(100)), '中间的行必须被省略');
});

test('注入不含 YAML frontmatter（只注入正文）', async () => {
  const raw = [
    '---',
    'memory_type: profile',
    'status: active',
    'created_at: "2026-11-08T12:05:17.406Z"',
    'updated_at: "2026-11-08T12:13:20.760Z"',
    'uri: comem://user/alice/memories/profile.md',
    'summary: 用户在做网络仿真',
    'name: 用户',
    '---',
    '',
    '## content',
    '',
    '用户在做网络仿真相关工作。',
  ].join('\n');
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': { text: raw },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, profileBudgetTokens: 2000, tmpDir: '/tmp' },
      http,
      env: {},
    },
  );

  assert.doesNotMatch(result.context, /memory_type:/);
  assert.doesNotMatch(result.context, /created_at:/);
  assert.doesNotMatch(result.context, /^---$/m);
  assert.match(result.context, /^## content$/m);
  assert.match(result.context, /用户在做网络仿真相关工作。/);
});

test('中文按 CJK 密度估算 token，不低估', () => {
  // 1000 个汉字在 BPE 分词器里约 1000–1500 token；`chars / 4` 只有 250。
  assert.ok(estimateTokens('汉'.repeat(1000)) > 900);
  // 英文对照：4 字符/token。
  assert.equal(estimateTokens('a'.repeat(1000)), 250);
});

test('未超预算时原样注入（没有省略标记）', async () => {
  const body = '## content\n\n用户在做网络仿真相关工作。';
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': { text: body },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, profileBudgetTokens: 2000, tmpDir: '/tmp' },
      http,
      env: {},
    },
  );

  assert.match(result.context, /<comem-profile>\n## content\n\n用户在做网络仿真相关工作。\n<\/comem-profile>/);
  assert.doesNotMatch(result.context, /已省略/);
});

test('stripFrontmatter 只认第一行的 ---，正文里的水平线不动', () => {
  assert.equal(stripFrontmatter('---\na: 1\n---\n\n正文'), '正文');
  assert.equal(stripFrontmatter('正文\n---\n更多'), '正文\n---\n更多');
  // 没有闭合分隔符：半截 frontmatter 没有可解释的语义，整段当正文。
  assert.equal(stripFrontmatter('---\na: 1'), '---\na: 1');
});

test('超过宿主字节上限时先丢偏好、再丢技能目录，画像保留', async () => {
  const warnings = [];
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': { text: 'a'.repeat(4000) },
    '/api/v1/content/overview?comem://user/alice/memories/preferences': {
      overview: 'b'.repeat(4000),
    },
    '/api/v1/skills': { skills: SKILLS },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    {
      config: { userId: 'alice', skillBudgetTokens: 1000, profileBudgetTokens: 2000, tmpDir: '/tmp' },
      http,
      env: {},
      maxContextBytes: 1000,
      warn: (message, data) => warnings.push({ message, data }),
    },
  );

  assert.ok(Buffer.byteLength(result.context, 'utf8') <= 1000, '整段上下文必须放得下');
  assert.match(result.context, /<comem-profile>/);
  assert.match(result.context, /已(?:省略中间|截断)/);
  assert.doesNotMatch(result.context, /comem-preferences/);
  assert.doesNotMatch(result.context, /available-skills/);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].data.dropped, ['preferences', 'skills']);
});

test('fitContext 的丢块顺序：偏好 → 技能，画像永不丢', () => {
  const blocks = [
    { id: 'profile', text: 'p'.repeat(100) },
    { id: 'preferences', text: 'r'.repeat(100) },
    { id: 'skills', text: 's'.repeat(100) },
  ];

  assert.deepEqual(fitContext(blocks, 1000).dropped, []);
  assert.deepEqual(fitContext(blocks, 250).dropped, ['preferences']);
  const both = fitContext(blocks, 100);
  assert.deepEqual(both.dropped, ['preferences', 'skills']);
  assert.equal(both.context, 'p'.repeat(100));
});
