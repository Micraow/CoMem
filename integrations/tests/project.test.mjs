import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  normalizeExplicitProjectId,
  normalizeRemoteIdentity,
  projectIdFromGitRoot,
  projectIdFromRemoteIdentity,
  resolveProjectId,
  withProjectId,
} from '../lib/project.mjs';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { handleSessionStart } from '../servers/session-start.mjs';
import { handleUserPromptSubmit } from '../servers/user-prompt-submit.mjs';
import { handlePostToolUse } from '../servers/post-tool-use.mjs';
import { handlePreCompact } from '../servers/pre-compact.mjs';
import {
  captureSession,
  ensureSession,
  runCaptureWorker,
  writeWorkerPayload,
} from '../servers/stop.mjs';

const execFileAsync = promisify(execFile);
const VECTORS = JSON.parse(
  await readFile(new URL('./project-vectors.json', import.meta.url), 'utf8'),
);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function initRepository(path) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q');
  await git(path, 'config', 'user.email', 'fixture@example.invalid');
  await git(path, 'config', 'user.name', 'Fixture');
}

test('项目 ID 规则与 Hermes 共用同一组向量', () => {
  for (const vector of VECTORS.explicit) {
    assert.equal(normalizeExplicitProjectId(vector.input), vector.expected);
  }
  for (const vector of VECTORS.remote) {
    const identity = normalizeRemoteIdentity(vector.input);
    assert.equal(identity, vector.identity);
    assert.equal(projectIdFromRemoteIdentity(identity), vector.projectId);
  }
  for (const vector of VECTORS.root) {
    assert.equal(projectIdFromGitRoot(vector.path), vector.projectId);
  }
  assert.deepEqual(withProjectId(undefined), {});
  assert.deepEqual(withProjectId('team-alpha'), { projectId: 'team-alpha' });
});

test('SCP、HTTPS 与 SSH remote 归一，凭据和 query 不进入 ID', () => {
  const ids = VECTORS.remote.slice(0, 3).map((vector) => vector.projectId);
  assert.equal(new Set(ids).size, 1);
  assert.doesNotMatch(ids[0], /fixture-token|access_token|build-user/);
  const portId = projectIdFromRemoteIdentity(normalizeRemoteIdentity(VECTORS.remote[3].input));
  assert.notEqual(portId, ids[0]);
});

