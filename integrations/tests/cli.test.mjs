/**
 * `co-mem` 安装与自检（架构文档 §15.8）。
 *
 * 三个不变量：安装前备份、`uninstall` 只删我们加的条目、`doctor` 的四项检查各自
 * 能报失败并给出修法。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOOK_EVENTS, doctor, install, uninstall } from '../cli.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FOREIGN_HOOK = {
  hooks: [{ type: 'command', command: '/usr/local/bin/other-tool --flag' }],
};

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function startServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', result: { status: 'ok' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('install 写七个 hook（含 SessionEnd），并备份原 settings', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    const original = { hooks: { SessionStart: [FOREIGN_HOOK] }, other: { keep: true } };
    await writeFile(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = await install({ host: 'claude-code', settingsPath, root: ROOT });

    assert.equal(result.settingsPath, settingsPath);
    assert.equal(result.backupPath, `${settingsPath}.bak`);
    assert.deepEqual(result.events, Object.keys(HOOK_EVENTS));
    // 备份是原文件的内容，不是安装后的。
    assert.deepEqual(JSON.parse(await readFile(`${settingsPath}.bak`, 'utf8')), original);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    // 别人的 hook 一个不动。
    assert.deepEqual(settings.hooks.SessionStart[0], FOREIGN_HOOK);
    assert.deepEqual(settings.other, { keep: true });
    for (const event of Object.keys(HOOK_EVENTS)) {
      const groups = settings.hooks[event];
      assert.ok(Array.isArray(groups), event);
      const ours = groups.filter((group) =>
        group.hooks.some((hook) => hook.command.includes('integrations/servers')),
      );
      assert.equal(ours.length, 1, event);
      assert.match(ours[0].hooks[0].command, /--host claude-code$/);
    }
    // 只有 PreToolUse 带 matcher（少起进程）。
    assert.equal(settings.hooks.PreToolUse.at(-1).matcher, 'Read|Write|Edit');
    // SessionEnd 与 PreCompact 共用 pre-compact.mjs：两个生命周期点走同一条提交
    // 链路，只是预算不同（1200ms vs 30000ms）。
    assert.equal(
      settings.hooks.SessionEnd.at(-1).hooks[0].command,
      settings.hooks.PreCompact.at(-1).hooks[0].command,
    );
  });
});

test('install 幂等：重复安装不产生重复条目', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    await install({ host: 'claude-code', settingsPath, root: ROOT });
    await install({ host: 'claude-code', settingsPath, root: ROOT });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    for (const event of Object.keys(HOOK_EVENTS)) {
      assert.equal(settings.hooks[event].length, 1, event);
    }
  });
});

test('文件不存在时不写空备份', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    const result = await install({ host: 'claude-code', settingsPath, root: ROOT });
    assert.equal(result.backupPath, null);
  });
});

test('uninstall 只删自己的条目', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [FOREIGN_HOOK] }, other: 1 }, null, 2),
      'utf8',
    );
    await install({ host: 'claude-code', settingsPath, root: ROOT });

    const result = await uninstall({ host: 'claude-code', settingsPath });
    assert.equal(result.removed, Object.keys(HOOK_EVENTS).length);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks, { Stop: [FOREIGN_HOOK] });
    assert.equal(settings.other, 1);
  });
});

test('uninstall 之后 settings 里没有残留的 hooks 键', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    await install({ host: 'claude-code', settingsPath, root: ROOT });
    await uninstall({ host: 'claude-code', settingsPath });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal('hooks' in settings, false);
  });
});

test('install 保留 matcher group 里别人的条目', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    const mixed = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '/usr/local/bin/other-tool' },
              { type: 'command', command: 'node /repo/integrations/servers/pre-tool-use.mjs' },
            ],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(mixed, null, 2), 'utf8');

    await uninstall({ host: 'claude-code', settingsPath });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/other-tool' }] },
    ]);
  });
});

test('doctor 四项全部通过', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'userId: alice\n', 'utf8');

    const checks = await doctor({
      env: {
        COMEM_BASE_URL: server.baseUrl,
        COMEM_CONFIG_FILE: configFile,
        COMEM_HOOK_TMPDIR: dir,
      },
      root: ROOT,
    });

    assert.deepEqual(
      checks.map((check) => check.name),
      ['服务端可达', '配置文件', 'hook 脚本', '游标文件可写'],
    );
    assert.deepEqual(
      checks.map((check) => check.passed),
      [true, true, true, true],
    );
    for (const check of checks) {
      assert.ok(check.hint.length > 0, check.name);
    }
  });
  await server.close();
});

test('doctor 报服务端不可达，并给出修法', async () => {
  await withTempDir(async (dir) => {
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'userId: alice\n', 'utf8');
    const checks = await doctor({
      env: {
        COMEM_BASE_URL: 'http://127.0.0.1:1',
        COMEM_CONFIG_FILE: configFile,
        COMEM_HOOK_TMPDIR: dir,
      },
      root: ROOT,
    });
    const serverCheck = checks.find((check) => check.name === '服务端可达');
    assert.equal(serverCheck.passed, false);
    assert.match(serverCheck.hint, /启动服务端/);
  });
});

test('doctor 报配置文件缺 userId', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'baseUrl: http://127.0.0.1:1933\n', 'utf8');
    const checks = await doctor({
      env: { COMEM_BASE_URL: server.baseUrl, COMEM_CONFIG_FILE: configFile, COMEM_HOOK_TMPDIR: dir },
      root: ROOT,
    });
    const configCheck = checks.find((check) => check.name === '配置文件');
    assert.equal(configCheck.passed, false);
    assert.match(configCheck.hint, /userId/);
  });
  await server.close();
});

test('doctor 报 hook 脚本缺失', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'userId: alice\n', 'utf8');
    const checks = await doctor({
      env: { COMEM_BASE_URL: server.baseUrl, COMEM_CONFIG_FILE: configFile, COMEM_HOOK_TMPDIR: dir },
      root: dir,
    });
    const scripts = checks.find((check) => check.name === 'hook 脚本');
    assert.equal(scripts.passed, false);
    assert.match(scripts.hint, /重新运行 co-mem install/);
  });
  await server.close();
});

test('doctor 报游标文件损坏', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const configFile = join(dir, 'config.yaml');
    await writeFile(configFile, 'userId: alice\n', 'utf8');
    await writeFile(join(dir, 'comem-cursors.json'), '{broken', 'utf8');
    const checks = await doctor({
      env: { COMEM_BASE_URL: server.baseUrl, COMEM_CONFIG_FILE: configFile, COMEM_HOOK_TMPDIR: dir },
      root: ROOT,
    });
    const cursor = checks.find((check) => check.name === '游标文件可写');
    assert.equal(cursor.passed, false);
    assert.match(cursor.hint, /COMEM_HOOK_TMPDIR/);
  });
  await server.close();
});

test('install --host codex 写 hooks.json，PreToolUse matcher 覆盖 apply_patch', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'hooks.json');
    const result = await install({ host: 'codex', settingsPath, root: ROOT });

    assert.equal(result.settingsPath, settingsPath);
    assert.deepEqual(result.events, Object.keys(HOOK_EVENTS));

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    // Codex 的 hooks.json 顶层是 { hooks: { Event: [ {matcher, hooks:[...]} ] } }。
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command.endsWith('--host codex'), true);
    assert.match(settings.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.match(settings.hooks.PreToolUse[0].matcher, /Edit/);
    assert.match(settings.hooks.PreToolUse[0].matcher, /Write/);
  });
});

test('uninstall --host codex 只删 CoMem 条目，保留别人的 hook', async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'hooks.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { PostToolUse: [FOREIGN_HOOK] } }, null, 2),
      'utf8',
    );
    await install({ host: 'codex', settingsPath, root: ROOT });
    const result = await uninstall({ host: 'codex', settingsPath });
    assert.equal(result.removed, Object.keys(HOOK_EVENTS).length);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    // 别人的 PostToolUse 组还在。
    const commands = JSON.stringify(settings);
    assert.match(commands, /other-tool/);
    assert.doesNotMatch(commands, /integrations\/servers/);
  });
});

test('未知宿主报错并列出可用宿主', async () => {
  // 不传 settingsPath，让 settingsPathFor 走默认表并因未知宿主抛错。
  await assert.rejects(() => install({ host: 'cursor' }), (error) => {
    assert.match(error.message, /未知宿主/);
    // `dsh` 不在「可用宿主」里：它不是 settings 里的 hook，接入物是原生插件
    // （见下一个用例）。它不能出现在这里，否则用户会以为装得上。
    assert.doesNotMatch(error.message, /dsh/);
    return true;
  });
});

test('install --host dsh 在写第一个字节之前失败，并指向原生插件', async () => {
  // DSH 没有 settings 里的 hook 面：生命周期点是同进程 Cordis 插件订阅的 typed
  // 事件。install 不写任何 DSH 配置（给了 --settings 也不写），而是把用户指向
  // `integrations/dsh-plugin/`。
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, 'settings.json');
    await assert.rejects(
      () => install({ host: 'dsh', settingsPath, root: ROOT }),
      (error) => {
        // 正解：原生插件，不是「做不到」。
        assert.match(error.message, /原生插件/);
        assert.match(error.message, /integrations\/dsh-plugin\/README\.md/);
        assert.match(error.message, /dsh plugin --profile/);
        assert.match(error.message, /cordis\.patch\.yml/);
        return true;
      },
    );
    // 关键：没有「先写再报错」。给了 --settings 也不落盘。
    await assert.rejects(() => access(settingsPath), { code: 'ENOENT' });
  });
});

test('uninstall --host dsh 对称失败，不碰 home', async () => {
  await assert.rejects(() => uninstall({ host: 'dsh' }), /原生插件/);
});

test('CLI：--host 缺值时失败，不退回到默认宿主', () => {
  // `flag()` 在缺值（没有下一个 token、或以 `--` 开头）时返回 `undefined`，`install`
  // 于是退回 `claude-code`——`co-mem install --host` 会静默写进
  // `~/.claude/settings.json`，看着还成功了。这是同一类「落点静默错位」：忘记值比
  // 打错宿主更难发现。跑真入口，因为退回到默认宿主发生在 `main` 里。
  const result = spawnSync(process.execPath, [join(ROOT, 'cli.mjs'), 'install', '--host'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', '失败时 stdout 不能出现「已安装」');
  assert.match(result.stderr, /--host 缺值/);
});
