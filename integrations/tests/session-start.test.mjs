/**
 * `SessionStart`：profile / 偏好 / 技能目录的注入（架构文档 §15.2）。
 *
 * 重点是技能目录的**三档 token 预算**：全放 → 只名字 → 一行计数。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    '/api/v1/content/read?comem://user/alice/memories/preferences/.overview.md': '偏好 TypeScript strict',
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
    '/api/v1/content/read?comem://user/alice/memories/preferences/.overview.md': '偏好 TypeScript',
    '/api/v1/skills': { skills: [] },
  });

  const result = await handleSessionStart(
    { sessionId: 'cc-1', cwd: '/repo', source: 'startup' },
    { config: { userId: 'alice', skillBudgetTokens: 1000, tmpDir: '/tmp' }, http, env: {} },
  );
  assert.doesNotMatch(result.context, /comem-profile/);
  assert.match(result.context, /comem-preferences/);
});

test('技能列表是 URI 数组时取最后一段当名字', async () => {
  const http = fakeHttp({
    '/api/v1/content/read?comem://user/alice/memories/profile.md': 'x',
    '/api/v1/content/read?comem://user/alice/memories/preferences/.overview.md': 'y',
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