test('显式配置优先于 git，非法显式配置不回退到 git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-config-'));
  try {
    const repo = join(directory, 'repo');
    const nested = join(repo, 'src', 'feature');
    await initRepository(repo);
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/rocket.git');
    await mkdir(nested, { recursive: true });
    const remoteId = await resolveProjectId(repo);
    assert.equal(remoteId, VECTORS.remote[0].projectId);

    await mkdir(join(repo, 'src', '.comem'), { recursive: true });
    await writeFile(
      join(repo, 'src', '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: 'explicit-project' } }),
      'utf8',
    );
    assert.equal(await resolveProjectId(nested), 'explicit-project');

    await writeFile(
      join(repo, 'src', '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: '../escape' } }),
      'utf8',
    );
    await assert.rejects(
      () => resolveProjectId(nested),
      (error) => {
        assert.equal(error.code, 'PROJECT_CONFIG_INVALID');
        assert.match(error.message, /project\.id/);
        assert.doesNotMatch(error.message, /escape|\/src\/\.comem/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('同 origin 的 clone、worktree 与子目录一致；无 origin 使用 realpath 哈希', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-git-'));
  try {
    const repo = join(directory, 'repo');
    await initRepository(repo);
    await git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/Rocket.git');
    await git(repo, 'commit', '--allow-empty', '-m', 'fixture');
    const subdir = join(repo, 'nested', 'deeper');
    await mkdir(subdir, { recursive: true });
    const expected = VECTORS.remote[0].projectId;
    assert.equal(await resolveProjectId(repo), expected);
    assert.equal(await resolveProjectId(subdir), expected);

    const clone = join(directory, 'clone');
    const worktree = join(directory, 'worktree');
    await execFileAsync('git', ['clone', '-q', repo, clone]);
    await git(clone, 'remote', 'set-url', 'origin', 'ssh://git@github.com/acme/rocket.git');
    await git(repo, 'worktree', 'add', '-q', worktree, '-b', 'fixture-worktree');
    assert.equal(await resolveProjectId(clone), expected);
    assert.equal(await resolveProjectId(worktree), expected);

    const first = join(directory, 'first', 'same-name');
    const second = join(directory, 'second', 'same-name');
    await initRepository(first);
    await initRepository(second);
    const firstId = await resolveProjectId(first);
    const secondId = await resolveProjectId(second);
    assert.match(firstId, /^root-[0-9a-f]{16}$/);
    assert.match(secondId, /^root-[0-9a-f]{16}$/);
    assert.notEqual(firstId, secondId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('无 git 且无显式配置时没有项目，长 remote 标签仍不超过单段上限', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-none-'));
  try {
    assert.equal(await resolveProjectId(directory), undefined);
    const longRemote = normalizeRemoteIdentity(
      `https://example.com/owner/${'very-long-repository-name-'.repeat(20)}.git`,
    );
    const projectId = projectIdFromRemoteIdentity(longRemote);
    assert.ok(Buffer.byteLength(projectId, 'utf8') <= 255);
    assert.match(projectId, /^remote-example\.com-owner-/);
    assert.match(projectId, /-[0-9a-f]{16}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Node 的 context、ensure 与采集入口都发送解析后的 projectId', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-calls-'));
  try {
    await mkdir(join(directory, '.comem'), { recursive: true });
    await writeFile(
      join(directory, '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: 'integration-project' } }),
      'utf8',
    );
    const calls = [];
    const http = {
      async post(path, body) {
        calls.push({ path, body });
        if (path === '/api/v1/context') {
          return { rendered: 'project memory', deliveryToken: null };
        }
        if (path === '/api/v1/sessions') {
          const error = new Error('session exists');
          error.status = 409;
          error.serverCode = 'ALREADY_EXISTS';
          throw error;
        }
        return {};
      },
    };
    const deps = {
      config: { ...DEFAULT_CONFIG, tmpDir: directory },
      http,
      env: {},
      warn: () => {},
    };
    await handleSessionStart({
      event: 'session_start',
      sessionId: 'cc-session',
      cwd: directory,
      contextEpoch: 'epoch',
    }, deps);
    await handleUserPromptSubmit({
      event: 'user_prompt_submit',
      sessionId: 'cc-session',
      cwd: directory,
      contextEpoch: 'epoch',
      prompt: 'project question',
    }, deps);
    await ensureSession({ sessionId: 'cc-session', cwd: directory }, deps);
    await handlePostToolUse({
      event: 'post_tool_use',
      sessionId: 'cc-session',
      cwd: directory,
      toolName: 'Read',
      toolUseId: 'tool-1',
      toolInput: { file_path: 'README.md' },
      toolOutput: 'text',
    }, deps);
    await captureSession({
      event: 'stop',
      host: 'claude-code',
      sessionId: 'cc-session',
      cwd: directory,
      eventId: null,
      transcriptPath: null,
      messages: [{
        id: 'message-1',
        role: 'user',
        createdAt: '2026-11-17T00:00:00.000Z',
        parts: [{ kind: 'text', text: 'project question' }],
      }],
    }, deps);

    const contexts = calls.filter((call) => call.path === '/api/v1/context');
    const sessions = calls.filter((call) => call.path === '/api/v1/sessions');
    assert.equal(contexts.length, 2);
    assert.ok(contexts.every((call) => call.body.projectId === 'integration-project'));
    assert.equal(sessions.length, 3);
    assert.ok(sessions.every((call) => call.body.projectId === 'integration-project'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ensureSession 只吞 ALREADY_EXISTS，不吞项目绑定 CONFLICT', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-conflict-'));
  try {
    await mkdir(join(directory, '.comem'), { recursive: true });
    await writeFile(
      join(directory, '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: 'current-project' } }),
      'utf8',
    );
    const conflict = new Error('project conflict');
    conflict.status = 409;
    conflict.serverCode = 'CONFLICT';
    await assert.rejects(
      () => ensureSession(
        { sessionId: 'cc-conflict', cwd: directory },
        { config: DEFAULT_CONFIG, http: { post: async () => { throw conflict; } } },
      ),
      (error) => error === conflict,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('detached capture worker 把项目冲突写入可见诊断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-worker-conflict-'));
  try {
    await mkdir(join(directory, '.comem'), { recursive: true });
    await writeFile(
      join(directory, '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: 'current-project' } }),
      'utf8',
    );
    const payloadFile = await writeWorkerPayload(directory, {
      event: {
        event: 'stop',
        host: 'codex',
        sessionId: 'cx-conflict',
        cwd: directory,
        eventId: null,
        transcriptPath: null,
        messages: [{
          id: 'message-1',
          role: 'user',
          createdAt: '2026-11-17T00:00:00.000Z',
          parts: [{ kind: 'text', text: 'question' }],
        }],
      },
      processStartMs: 0,
    });
    const conflict = new Error('project conflict');
    conflict.status = 409;
    conflict.serverCode = 'CONFLICT';
    await assert.rejects(
      () => runCaptureWorker(payloadFile, {
        config: { ...DEFAULT_CONFIG, tmpDir: directory },
        http: { post: async () => { throw conflict; } },
        env: {},
      }),
      (error) => error === conflict,
    );
    const diagnostic = await readFile(join(directory, 'comem-capture.log'), 'utf8');
    assert.match(diagnostic, /"reason":"capture-failed"/);
    assert.match(diagnostic, /"serverCode":"CONFLICT"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('显式项目配置错误沿 Hook fail-open 路径传播且不创建或上报会话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comem-project-invalid-hooks-'));
  try {
    await mkdir(join(directory, '.comem'), { recursive: true });
    await writeFile(
      join(directory, '.comem', 'config.json'),
      JSON.stringify({ version: 1, project: { id: 'owner/repo' } }),
      'utf8',
    );
    const calls = [];
    const http = { post: async (path, body) => { calls.push({ path, body }); return; } };
    const deps = {
      config: { ...DEFAULT_CONFIG, tmpDir: directory },
      http,
      env: {},
      warn: () => {},
    };
    await assert.rejects(
      () => handleSessionStart({
        event: 'session_start',
        sessionId: 'cc-invalid',
        cwd: directory,
        contextEpoch: 'epoch',
      }, deps),
      { code: 'PROJECT_CONFIG_INVALID' },
    );
    assert.equal(await handleUserPromptSubmit({
      event: 'user_prompt_submit',
      sessionId: 'cc-invalid',
      cwd: directory,
      contextEpoch: 'epoch',
      prompt: 'question',
    }, deps), undefined);
    assert.equal(await handlePostToolUse({
      event: 'post_tool_use',
      sessionId: 'cc-invalid',
      cwd: directory,
      toolName: 'Read',
      toolUseId: 'tool-invalid',
      toolInput: { file_path: 'README.md' },
      toolOutput: 'text',
    }, deps), undefined);
    await assert.rejects(
      () => captureSession({
        event: 'stop',
        host: 'claude-code',
        sessionId: 'cc-invalid',
        cwd: directory,
        eventId: null,
        transcriptPath: null,
        messages: [{
          id: 'message-invalid',
          role: 'user',
          createdAt: '2026-11-17T00:00:00.000Z',
          parts: [{ kind: 'text', text: 'question' }],
        }],
      }, deps),
      { code: 'PROJECT_CONFIG_INVALID' },
    );
    await handlePreCompact({
      event: 'pre_compact',
      sessionId: 'cc-invalid-other',
      cwd: directory,
      eventId: null,
      transcriptPath: null,
      messages: [{
        id: 'message-invalid-precompact',
        role: 'user',
        createdAt: '2026-11-17T00:00:00.000Z',
        parts: [{ kind: 'text', text: 'question' }],
      }],
    }, deps);
    assert.equal(
      calls.some((call) => call.path.startsWith('/api/v1/sessions')),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
